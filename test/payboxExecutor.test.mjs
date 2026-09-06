/** D2.6: unit-level tests for PayBoxCommerceExecutor -- prepare()/submit()/
 * resume() mechanics against PayBox's documented pay_x402/get_request
 * contract, isolated from the OCD orchestrator (see payboxLifecycle.test.mjs
 * for the full open->preflight->execute->observe integration tests).
 *
 * Fully offline: PayBox is a fake (FakePayBoxClient), the merchant resource
 * is a faked `fetch`. No real PayBox account, no real network, no real
 * payment -- see this file's own header discipline mirrored from
 * x402Executor.test.mjs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PayBoxCommerceExecutor,
  InMemoryPayBoxRequestStore,
  PayBoxAmbiguousPrepareError,
  PayBoxStoreRequiredError,
  PAYBOX_BASE_NETWORK,
  PAYBOX_BASE_USDC,
} from '../dist/commerce/index.js'
import { FakePayBoxClient } from './fakePayboxClient.mjs'

const RESOURCE_URL = 'https://merchant.example/api/thing'
const RECIPIENT = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
const ATOMIC_AMOUNT = '10000' // $0.01 at 6 decimals
const CREDENTIAL_ID = 'cred_test_wallet_1'

function base64utf8(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

function validChallenge(overrides = {}) {
  return {
    x402Version: 2,
    accepts: [{ scheme: 'exact', network: PAYBOX_BASE_NETWORK, asset: PAYBOX_BASE_USDC, payTo: RECIPIENT, amount: ATOMIC_AMOUNT, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' }, ...overrides }],
  }
}

const ACTION = { network: PAYBOX_BASE_NETWORK, asset: PAYBOX_BASE_USDC, amount: '0.01', recipient: RECIPIENT, resource: RESOURCE_URL, sender: null }

function merchantFetchAcceptingHeader(fakeTxHash) {
  return async (url, init) => {
    const req = url instanceof Request ? url : new Request(url, init)
    if (req.headers.get('x-payment')) {
      return new Response('{}', { status: 200, headers: { 'x-payment-response': base64utf8({ transaction: fakeTxHash }) } })
    }
    return new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  }
}

test('recoveryMode is honestly stable-payment-identity, not provider-idempotent or manual', () => {
  const executor = new PayBoxCommerceExecutor({ paybox: new FakePayBoxClient(), credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore() })
  assert.equal(executor.recoveryMode, 'stable-payment-identity')
})

test('D2.6 review fix #2: constructing without a durable store fails fast, never silently defaults to volatile storage', () => {
  assert.throws(() => new PayBoxCommerceExecutor({ paybox: new FakePayBoxClient(), credentialId: CREDENTIAL_ID }), PayBoxStoreRequiredError)
  assert.throws(() => new PayBoxCommerceExecutor({ paybox: new FakePayBoxClient(), credentialId: CREDENTIAL_ID, store: undefined }), PayBoxStoreRequiredError)
})

test('D2.6 review fix #3: concurrent prepare() calls for the same clientSubmissionKey call pay_x402 exactly once', async () => {
  const store = new InMemoryPayBoxRequestStore()
  const paybox = new FakePayBoxClient()
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store, fetch: merchantFetchAcceptingHeader('0x' + '33'.repeat(32)) })

  const [a, b] = await Promise.allSettled([
    executor.prepare({ clientSubmissionKey: 'race-1', action: ACTION }),
    executor.prepare({ clientSubmissionKey: 'race-1', action: ACTION }),
  ])
  assert.equal(paybox.payX402Calls.length, 1, 'exactly one PayBox request must be created for two concurrent attempts')

  // Exactly one claimant proceeds and always succeeds; the other either
  // reuses the SAME established request (if the winner finished first) or is
  // honestly rejected as ambiguous (the known, unavoidable crash-window case
  // -- see PayBoxAmbiguousPrepareError) -- it must never independently call
  // pay_x402 itself.
  const outcomes = [a, b]
  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled')
  assert.ok(fulfilled.length >= 1, 'the winning claimant must always succeed')
  for (const o of fulfilled) assert.ok(o.value.providerReference.startsWith('paybox:'))
  for (const o of outcomes) {
    if (o.status === 'rejected') assert.ok(o.reason instanceof PayBoxAmbiguousPrepareError)
  }

  // Once the race has settled, a follow-up prepare() for the SAME key must
  // reuse the established request -- never call pay_x402 again.
  const followUp = await executor.prepare({ clientSubmissionKey: 'race-1', action: ACTION })
  assert.equal(paybox.payX402Calls.length, 1)
  assert.ok(followUp.providerReference.startsWith('paybox:'))
})

test('prepare() probes the merchant read-only, calls pay_x402 exactly once, and never broadcasts', async () => {
  let fetchCalls = 0
  const fakeFetch = async () => {
    fetchCalls++
    return new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  }
  const paybox = new FakePayBoxClient()
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: fakeFetch })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })

  assert.equal(fetchCalls, 1, 'prepare() must make exactly one read-only merchant probe')
  assert.equal(paybox.payX402Calls.length, 1, 'prepare() must call pay_x402 exactly once')
  assert.equal(paybox.payX402Calls[0].credential_id, CREDENTIAL_ID)
  assert.equal(paybox.payX402Calls[0].resource_url, RESOURCE_URL)
  assert.ok(prepared.providerReference.startsWith('paybox:'), 'providerReference must correlate the PayBox request id')
})

test('prepare() rejects a challenge quoting the wrong recipient before ever calling PayBox', async () => {
  const fakeFetch = async () => new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge({ payTo: '0x1111111111111111111111111111111111111a' })) } })
  const paybox = new FakePayBoxClient()
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: fakeFetch })
  await assert.rejects(() => executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION }), /recipient mismatch/)
  assert.equal(paybox.payX402Calls.length, 0, 'PayBox must never be called when the challenge itself is rejected')
})

test('submit() presents the PayBox-signed header to the merchant and extracts the transaction hash', async () => {
  const fakeTxHash = '0x' + 'ab'.repeat(32)
  const paybox = new FakePayBoxClient()
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: merchantFetchAcceptingHeader(fakeTxHash) })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'transaction-known')
  assert.equal(outcome.transactionHash, fakeTxHash)
  assert.equal(outcome.providerReference, prepared.providerReference)
})

test('a PENDING PayBox request is polled via get_request, never resubmitted via pay_x402', async () => {
  const paybox = new FakePayBoxClient()
  paybox.onPayX402 = (input, client) => {
    const id = 'paybox-req-pending'
    client.requests.set(id, { request_id: id, status: 'pending_approval' })
    return { request_id: id, status: 'pending_approval' }
  }
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: merchantFetchAcceptingHeader('0x' + 'cd'.repeat(32)) })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })

  const first = await executor.submit(prepared)
  assert.equal(first.status, 'submission-ambiguous')
  assert.match(first.reason, /pending_approval/)
  assert.equal(paybox.payX402Calls.length, 1, 'exactly one pay_x402 call so far')

  // The orchestrator would call resume() next, using ONLY clientSubmissionKey
  // (never re-deriving the PayBox request from a fresh prepare()).
  const generic = { clientSubmissionKey: 'attempt-1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  const second = await executor.resume(generic)
  assert.equal(second.status, 'submission-ambiguous', 'still pending -- resume() must poll, not resubmit')
  assert.equal(paybox.payX402Calls.length, 1, 'pay_x402 must never be called a second time while pending')
  assert.equal(paybox.getRequestCalls.length, 2, 'submit() and resume() each poll get_request exactly once')

  // Approval resolves -- next resume() must find success and complete via the merchant.
  paybox.requests.set('paybox-req-pending', { request_id: 'paybox-req-pending', status: 'success', output: { value: { x_payment: { header: 'X-PAYMENT', value: 'signed' } } } })
  const third = await executor.resume(generic)
  assert.equal(third.status, 'transaction-known')
  assert.equal(paybox.payX402Calls.length, 1, 'pay_x402 must never be called a second time for this attempt, ever')
})

test('PayBox DENIED never presents anything to the merchant and is terminal, not retried as ambiguous', async () => {
  let merchantCalls = 0
  const paybox = new FakePayBoxClient()
  paybox.onPayX402 = () => {
    const id = 'paybox-req-denied'
    paybox.requests.set(id, { request_id: id, status: 'denied', reason: 'spending limit exceeded' })
    return { request_id: id, status: 'denied', reason: 'spending limit exceeded' }
  }
  const fakeFetch = async () => {
    merchantCalls++
    return new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  }
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: fakeFetch })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  merchantCalls = 0 // reset after prepare()'s own probe

  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'manual-recovery-required')
  assert.match(outcome.reason, /denied/)
  assert.match(outcome.reason, /spending limit exceeded/)
  assert.equal(merchantCalls, 0, 'a denied PayBox request must never reach the merchant')
})

test('a lost response after pay_x402 succeeded is resumed from the durable store, not resubmitted', async () => {
  const paybox = new FakePayBoxClient()
  const store = new InMemoryPayBoxRequestStore()
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store, fetch: merchantFetchAcceptingHeader('0x' + 'ef'.repeat(32)) })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  assert.equal(paybox.payX402Calls.length, 1)

  // Simulate "client restarted": a brand-new executor instance sharing only
  // the durable store, receiving the orchestrator's generic reconstructed
  // reference (never the original PrepareResult).
  const executor2 = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store, fetch: merchantFetchAcceptingHeader('0x' + 'ef'.repeat(32)) })
  const generic = { clientSubmissionKey: 'attempt-1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  const resumed = await executor2.resume(generic)
  assert.equal(resumed.status, 'transaction-known')
  assert.equal(paybox.payX402Calls.length, 1, 'pay_x402 must never be called again after a restart')
})

test('a network drop between claiming the attempt and learning the PayBox request id refuses to silently retry pay_x402', async () => {
  const fakeFetch = async () => new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  const paybox = new FakePayBoxClient()
  paybox.onPayX402 = () => {
    throw new Error('simulated network drop -- PayBox may or may not have created a request')
  }
  const store = new InMemoryPayBoxRequestStore()
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store, fetch: fakeFetch })
  await assert.rejects(() => executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION }))

  // Retrying prepare() for the SAME clientSubmissionKey must not call pay_x402
  // again -- it must surface the ambiguity honestly instead.
  paybox.onPayX402 = () => {
    throw new Error('pay_x402 must not be called a second time for this clientSubmissionKey')
  }
  await assert.rejects(() => executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION }), PayBoxAmbiguousPrepareError)
})

test('resume() with an already-confirmed prior transaction hash re-confirms on-chain and never re-presents the payment', async () => {
  const knownTxHash = '0x' + '11'.repeat(32)
  let merchantCalls = 0
  const paybox = new FakePayBoxClient()
  const fakeFetch = async () => {
    merchantCalls++
    return new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  }
  const fakePublicClient = { getTransactionReceipt: async ({ hash }) => (hash === knownTxHash ? { status: 'success' } : Promise.reject(new Error('not found'))) }
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: fakeFetch, publicClient: fakePublicClient })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  merchantCalls = 0

  const priorOutcome = { clientSubmissionKey: 'attempt-1', status: 'transaction-known', transactionHash: knownTxHash }
  const resumed = await executor.resume(prepared, priorOutcome)
  assert.equal(resumed.status, 'transaction-known')
  assert.equal(resumed.transactionHash, knownTxHash)
  assert.equal(merchantCalls, 0, 'resume() must never re-present the payment to the merchant when a hash is already known')
})

test('resume() with no PayBox request on record honestly reports manual-recovery-required', async () => {
  const paybox = new FakePayBoxClient()
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore() })
  const resumed = await executor.resume({ clientSubmissionKey: 'never-prepared', reference: { action: ACTION }, preparedAt: new Date().toISOString() })
  assert.equal(resumed.status, 'manual-recovery-required')
})

test('no PayBox credential id leaks into prepare()/submit() outcomes', async () => {
  const paybox = new FakePayBoxClient()
  const executor = new PayBoxCommerceExecutor({ paybox, credentialId: CREDENTIAL_ID, store: new InMemoryPayBoxRequestStore(), fetch: merchantFetchAcceptingHeader('0x' + '22'.repeat(32)) })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.doesNotMatch(JSON.stringify(prepared), new RegExp(CREDENTIAL_ID))
  assert.doesNotMatch(JSON.stringify(outcome), new RegExp(CREDENTIAL_ID))
})
