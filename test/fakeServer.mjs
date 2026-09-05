/**
 * fakeServer.mjs — a minimal, in-memory stand-in for onchaindiligence-mcp's
 * D2.4 HTTP surface, used ONLY to test the SDK's commerce client
 * orchestration logic offline. It reproduces the CONTRACT (status codes,
 * idempotency-by-input-digest, header requirements, response shapes) but
 * does not sign anything for real -- receipts here are shape-correct fakes,
 * never cryptographically valid. No network, no real server, no payment.
 */
import { randomBytes, createHash } from 'node:crypto'

function randomId(prefix) {
  return prefix + randomBytes(16).toString('base64url')
}

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function fakeReceipt(receiptType, action, decision, execution, settlement, links = { agent_evidence_bundle_digest: null, preflight_receipt_id: null }) {
  const id = randomId('OCD-RCP-')
  return {
    schema: 'onchaindiligence.public-action-receipt.v1',
    receipt: {
      receipt_id: id,
      receipt_digest: 'sha256:' + digestOf({ id, action, decision }).slice(0, 32),
      receipt_type: receiptType,
      issued_at: new Date().toISOString(),
      action,
      decision,
      execution,
      settlement,
      checks: [],
      links,
      limitations: [],
    },
    proof: { signed: true, key_id: 'ed25519-FAKEKEYFORTESTS0', algorithm: 'ed25519', signature: 'fake' },
  }
}

