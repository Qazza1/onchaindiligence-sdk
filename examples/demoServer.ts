/**
 * demoServer.ts — an in-process stand-in for onchaindiligence-mcp's D2.4
 * HTTP surface, used ONLY by examples/quickstart.ts so that file completes
 * the ENTIRE lifecycle offline, deterministically, and for free. This is
 * NOT a mock of "the OCD product" in any normative sense — it exists
 * purely so the quickstart is runnable as documentation without a funded
 * wallet or a live x402 payment. See test/fakeServer.mjs for the same
 * technique used by the SDK's own test suite.
 *
 * To point the quickstart at the REAL server instead, delete the `fetch:
 * demoFetch` line in quickstart.ts (the client defaults to
 * https://mcp.onchaindiligence.com) and swap MockCommerceExecutor for
 * X402BaseUsdcExecutor with a real funded viem Account — preflight will
 * then be a real $0.01 x402 payment.
 */
import { randomBytes, createHash } from 'node:crypto'

function randomId(prefix: string): string {
  return prefix + randomBytes(16).toString('base64url')
}
function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function hashCredential(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

interface OpState {
  recoveryCredentialHash: string
  preflightReceiptId: string | null
}

export function createDemoFetch(): typeof fetch {
  const operations = new Map<string, OpState>()
  const preflightSteps = new Map<string, { inputDigest: string; result: any }>()
  const capabilities = new Map<string, { operationId: string; preflightReceiptId: string; used: boolean }>()
  const receipts = new Map<string, any>()

  function fakeReceipt(receiptType: string, action: any, decision: any, execution: any, settlement: any, links: any) {
    const id = randomId('OCD-RCP-')
    return {
      schema: 'onchaindiligence.public-action-receipt.v1',
      receipt: {
        receipt_id: id,
        receipt_digest: 'sha256:' + digestOf({ id, action }).slice(0, 32),
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
      proof: { signed: true, key_id: 'ed25519-DEMOKEYFOREXAMPLE0', algorithm: 'ed25519', signature: 'demo-only-not-a-real-signature' },
    }
  }

  return (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(typeof url === 'string' ? url : url instanceof URL ? url : url.url)
    const path = u.pathname
    const method = (init.method || 'GET').toUpperCase()
    const headers = new Headers(init.headers || {})
    const bodyJson = init.body ? JSON.parse(init.body as string) : null
    const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

    if (path === '/operations' && method === 'POST') {
      const operationId = randomId('OCD-OP-')
      const recoveryCredential = randomBytes(24).toString('base64url')
      operations.set(operationId, { recoveryCredentialHash: hashCredential(recoveryCredential), preflightReceiptId: null })
      return json({ operation_id: operationId, recovery_credential: recoveryCredential }, 201)
    }
    const opMatch = path.match(/^\/operations\/([^/]+)$/)
    if (opMatch && method === 'GET') {
      const op = operations.get(opMatch[1])
      const cred = headers.get('x-ocd-recovery-credential')
      if (!op || !cred || hashCredential(cred) !== op.recoveryCredentialHash) return json({ error: 'unauthorized' }, 401)
      return json({ operation_id: opMatch[1], preflight_state: 'completed', execution_state: 'not_submitted', observation_state: 'none', receipt_state: 'none', preflight_receipt_id: op.preflightReceiptId })
    }
    if (path === '/x402/lifecycle/preflight-payment' && method === 'POST') {
      const operationId = headers.get('x-ocd-operation-id')!
      const op = operations.get(operationId)
      if (!op) return json({ error: 'unauthorized' }, 401)
      const inputDigest = digestOf(bodyJson)
      const existing = preflightSteps.get(operationId)
      if (existing?.inputDigest === inputDigest) return json(existing.result, 200)

      const { action, policy } = bodyJson
      const decision =
        policy.max_amount && Number(action.amount) > Number(policy.max_amount)
          ? { status: 'BLOCK', authorized: false, reasons: ['amount exceeds max_amount'] }
          : { status: 'ALLOW', authorized: true, reasons: ['All configured policy checks passed.'] }
      const receipt = fakeReceipt('PREFLIGHT', action, decision, { provider: null, status: 'NOT_SUBMITTED', transaction_hash: null, submitted_at: null, confirmed_at: null }, { status: 'NOT_APPLICABLE', detail: null }, { agent_evidence_bundle_digest: null, preflight_receipt_id: null })
      receipts.set(receipt.receipt.receipt_id, receipt)
      const capabilityToken = randomBytes(24).toString('base64url')
      capabilities.set(capabilityToken, { operationId, preflightReceiptId: receipt.receipt.receipt_id, used: false })
      const result = { decision, checks: [], receipt, finalization: { capability: capabilityToken, expires_at: new Date(Date.now() + 86400000).toISOString(), endpoint: 'demo://finalize' } }
      preflightSteps.set(operationId, { inputDigest, result })
      op.preflightReceiptId = receipt.receipt.receipt_id
      return json(result, 200)
    }
    const bindingsMatch = path.match(/^\/operations\/([^/]+)\/execution-bindings$/)
    if (bindingsMatch && method === 'POST') {
      return json({ execution_request_id: randomId('OCD-EXEC-'), submission_state: 'not_submitted', idempotent_replay: false }, 201)
    }
    if (path.match(/^\/operations\/[^/]+\/execution-bindings\/[^/]+\/state$/) && method === 'POST') {
      return json({ ok: true })
    }
    const finalizeMatch = path.match(/^\/operations\/([^/]+)\/finalize$/)
    if (finalizeMatch && method === 'POST') {
      const auth = headers.get('authorization') || ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
      const cap = token ? capabilities.get(token) : null
      if (!cap) return json({ error: 'invalid finalization capability' }, 401)
      const preflightReceipt = receipts.get(cap.preflightReceiptId)
      const commerceReceipt = fakeReceipt(
        'COMMERCE',
        preflightReceipt.receipt.action,
        preflightReceipt.receipt.decision,
        { provider: bodyJson.execution_provider, status: 'CONFIRMED', transaction_hash: bodyJson.transaction_hash, submitted_at: null, confirmed_at: new Date().toISOString() },
        { status: 'CONFIRMED', detail: 'demo settlement' },
        { agent_evidence_bundle_digest: 'sha256:demobundle', preflight_receipt_id: cap.preflightReceiptId }
      )
      cap.used = true
      return json({ ...commerceReceipt, ocd_lifecycle_evidence: { bundle_digest: 'sha256:demobundle', binding_strength: 'EXECUTOR_CORRELATED' } }, 200)
    }
    const receiptMatch = path.match(/^\/receipts\/([^/]+)$/)
    if (receiptMatch && method === 'GET') {
      const r = receipts.get(receiptMatch[1])
      return r ? json(r, 200) : json({ error: 'not found' }, 404)
    }
    if (path === '/verify-receipt' && method === 'POST') {
      return json({ state: 'VALID', code: 'ok', message: 'demo server: not a real signature check' })
    }
    return json({ error: `no demo route for ${method} ${path}` }, 404)
  }) as typeof fetch
}
