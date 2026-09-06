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
  PAYBOX_BASE_NETWORK,
  PAYBOX_BASE_USDC,
} from '../dist/commerce/index.js'
import { createFakeServer } from './fakeServer.mjs'
import { FakePayBoxClient } from './fakePayboxClient.mjs'

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
