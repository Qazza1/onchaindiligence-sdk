/** D2.6 gateway-mode correction: PayBoxCommerceExecutor's `useService`
 * (gateway) execution path -- proven live compatible with OneSource
 * (x402 v2), unlike header mode (pay_x402), which was proven live
 * INCOMPATIBLE (legacy x402Version 1 output against a v2 merchant).
 *
 * Fully offline: PayBox is a fake (FakePayBoxClient), the Base chain read
 * client is a fake (FakeBaseLogClient), the merchant probe is a faked
 * `fetch`. No real PayBox account, no real network, no real payment.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PayBoxCommerceExecutor,
  InMemoryPayBoxRequestStore,
  PAYBOX_BASE_NETWORK,
  PAYBOX_BASE_USDC,
} from '../dist/commerce/index.js'
import { FakePayBoxClient } from './fakePayboxClient.mjs'
import { FakeBaseLogClient } from './fakeBaseLogClient.mjs'

const RESOURCE_URL = 'https://api.onesource.io/api/chain/block-number'
const RECIPIENT = '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea'
const PAYER = '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846'
const ATOMIC_AMOUNT = '1000' // $0.001 at 6 decimals
const CREDENTIAL_ID = 'cred_evm_default'

function base64utf8(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}
function validChallenge(overrides = {}) {
  return {
    x402Version: 2,
    accepts: [{ scheme: 'exact', network: PAYBOX_BASE_NETWORK, asset: PAYBOX_BASE_USDC, payTo: RECIPIENT, amount: ATOMIC_AMOUNT, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' }, ...overrides }],
  }
}
const ACTION = { network: PAYBOX_BASE_NETWORK, asset: PAYBOX_BASE_USDC, amount: '0.001', recipient: RECIPIENT, resource: RESOURCE_URL, sender: PAYER }

function probeFetch() {
  return async () => new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
}

function gatewaySuccessEnvelope(requestId, overrides = {}) {
  return {
    request_id: requestId,
    status: 'success',
    output_id: `output-${requestId}`,
    audit_id: `audit-${requestId}`,
    output: {
      value: {
        payment: { gateway: true, network: PAYBOX_BASE_NETWORK, ok: true, scheme: 'exact', status: 'succeeded', ...overrides.payment },
        response: { status: 200, ok: true, ...overrides.response },
      },
    },
  }
}

function makeExecutor({ paybox = new FakePayBoxClient(), store = new InMemoryPayBoxRequestStore(), baseReadClient = new FakeBaseLogClient(), fetch = probeFetch() } = {}) {
  return {
    paybox,
    store,
    baseReadClient,
    executor: new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store, mode: 'gateway', baseReadClient, fetch }),
  }
}

test('gateway mode: prepare() calls useService exactly once, never payX402', async () => {
  const { paybox, executor } = makeExecutor()
  const prepared = await executor.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  assert.equal(paybox.useServiceCalls.length, 1)
  assert.equal(paybox.payX402Calls.length, 0)
  assert.equal(paybox.useServiceCalls[0].credential_id, CREDENTIAL_ID)
  assert.equal(paybox.useServiceCalls[0].url, RESOURCE_URL)
  assert.ok(!('accepts' in paybox.useServiceCalls[0]), 'useService must never be called with accepts[]')
  assert.ok(prepared.providerReference.startsWith('paybox:'))
})

test('gateway mode: request_id is durably persisted with mode: "gateway"', async () => {
  const { store, executor } = makeExecutor()
  const prepared = await executor.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  const record = await store.get('g1')
  assert.equal(record.mode, 'gateway')
  assert.equal(record.payboxRequestId, prepared.providerReference.replace('paybox:', ''))
  assert.equal(record.expectedPayer, PAYER)
  assert.ok(record.searchFromBlock, 'searchFromBlock must be captured at prepare() time')
})

test('gateway mode: resume() polls getRequest only, never calls useService again', async () => {
  const { paybox, executor } = makeExecutor()
  const prepared = await executor.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  const requestId = prepared.providerReference.replace('paybox:', '')
  paybox.setStatus(requestId, { status: 'pending_approval' })

  const first = await executor.submit(prepared)
  assert.equal(first.status, 'submission-ambiguous')
  assert.equal(paybox.useServiceCalls.length, 1)

  const generic = { clientSubmissionKey: 'g1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  const second = await executor.resume(generic)
  assert.equal(second.status, 'submission-ambiguous')
  assert.equal(paybox.useServiceCalls.length, 1, 'useService must never be called a second time')
  assert.ok(paybox.getRequestCalls.length >= 1)
})

test('restart does not make a second useService call: a fresh executor sharing only the durable store resumes correctly', async () => {
  const paybox = new FakePayBoxClient()
  const store = new InMemoryPayBoxRequestStore()
  const baseReadClient = new FakeBaseLogClient()
  const executor1 = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store, mode: 'gateway', baseReadClient, fetch: probeFetch() })
  const prepared = await executor1.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  assert.equal(paybox.useServiceCalls.length, 1)

  const requestId = prepared.providerReference.replace('paybox:', '')
  const record = await store.get('g1')
  baseReadClient.addTransfer({ blockNumber: BigInt(record.searchFromBlock) + 5n, transactionHash: '0xaa', blockHash: '0xbb', logIndex: 1, from: PAYER, to: RECIPIENT, value: BigInt(ATOMIC_AMOUNT) })

  const executor2 = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store, mode: 'gateway', baseReadClient, fetch: probeFetch() })
  const generic = { clientSubmissionKey: 'g1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  const resumed = await executor2.resume(generic)
  assert.equal(resumed.status, 'transaction-known')
  assert.equal(paybox.useServiceCalls.length, 1, 'a restart must never call useService again')
})

test('concurrent prepare() calls for the same clientSubmissionKey produce exactly one useService call', async () => {
  const { paybox, executor } = makeExecutor()
  const [a, b] = await Promise.allSettled([
    executor.prepare({ clientSubmissionKey: 'race-g1', action: ACTION }),
    executor.prepare({ clientSubmissionKey: 'race-g1', action: ACTION }),
  ])
  assert.equal(paybox.useServiceCalls.length, 1)
  assert.ok([a, b].some((o) => o.status === 'fulfilled'))
})

test('success + exactly one matching transfer -> transaction-known, with exact event identity captured', async () => {
  const { store, executor, baseReadClient } = makeExecutor()
  const prepared = await executor.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  const record = await store.get('g1')
  baseReadClient.addTransfer({ blockNumber: BigInt(record.searchFromBlock) + 3n, transactionHash: '0xdeadbeef', blockHash: '0xblock1', logIndex: 7, from: PAYER, to: RECIPIENT, value: BigInt(ATOMIC_AMOUNT) })

  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'transaction-known')
  assert.equal(outcome.transactionHash, '0xdeadbeef')

  const finalRecord = await store.get('g1')
  assert.equal(finalRecord.transactionBlockHash, '0xblock1')
  assert.equal(finalRecord.transactionLogIndex, 7)
})

test('zero matching transfers -> recoverable submission-ambiguous, not a failure', async () => {
  const { executor } = makeExecutor() // no transfers added
  const prepared = await executor.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'submission-ambiguous')
  assert.match(outcome.reason, /no matching on-chain USDC transfer/)
})

test('multiple exactly-matching transfers -> manual-recovery-required, never guessed', async () => {
  const { store, executor, baseReadClient } = makeExecutor()
  const prepared = await executor.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  const record = await store.get('g1')
  const base = BigInt(record.searchFromBlock)
  baseReadClient.addTransfer({ blockNumber: base + 1n, transactionHash: '0x111', blockHash: '0xb1', logIndex: 0, from: PAYER, to: RECIPIENT, value: BigInt(ATOMIC_AMOUNT) })
  baseReadClient.addTransfer({ blockNumber: base + 2n, transactionHash: '0x222', blockHash: '0xb2', logIndex: 0, from: PAYER, to: RECIPIENT, value: BigInt(ATOMIC_AMOUNT) })

  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'manual-recovery-required')
  assert.match(outcome.reason, /found 2 exactly-matching/)
})

test('a transfer with the wrong payer, recipient, or amount is ignored', async () => {
  const { store, executor, baseReadClient } = makeExecutor()
  const prepared = await executor.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  const record = await store.get('g1')
  const base = BigInt(record.searchFromBlock)
  baseReadClient.addTransfer({ blockNumber: base + 1n, transactionHash: '0xwrongpayer', blockHash: '0xb1', logIndex: 0, from: '0x1111111111111111111111111111111111111a', to: RECIPIENT, value: BigInt(ATOMIC_AMOUNT) })
  baseReadClient.addTransfer({ blockNumber: base + 2n, transactionHash: '0xwrongrecipient', blockHash: '0xb2', logIndex: 0, from: PAYER, to: '0x1111111111111111111111111111111111111a', value: BigInt(ATOMIC_AMOUNT) })
  baseReadClient.addTransfer({ blockNumber: base + 3n, transactionHash: '0xwrongamount', blockHash: '0xb3', logIndex: 0, from: PAYER, to: RECIPIENT, value: BigInt('999') })

  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'submission-ambiguous', 'none of the mismatched transfers may be treated as a match')
})

test('gateway: payment.gateway !== true is rejected as invalid, never treated as paid', async () => {
  const paybox = new FakePayBoxClient()
  paybox.onUseService = (input, c) => {
    const id = 'gw-not-gateway'
    c.requests.set(id, gatewaySuccessEnvelope(id, { payment: { gateway: false } }))
    return c.requests.get(id)
  }
  const { executor } = makeExecutor({ paybox })
  const prepared = await executor.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'manual-recovery-required')
  assert.match(outcome.reason, /failed validation/)
})

test('gateway: payment.ok === false is rejected as invalid, never treated as paid', async () => {
  const paybox = new FakePayBoxClient()
  paybox.onUseService = (input, c) => {
    const id = 'gw-not-ok'
    c.requests.set(id, gatewaySuccessEnvelope(id, { payment: { ok: false } }))
    return c.requests.get(id)
  }
  const { executor } = makeExecutor({ paybox })
  const prepared = await executor.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'manual-recovery-required')
})

test('gateway: a non-2xx resource response is rejected as invalid, never treated as paid', async () => {
  const paybox = new FakePayBoxClient()
  paybox.onUseService = (input, c) => {
    const id = 'gw-bad-resource'
    c.requests.set(id, gatewaySuccessEnvelope(id, { response: { status: 500, ok: false } }))
    return c.requests.get(id)
  }
  const { executor } = makeExecutor({ paybox })
  const prepared = await executor.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'manual-recovery-required')
})

test('gateway: a terminal PayBox error remains terminal/manual, same semantics as header mode', async () => {
  const paybox = new FakePayBoxClient()
  paybox.onUseService = (input, c) => {
    const id = 'gw-error'
    c.requests.set(id, { request_id: id, status: 'error', message: 'internal gateway failure' })
    return c.requests.get(id)
  }
  const { executor } = makeExecutor({ paybox })
  const prepared = await executor.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'manual-recovery-required')
  assert.match(outcome.reason, /terminal error/)
  assert.equal(paybox.useServiceCalls.length, 1, 'a terminal error must never be retried into a new useService call')
})

test('gateway mode requires action.sender (the expected payer) -- throws before any PayBox call otherwise', async () => {
  const { paybox, executor } = makeExecutor()
  const actionWithoutSender = { ...ACTION, sender: null }
  await assert.rejects(() => executor.prepare({ clientSubmissionKey: 'g1', action: actionWithoutSender }), /action\.sender/)
  assert.equal(paybox.useServiceCalls.length, 0)
})

test('constructing mode: "gateway" against a client with no useService() throws before any call', async () => {
  const headerOnlyClient = { payX402: async () => ({ request_id: 'x', status: 'success' }), getRequest: async () => ({ request_id: 'x', status: 'success' }) }
  const executor = new PayBoxCommerceExecutor({ paybox: headerOnlyClient, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), mode: 'gateway', fetch: probeFetch() })
  await assert.rejects(() => executor.prepare({ clientSubmissionKey: 'g1', action: ACTION }), /useService/)
})

// --- historical header-mode incompatibility (the real, live-observed failure) ---

test('legacy header-mode incompatibility (x402Version 1 vs merchant v2) is terminal, never resubmits', async () => {
  const paybox = new FakePayBoxClient()
  paybox.onPayX402 = (input, c) => {
    const id = 'legacy-header-req'
    c.requests.set(id, { request_id: id, status: 'success', output: { value: { x_payment: { header: 'X-PAYMENT', value: 'legacy-v1-payload' } } } })
    return c.requests.get(id)
  }
  // The merchant keeps returning 402 with a v2 challenge no matter what header-mode presents -- exactly the real dfbecdc0-368e-4607-bd5a-c9d52f1098d6 failure.
  const fetchImpl = async () => new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  const store = new InMemoryPayBoxRequestStore()
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store, mode: 'header', fetch: fetchImpl })
  const prepared = await executor.prepare({ clientSubmissionKey: 'legacy-1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'manual-recovery-required')
  assert.match(outcome.reason, /x402Version 2/)
  assert.match(outcome.reason, /gateway/)

  // Re-checking (resume) must not resubmit via payX402, and must keep reporting the same honest incompatibility.
  const generic = { clientSubmissionKey: 'legacy-1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  const resumed = await executor.resume(generic)
  assert.equal(resumed.status, 'manual-recovery-required')
  assert.equal(paybox.payX402Calls.length, 1, 'the legacy request must never be resubmitted')
})

test('a durable pre-existing header-mode record with no mode field (predates gateway support) is still interpreted as header mode', async () => {
  const paybox = new FakePayBoxClient()
  const store = new InMemoryPayBoxRequestStore()
  // Simulate exactly the real historical record shape (no `mode` field at all).
  await store.set({
    clientSubmissionKey: 'historical-1',
    payboxRequestId: 'dfbecdc0-368e-4607-bd5a-c9d52f1098d6',
    resourceUrl: RESOURCE_URL,
    network: PAYBOX_BASE_NETWORK,
    asset: PAYBOX_BASE_USDC,
    atomicAmount: ATOMIC_AMOUNT,
    recipient: RECIPIENT,
    transactionHash: null,
  })
  paybox.setStatus('dfbecdc0-368e-4607-bd5a-c9d52f1098d6', { status: 'success', output: { value: { x_payment: { header: 'X-PAYMENT', value: 'legacy-v1-payload' } } } })
  const fetchImpl = async () => new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  // Constructed with mode: 'gateway' as the executor's OWN default for NEW requests -- must not matter for this OLD record.
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store, mode: 'gateway', fetch: fetchImpl })

  const generic = { clientSubmissionKey: 'historical-1', reference: { action: ACTION }, preparedAt: new Date().toISOString() }
  const resumed = await executor.resume(generic)
  assert.equal(resumed.status, 'manual-recovery-required')
  assert.match(resumed.reason, /x402Version 2/, 'a record with no mode field must be interpreted as header mode, not gateway')
  assert.equal(paybox.useServiceCalls.length, 0, 'the historical record must never be turned into a gateway request')
  assert.equal(paybox.payX402Calls.length, 0, 'the historical record must never be resubmitted')
})

test('no sensitive signed/authorization value is ever present in a PrepareResult, ExecutionResult, or stored record', async () => {
  const { store, executor } = makeExecutor()
  const prepared = await executor.prepare({ clientSubmissionKey: 'g1', action: ACTION })
  const outcome = await executor.submit(prepared)
  const record = await store.get('g1')
  const serialized = JSON.stringify({ prepared, outcome, record })
  assert.doesNotMatch(serialized, /signature|authorization|pbxk1\.|x_payment/i)
})
