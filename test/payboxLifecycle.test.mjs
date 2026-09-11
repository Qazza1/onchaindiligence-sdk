/** D2.6: full orchestrator-level tests for PayBoxCommerceExecutor --
 * open -> preflight -> execute -> observe/finalize through
 * createCommerceClient, proving OCD and PayBox stay independent (Section 6)
 * and that PayBox's own request/poll model is respected end-to-end
 * (Section 4/10's numbered test matrix).
 *
 * Fully offline: fakeServer.mjs stands in for onchaindiligence-mcp's D2.4
 * HTTP surface; FakePayBoxClient stands in for PayBox. No real network, no
 * real PayBox account, no real money.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCommerceClient,
  InMemoryRecoveryStore,
  PayBoxCommerceExecutor,
  InMemoryPayBoxRequestStore,
  PayBoxStoreRequiredError,
  PayBoxAmbiguousPrepareError,
  PreflightNotAllowedError,
  MockCommerceExecutor,
  PAYBOX_BASE_NETWORK,
  PAYBOX_BASE_USDC,
} from '../dist/commerce/index.js'
import { createFakeServer } from './fakeServer.mjs'
import { FakePayBoxClient } from './fakePayboxClient.mjs'
import { FakeBaseLogClient } from './fakeBaseLogClient.mjs'

const RECIPIENT = '0x000000000000000000000000000000000000dEaD'
const RESOURCE_URL = 'https://service.example/api'
const CREDENTIAL_ID = 'cred_test_wallet_1'

const ACTION = { kind: 'PAYMENT', resource: RESOURCE_URL, network: PAYBOX_BASE_NETWORK, asset: PAYBOX_BASE_USDC, amount: '1.00', sender: null, recipient: RECIPIENT }
const POLICY = { max_amount: '5.00', allowed_networks: null, allowed_assets: null, expected_recipient: null, allowed_resource_origins: null }

function base64utf8(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}
function validChallenge() {
  return { x402Version: 2, accepts: [{ scheme: 'exact', network: PAYBOX_BASE_NETWORK, asset: PAYBOX_BASE_USDC, payTo: RECIPIENT, amount: '1000000', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }] }
}
function merchantFetch(fakeTxHash) {
  return async (url, init) => {
    const req = url instanceof Request ? url : new Request(url, init)
    if (req.headers.get('x-payment')) {
      return new Response('{}', { status: 200, headers: { 'x-payment-response': base64utf8({ transaction: fakeTxHash }) } })
    }
    return new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  }
}

test('test matrix #1: OCD BLOCK never invokes PayBox pay_x402, enforced by CommerceOperation itself, not caller discipline', async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: ACTION, policy: { ...POLICY, max_amount: '0.01' } }) // 1.00 > 0.01 -> BLOCK
  const evaluation = await op.preflight()
  assert.equal(evaluation.kind, 'blocked')

  const paybox = new FakePayBoxClient()
  // D2.6 review fix #1: deliberately call execute() anyway, WITHOUT checking
  // evaluation.kind first -- CommerceOperation's own fail-closed gate, not
  // caller discipline, must be what stops PayBox from ever being reached.
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: merchantFetch('0x' + '00'.repeat(32)) })
  await assert.rejects(() => op.execute({ executor }), PreflightNotAllowedError)
  assert.equal(paybox.payX402Calls.length, 0, 'a BLOCKed evaluation must never lead to PayBox being called')
})

test('test matrix #2: OCD REQUIRE_APPROVAL does not bypass PayBox, enforced by CommerceOperation itself even if execute() is called anyway', async () => {
  const server = createFakeServer({ forceRequireApproval: true })
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: ACTION, policy: POLICY })
  const evaluation = await op.preflight()
  assert.equal(evaluation.kind, 'approval-required')

  const paybox = new FakePayBoxClient()
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: merchantFetch('0x' + '01'.repeat(32)) })
  await assert.rejects(() => op.execute({ executor }), PreflightNotAllowedError)
  assert.equal(paybox.payX402Calls.length, 0, 'a REQUIRE_APPROVAL evaluation must never lead to PayBox being called')
})

test('test matrix #3: PayBox DENIED produces no merchant payment and no receipt', async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  let merchantCalls = 0
  const paybox = new FakePayBoxClient()
  paybox.onPayX402 = () => {
    const id = 'paybox-req-denied'
    paybox.requests.set(id, { request_id: id, status: 'denied', reason: 'transaction blocked by spending policy' })
    return { request_id: id, status: 'denied', reason: 'transaction blocked by spending policy' }
  }
  const fetchImpl = async (url, init) => {
    merchantCalls++
    return merchantFetch('0x' + 'ff'.repeat(32))(url, init)
  }
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: fetchImpl })
  const execution = await op.execute({ executor })
  assert.equal(execution.kind, 'manual-recovery-required')
  assert.match(execution.reason, /denied/)

  merchantCalls = 0 // reset after prepare()'s own read-only probe
  assert.equal(merchantCalls, 0)

  const finalize = await op.observeAndFinalize()
  assert.equal(finalize.kind, 'pending', 'no transaction hash exists -- observeAndFinalize() must not fabricate a receipt')
})

test('test matrix #4/#5: a PENDING PayBox request is polled and resumed, never recreated, across multiple op.execute() calls', async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  const paybox = new FakePayBoxClient()
  paybox.onPayX402 = (input, c) => {
    const id = 'paybox-req-pending'
    c.requests.set(id, { request_id: id, status: 'pending_approval' })
    return { request_id: id, status: 'pending_approval' }
  }
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: merchantFetch('0x' + 'aa'.repeat(32)) })

  const first = await op.execute({ executor })
  assert.equal(first.kind, 'pending')
  assert.equal(first.phase, 'execution-ambiguous')
  assert.equal(paybox.payX402Calls.length, 1)

  const second = await op.execute({ executor })
  assert.equal(second.kind, 'pending', 'still pending_approval -- must stay pending, not fail or fabricate success')
  assert.equal(paybox.payX402Calls.length, 1, 'op.execute() retried must call PayBox get_request, never pay_x402 again')
  assert.ok(paybox.getRequestCalls.length >= 1)

  paybox.requests.set('paybox-req-pending', { request_id: 'paybox-req-pending', status: 'success', output: { value: { x_payment: { header: 'X-PAYMENT', value: 'signed' } } } })
  const third = await op.execute({ executor })
  assert.equal(third.kind, 'execution-recorded')
  assert.equal(paybox.payX402Calls.length, 1, 'never more than one PayBox request for this operation')

  const finalize = await op.observeAndFinalize()
  assert.equal(finalize.kind, 'receipt-produced')
  assert.equal(finalize.receipt.receipt.execution.transaction_hash, third.transactionHash)
})

test('test matrix #7/#12: the PayBox request id is durably preserved and correlated into the execution binding as provider_reference', async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  const paybox = new FakePayBoxClient()
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: merchantFetch('0x' + 'bb'.repeat(32)) })
  const execution = await op.execute({ executor })
  assert.equal(execution.kind, 'execution-recorded')

  const binding = server.getExecutionBinding(execution.executionRequestId)
  assert.ok(binding, 'execution binding must exist')
  assert.equal(paybox.payX402Calls.length, 1)
  const [payboxRequestId] = [...paybox.requests.keys()]
  assert.equal(binding.providerReference, `paybox:${payboxRequestId}`)
})

test('test matrix #6/#10: client restart resumes from durable state without recreating the PayBox request', async () => {
  const server = createFakeServer()
  const recoveryStore = new InMemoryRecoveryStore()
  const payboxStore = new InMemoryPayBoxRequestStore()
  const paybox = new FakePayBoxClient()
  paybox.onPayX402 = (input, c) => {
    const id = 'paybox-req-restart'
    c.requests.set(id, { request_id: id, status: 'pending_approval' })
    return { request_id: id, status: 'pending_approval' }
  }

  const client = createCommerceClient({ recovery: recoveryStore, fetch: server.fetch })
  const op = await client.open({ action: ACTION, policy: POLICY })
  const savedOperationId = op.operationId
  const savedRecord = await recoveryStore.load(savedOperationId)
  assert.equal((await op.preflight()).kind, 'ready')

  const executor1 = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: payboxStore, fetch: merchantFetch('0x' + 'cc'.repeat(32)) })
  const first = await op.execute({ executor: executor1 })
  assert.equal(first.kind, 'pending')
  assert.equal(paybox.payX402Calls.length, 1)

  // Simulate a full process restart: brand-new client + operation + executor
  // instances, sharing only the durable stores. Per RecoveryRequiredError's
  // own guidance, a restarted process re-supplies the original action/policy
  // via client.open({operationId, action, policy}) rather than load().
  const client2 = createCommerceClient({ recovery: recoveryStore, fetch: server.fetch })
  const resumeResult = await client2.resume(savedOperationId, savedRecord.recoveryCredential)
  assert.equal(resumeResult.kind, 'resumed')
  const resumedOp = await client2.open({ operationId: savedOperationId, action: ACTION, policy: POLICY })

  paybox.requests.set('paybox-req-restart', { request_id: 'paybox-req-restart', status: 'success', output: { value: { x_payment: { header: 'X-PAYMENT', value: 'signed' } } } })
  const executor2 = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: payboxStore, fetch: merchantFetch('0x' + 'cc'.repeat(32)) })
  const resumedExecution = await resumedOp.execute({ executor: executor2 })
  assert.equal(resumedExecution.kind, 'execution-recorded')
  assert.equal(paybox.payX402Calls.length, 1, 'restart must resume the SAME PayBox request, never create a second one')
})

test('test matrix #13: no PayBox credential id enters the evidence export', async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  const paybox = new FakePayBoxClient()
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: merchantFetch('0x' + 'dd'.repeat(32)) })
  await op.execute({ executor })
  await op.observeAndFinalize()

  const manifest = await op.exportEvidence()
  assert.doesNotMatch(JSON.stringify(manifest), new RegExp(CREDENTIAL_ID))
})

test('test matrix #9: a terminal PayBox error stays a separate concept from OCD settlement -- terminal per docs.paybox.sh, never modeled as later resolving to success', async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  let merchantCalls = 0
  const paybox = new FakePayBoxClient()
  paybox.onPayX402 = (input, c) => {
    const id = 'paybox-req-error'
    c.requests.set(id, { request_id: id, status: 'error', message: 'internal signer timeout' })
    return { request_id: id, status: 'error', message: 'internal signer timeout' }
  }
  const fetchImpl = async (url, init) => {
    merchantCalls++
    return merchantFetch('0x' + 'ee'.repeat(32))(url, init)
  }
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: fetchImpl })
  const execution = await op.execute({ executor })
  // docs.paybox.sh/concepts/requests lists 'error' under "Terminal (polling
  // stops)" -- this must be a definitive OCD outcome (manual-recovery-required),
  // never the retryable 'pending'/execution-ambiguous state, and it must never
  // be surfaced as if it were an OCD settlement fact (execution/settlement
  // remain untouched -- no receipt exists at all).
  assert.equal(execution.kind, 'manual-recovery-required')
  assert.match(execution.reason, /terminal error/)
  assert.equal(paybox.payX402Calls.length, 1)

  merchantCalls = 0 // reset after prepare()'s own read-only probe
  assert.equal(merchantCalls, 0, 'a PayBox error must never reach the merchant')

  // Retrying execute() again must not resubmit to PayBox, and must not
  // "recover" into success -- a terminal error stays terminal.
  const retried = await op.execute({ executor })
  assert.equal(retried.kind, 'manual-recovery-required')
  assert.equal(paybox.payX402Calls.length, 1, 'a terminal PayBox error must never be retried into a new pay_x402 call')

  const finalize = await op.observeAndFinalize()
  assert.equal(finalize.kind, 'pending', 'no transaction hash exists -- OCD settlement must never be inferred from a PayBox-side error')
})

test('a terminal PayBox success with no readable x_payment output stops safely instead of polling forever', async () => {
  const paybox = new FakePayBoxClient()
  paybox.onPayX402 = (input, c) => {
    const id = 'paybox-req-broken-output'
    c.requests.set(id, { request_id: id, status: 'success', output: {} })
    return { request_id: id, status: 'success', output: {} }
  }
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: merchantFetch('0x' + '44'.repeat(32)) })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'manual-recovery-required')
  assert.match(outcome.reason, /terminal status "success"/)

  const generic = { clientSubmissionKey: 'attempt-1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  const resumed = await executor.resume(generic)
  assert.equal(resumed.status, 'manual-recovery-required', 'polling the same broken terminal response again must not become retryable-forever')
  assert.equal(paybox.payX402Calls.length, 1)
})

// --- D2.6 FINAL correction: prepare()/submit() boundary, real CommerceOperation flow ---

const PAYER = '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846'
const GATEWAY_ACTION = { ...ACTION, sender: PAYER }

test('D2.6 FINAL #3: the OCD execution binding is durably registered BEFORE useService() can be called, in the real CommerceOperation flow', async () => {
  const server = createFakeServer()
  let bindingRegistered = false
  const spyFetch = async (url, init) => {
    const res = await server.fetch(url, init)
    const pathname = new URL(url).pathname
    if (/\/execution-bindings$/.test(pathname) && (init?.method || 'GET').toUpperCase() === 'POST' && res.ok) {
      bindingRegistered = true
    }
    return res
  }
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: spyFetch })
  const op = await client.open({ action: GATEWAY_ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')
  assert.equal(bindingRegistered, false, 'no binding should exist yet before execute() runs')

  const paybox = new FakePayBoxClient()
  const realUseService = paybox.useService.bind(paybox)
  paybox.useService = async (input) => {
    assert.equal(bindingRegistered, true, 'useService() must never be called before the OCD execution binding is registered')
    return realUseService(input)
  }
  const executor = new PayBoxCommerceExecutor({
    paybox,
    credentialId: CREDENTIAL_ID,
    store: new InMemoryPayBoxRequestStore(),
    mode: 'gateway',
    fetch: merchantFetch('0x' + 'cc'.repeat(32)),
  })
  const execution = await op.execute({ executor })
  assert.equal(execution.kind, 'pending', 'FakePayBoxClient resolves gateway success immediately, but with no on-chain transfer added yet this must stay ambiguous, never fabricate success')
  assert.equal(bindingRegistered, true)
  assert.equal(paybox.useServiceCalls.length, 1)
})

test('D2.6 FINAL: provider_reference is attached to the execution binding as soon as useService() returns a request_id, even while the outcome is still pending', async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: GATEWAY_ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  const paybox = new FakePayBoxClient()
  const executor = new PayBoxCommerceExecutor({
    paybox,
    credentialId: CREDENTIAL_ID,
    store: new InMemoryPayBoxRequestStore(),
    mode: 'gateway',
    fetch: merchantFetch('0x' + 'dd'.repeat(32)),
  })
  const execution = await op.execute({ executor })
  assert.equal(execution.kind, 'pending', 'no on-chain transfer added yet -- still ambiguous')

  const binding = server.getExecutionBinding(execution.executionRequestId)
  assert.ok(binding, 'execution binding must exist')
  assert.equal(paybox.useServiceCalls.length, 1)
  const [payboxRequestId] = [...paybox.requests.keys()]
  assert.equal(
    binding.providerReference,
    `paybox:${payboxRequestId}`,
    'provider_reference must already be attached even though the overall outcome is still pending, not only once transaction-known'
  )
})

// --- D2.6 durability correction: provider_reference must be durably attached BEFORE local terminal state ---

/**
 * Wraps a fakeServer's fetch so calls to the execution-bindings state
 * endpoint that carry ONLY `provider_reference` (no `state` -- i.e. the
 * strict attach, never the best-effort submission_state mirror) can be
 * made to fail on demand, then succeed. `conflict: true` always returns
 * 409; otherwise the first `failCount` such calls return 503, and every
 * call after that (or every call, if `failCount` is 0) passes through to
 * the real fake server.
 */