export function createFakeServer(options = {}) {
  const operations = new Map() // operationId -> { recoveryCredentialHash, preflightState, ... }
  const preflightSteps = new Map() // operationId -> { inputDigest, status, result }
  const capabilities = new Map() // token -> { operationId, preflightReceiptId, used }
  const executionBindings = new Map() // executionRequestId -> {...}
  const receipts = new Map() // receiptId -> envelope

  let preflightAttempts = 0
  let executeSubmitAttempts = 0

  function hashCredential(raw) {
    return createHash('sha256').update(raw).digest('hex')
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(url)
    const path = u.pathname
    const method = (init.method || 'GET').toUpperCase()
    const headers = new Headers(init.headers || {})
    const bodyJson = init.body ? JSON.parse(init.body) : null

    const json = (obj, status = 200, extraHeaders = {}) =>
      new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extraHeaders } })

    if (path === '/operations' && method === 'POST') {
      const operationId = randomId('OCD-OP-')
      const recoveryCredential = randomBytes(24).toString('base64url')
      operations.set(operationId, {
        recoveryCredentialHash: hashCredential(recoveryCredential),
        preflightState: 'not_started',
        executionState: 'not_submitted',
        observationState: 'none',
        receiptState: 'none',
        preflightReceiptId: null,
      })
      return json({ operation_id: operationId, recovery_credential: recoveryCredential }, 201)
    }

    const opMatch = path.match(/^\/operations\/([^/]+)$/)
    if (opMatch && method === 'GET') {
      const op = operations.get(opMatch[1])
      const cred = headers.get('x-ocd-recovery-credential')
      if (!op || !cred || hashCredential(cred) !== op.recoveryCredentialHash) return json({ error: 'unknown operation or invalid recovery credential' }, 401)
      return json({
        operation_id: opMatch[1],
        preflight_state: op.preflightState,
        execution_state: op.executionState,
        observation_state: op.observationState,
        receipt_state: op.receiptState,
        preflight_receipt_id: op.preflightReceiptId,
      })
    }

    if (path === '/x402/lifecycle/preflight-payment' && method === 'POST') {
      preflightAttempts++
      const operationId = headers.get('x-ocd-operation-id')
      const cred = headers.get('x-ocd-recovery-credential')
      const op = operations.get(operationId)
      if (!op || !cred || hashCredential(cred) !== op.recoveryCredentialHash) return json({ error: 'unknown operation or invalid recovery credential' }, 401)

      const inputDigest = digestOf(bodyJson)
      const existing = preflightSteps.get(operationId)
      if (existing) {
        if (existing.inputDigest !== inputDigest) return json({ error: 'operation step conflict' }, 409)
        if (existing.status === 'completed') return json(existing.result, 200)
        return json({ error: 'in progress' }, 425, { 'retry-after': '2' })
      }

      if (options.simulateAmbiguousPreflightOnce && !options._ambiguousPreflightUsed) {
        options._ambiguousPreflightUsed = true
        preflightSteps.set(operationId, { inputDigest, status: 'claimed' })
        return json({ error: 'processing' }, 425, { 'retry-after': '1' })
      }

      const { action, policy } = bodyJson
      let decision
      if (policy.max_amount && Number(action.amount) > Number(policy.max_amount)) {
        decision = { status: 'BLOCK', authorized: false, reasons: ['amount exceeds max_amount'] }
      } else if (options.forceRequireApproval) {
        decision = { status: 'REQUIRE_APPROVAL', authorized: false, reasons: ['forced by test'] }
      } else {
        decision = { status: 'ALLOW', authorized: true, reasons: ['All configured policy checks passed.'] }
      }
      const receipt = fakeReceipt(
        'PREFLIGHT',
        action,
        decision,
        { provider: null, status: 'NOT_SUBMITTED', transaction_hash: null, submitted_at: null, confirmed_at: null },
        { status: 'NOT_APPLICABLE', detail: null }
      )
      receipts.set(receipt.receipt.receipt_id, receipt)
      const capabilityToken = randomBytes(24).toString('base64url')
      capabilities.set(capabilityToken, { operationId, preflightReceiptId: receipt.receipt.receipt_id, used: false })
      const result = {
        decision,
        checks: [],
        receipt,
        finalization: { capability: capabilityToken, expires_at: new Date(Date.now() + 86400000).toISOString(), endpoint: 'https://fake/receipts/finalize' },
      }
      preflightSteps.set(operationId, { inputDigest, status: 'completed', result })
      op.preflightState = 'completed'
      op.preflightReceiptId = receipt.receipt.receipt_id
      return json(result, 200)
    }

    const bindingsMatch = path.match(/^\/operations\/([^/]+)\/execution-bindings$/)
    if (bindingsMatch && method === 'POST') {
      const operationId = bindingsMatch[1]
      const op = operations.get(operationId)
      const cred = headers.get('x-ocd-recovery-credential')
      if (!op || !cred || hashCredential(cred) !== op.recoveryCredentialHash) return json({ error: 'unknown operation or invalid recovery credential' }, 401)
      const key = `${operationId}\0${bodyJson.client_submission_key}`
      let binding = executionBindings.get(key)
      let created = false
      if (!binding) {
        binding = { executionRequestId: randomId('OCD-EXEC-'), submissionState: 'not_submitted' }
        executionBindings.set(key, binding)
        executionBindings.set(binding.executionRequestId, binding)
        created = true
      }
      op.executionState = 'prepared'
      return json({ execution_request_id: binding.executionRequestId, submission_state: binding.submissionState, idempotent_replay: !created }, created ? 201 : 200)
    }

    const stateMatch = path.match(/^\/operations\/([^/]+)\/execution-bindings\/([^/]+)\/state$/)
    if (stateMatch && method === 'POST') {
      const [, operationId, executionRequestId] = stateMatch
      const binding = executionBindings.get(executionRequestId)
      if (!binding) return json({ error: 'unknown binding' }, 404)
      binding.submissionState = bodyJson.state
      const op = operations.get(operationId)
      if (op) op.executionState = bodyJson.state
      return json({ execution_request_id: executionRequestId, submission_state: bodyJson.state })
    }

    const finalizeMatch = path.match(/^\/operations\/([^/]+)\/finalize$/)
    if (finalizeMatch && method === 'POST') {
      executeSubmitAttempts++
      const operationId = finalizeMatch[1]
      const auth = headers.get('authorization') || ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
      const cap = token ? capabilities.get(token) : null
      if (!cap || cap.operationId !== operationId) return json({ error: 'invalid finalization capability' }, 401)
      if (cap.used) return json(receipts.get(cap.commerceReceiptId), 200)

      if (options.simulateFinalizePendingOnce && !options._finalizePendingUsed) {
        options._finalizePendingUsed = true
        return json({ error: 'pending', reason: 'insufficient-confirmations' }, 425, { 'retry-after': '2' })
      }

      const preflightReceipt = receipts.get(cap.preflightReceiptId)
      const commerceReceipt = fakeReceipt(
        'COMMERCE',
        { ...preflightReceipt.receipt.action },
        preflightReceipt.receipt.decision,
        { provider: bodyJson.execution_provider, status: 'CONFIRMED', transaction_hash: bodyJson.transaction_hash, submitted_at: null, confirmed_at: new Date().toISOString() },
        { status: 'CONFIRMED', detail: 'fake settlement' },
        { agent_evidence_bundle_digest: 'sha256:fakebundle', preflight_receipt_id: cap.preflightReceiptId }
      )
      receipts.set(commerceReceipt.receipt.receipt_id, commerceReceipt)
      cap.used = true
      cap.commerceReceiptId = commerceReceipt.receipt.receipt_id
      const op = operations.get(operationId)
      if (op) {
        op.observationState = 'confirmed'
        op.receiptState = 'commerce_issued'
      }
      return json({ ...commerceReceipt, ocd_lifecycle_evidence: { bundle_digest: 'sha256:fakebundle', binding_strength: 'EXECUTOR_CORRELATED' } }, 200)
    }

    const receiptMatch = path.match(/^\/receipts\/([^/]+)$/)
    if (receiptMatch && method === 'GET') {
      const receipt = receipts.get(receiptMatch[1])
      return receipt ? json(receipt, 200) : json({ error: 'not found' }, 404)
    }

    if (path === '/verify-receipt' && method === 'POST') {
      return json({ state: 'VALID', code: 'ok', message: 'fake verification' })
    }

    return json({ error: `no fake route for ${method} ${path}` }, 404)
  }

  return {
    fetch: fetchImpl,
    stats: () => ({ preflightAttempts, executeSubmitAttempts }),
  }
}