function makeAttachFailingFetch(server, { failCount = 0, throwNetworkError = false, conflict = false } = {}) {
  let attachAttempts = 0
  return async (url, init) => {
    const pathname = new URL(url).pathname
    const method = (init?.method || 'GET').toUpperCase()
    const isStateRoute = /\/execution-bindings\/[^/]+\/state$/.test(pathname) && method === 'POST'
    if (isStateRoute && init?.body) {
      const body = JSON.parse(init.body)
      const isStrictAttach = body.provider_reference !== undefined && body.state === undefined
      if (isStrictAttach) {
        attachAttempts++
        if (conflict) {
          return new Response(JSON.stringify({ error: 'execution binding already has a different provider_reference' }), { status: 409, headers: { 'content-type': 'application/json' } })
        }
        if (attachAttempts <= failCount) {
          if (throwNetworkError) throw new Error('simulated network drop')
          return new Response(JSON.stringify({ error: 'simulated transient failure' }), { status: 503, headers: { 'content-type': 'application/json' } })
        }
      }
    }
    return server.fetch(url, init)
  }
}

function gatewayExecutorWithMatchingTransfer({ paybox = new FakePayBoxClient(), store = new InMemoryPayBoxRequestStore(), transactionHash = '0x' + 'ee'.repeat(32) } = {}) {
  const baseReadClient = new FakeBaseLogClient()
  // Pre-add the transfer at the store's default start block -- submitGateway()'s
  // own getBlockNumber() call (moments later, inside the SAME execute() call)
  // returns this exact bumped value as searchFromBlock, so the transfer is
  // always found on the very first attempt, in one execute() call.
  baseReadClient.addTransfer({ blockNumber: 1005n, transactionHash, blockHash: '0xblock', logIndex: 0, from: PAYER, to: RECIPIENT, value: 1_000_000n })
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store, mode: 'gateway', baseReadClient, fetch: merchantFetch('0x' + 'ff'.repeat(32)) })
  return { paybox, store, baseReadClient, executor }
}

test('D2.6 durability / D3.4C2: provider_reference attaches before local terminal state and the terminal PayBox claim is recorded without fabricating a transaction hash', async () => {
  const server = createFakeServer()
  let sawTransactionHashDuringAttach
  let payboxClaim
  let op
  const spyFetch = async (url, init) => {
    const pathname = new URL(url).pathname
    if (/\/execution-bindings\/[^/]+\/state$/.test(pathname) && init?.body) {
      const body = JSON.parse(init.body)
      if (body.provider_reference !== undefined && body.state === undefined) {
        sawTransactionHashDuringAttach = op.currentRecord().transactionHash
      }
    }
    if (/\/provider-evidence$/.test(pathname) && init?.body) {
      payboxClaim = JSON.parse(init.body)
      return new Response(JSON.stringify({ evidence_id: 'sha256:provider-claim' }), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    return server.fetch(url, init)
  }
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: spyFetch })
  op = await client.open({ action: GATEWAY_ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  const { executor } = gatewayExecutorWithMatchingTransfer()
  const execution = await op.execute({ executor })

  assert.equal(sawTransactionHashDuringAttach, null, 'transactionHash must still be null in the local record at the moment the attach call is made')
  assert.equal(execution.kind, 'execution-recorded', 'a successful attachment must let transaction-known proceed exactly as before')
  assert.equal(op.currentRecord().transactionHash, execution.transactionHash)
  assert.equal(payboxClaim.provider_version, 'v1-gateway')
  assert.equal(payboxClaim.paybox_response.status, 'success')
  assert.equal(payboxClaim.paybox_response.payment.network, 'eip155:8453')
  assert.equal(payboxClaim.paybox_response.transaction_hash, undefined, 'the SDK must not fabricate a PayBox transaction hash')
})

test('D2.6 durability #2/#3/#4: a transient provider-reference attach failure does not make the execution permanently terminal, uses the same request_id, and never calls useService twice', async () => {
  const server = createFakeServer()
  const failingFetch = makeAttachFailingFetch(server, { failCount: 1 })
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: failingFetch })
  const op = await client.open({ action: GATEWAY_ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  const { paybox, executor } = gatewayExecutorWithMatchingTransfer()

  const first = await op.execute({ executor })
  assert.equal(first.kind, 'pending', 'a transient attach failure must not be reported as a fabricated success or a hard failure')
  assert.equal(op.currentRecord().transactionHash, null, 'transactionHash must NOT be persisted locally while the attach is unresolved')
  assert.equal(paybox.useServiceCalls.length, 1)
  const [payboxRequestId] = [...paybox.requests.keys()]

  const second = await op.execute({ executor })
  assert.equal(second.kind, 'execution-recorded', 'retrying must succeed once the attach itself succeeds')
  assert.equal(paybox.useServiceCalls.length, 1, 'useService must never be called a second time across the retry')
  const [onlyPayboxRequestId] = [...paybox.requests.keys()]
  assert.equal(onlyPayboxRequestId, payboxRequestId, 'the retry must resume the SAME PayBox request_id, never a new one')
})

test('D2.6 durability #5: retrying an identical provider_reference after the server already attached it succeeds idempotently (lost-response simulation)', async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: GATEWAY_ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  const { executor } = gatewayExecutorWithMatchingTransfer()
  const first = await op.execute({ executor })
  assert.equal(first.kind, 'execution-recorded')

  // A second, independent attempt to attach the EXACT same reference (as if
  // the client had lost the first success response) must be a no-op success.
  const binding = server.getExecutionBinding(first.executionRequestId)
  await assert.doesNotReject(() =>
    server.fetch(`https://mcp.onchaindiligence.com/operations/${op.operationId}/execution-bindings/${first.executionRequestId}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider_reference: binding.providerReference }),
    })
  )
})

test('D2.6 durability #6/#7/#8: an HTTP 409 conflicting provider_reference is surfaced, never overwrites the original, and never triggers a second PayBox request', async () => {
  const server = createFakeServer()
  const failingFetch = makeAttachFailingFetch(server, { conflict: true })
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: failingFetch })
  const op = await client.open({ action: GATEWAY_ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  const { paybox, executor } = gatewayExecutorWithMatchingTransfer()
  const execution = await op.execute({ executor })

  assert.equal(execution.kind, 'manual-recovery-required', 'a genuine conflict must be surfaced, never swallowed into a fabricated success')
  assert.match(execution.reason, /conflict/i)
  assert.equal(op.currentRecord().transactionHash, null, 'transactionHash must never be persisted locally when the server-side correlation conflicts')
  assert.equal(paybox.useServiceCalls.length, 1, 'a conflict must never trigger a second PayBox request')

  // Retrying again must keep reporting the same conflict, never "recover" into a fabricated success.
  const retried = await op.execute({ executor })
  assert.equal(retried.kind, 'manual-recovery-required')
  assert.equal(paybox.useServiceCalls.length, 1)
})

test('D2.6 durability #10: observeAndFinalize cannot proceed while a provider-reference correlation failure is unresolved', async () => {
  const server = createFakeServer()
  const failingFetch = makeAttachFailingFetch(server, { conflict: true })
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: failingFetch })
  const op = await client.open({ action: GATEWAY_ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  const { executor } = gatewayExecutorWithMatchingTransfer()
  const execution = await op.execute({ executor })
  assert.equal(execution.kind, 'manual-recovery-required')

  const finalize = await op.observeAndFinalize()
  assert.equal(finalize.kind, 'pending', 'observeAndFinalize() must refuse to proceed -- no transactionHash was ever persisted locally for an unresolved correlation')
})

test('D2.6 durability #11: submission-ambiguous with a known request_id retries provider-reference synchronization safely (best-effort, non-blocking)', async () => {
  const server = createFakeServer()
  const failingFetch = makeAttachFailingFetch(server, { failCount: 1 })
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: failingFetch })
  const op = await client.open({ action: GATEWAY_ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  const paybox = new FakePayBoxClient()
  paybox.onUseService = (input, c) => {
    const id = 'gw-req-still-pending'
    c.requests.set(id, { request_id: id, status: 'pending_approval' })
    return { request_id: id, status: 'pending_approval' }
  }
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), mode: 'gateway', fetch: merchantFetch('0x' + 'aa'.repeat(32)) })

  const first = await op.execute({ executor })
  assert.equal(first.kind, 'pending')
  assert.equal(paybox.useServiceCalls.length, 1)

  const second = await op.execute({ executor })
  assert.equal(second.kind, 'pending', 'still pending_approval -- the best-effort attach retry must not change the underlying PayBox status')
  assert.equal(paybox.useServiceCalls.length, 1, 'useService must never be called again while retrying provider-reference synchronization')
})

test('D2.6 durability #12: an executor without providerReference (e.g. MockCommerceExecutor) keeps its current, unaffected behavior', async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  const execution = await op.execute({ executor: new MockCommerceExecutor() })
  assert.equal(execution.kind, 'execution-recorded')
  assert.ok(execution.transactionHash.startsWith('0x'))
})

test('D2.6 durability #13: gateway remains TRANSFER_MATCH_ONLY-eligible (executorVersion "v1-gateway") after a successful provider_reference attachment', async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: GATEWAY_ACTION, policy: POLICY })
  assert.equal((await op.preflight()).kind, 'ready')

  const { executor } = gatewayExecutorWithMatchingTransfer()
  assert.equal(executor.version, 'v1-gateway', 'gateway mode must keep reporting the distinct executor_version the server keys its TRANSFER_MATCH_ONLY cap on')
  const execution = await op.execute({ executor })
  assert.equal(execution.kind, 'execution-recorded')
  assert.equal(executor.version, 'v1-gateway', 'the durability fix (provider_reference attachment) must never mutate executor identity/version after execution')
})
