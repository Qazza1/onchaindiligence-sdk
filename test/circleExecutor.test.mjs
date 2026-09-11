/** D3.4C6: unit-level tests for CircleCommerceExecutor -- submit at most
 * once, resume-by-transaction-id, and Circle's own CONFIRMED-vs-COMPLETE
 * finality distinction. Fully offline: Circle is a fake (FakeCircleClient),
 * no real Circle account, no real network, no real payment.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CircleCommerceExecutor,
  InMemoryCircleRequestStore,
  CircleAmbiguousSubmitError,
  CircleStoreRequiredError,
  deriveIdempotencyKey,
  CIRCLE_BASE_NETWORK,
  CIRCLE_BASE_USDC,
} from '../dist/commerce/index.js'
import { FakeCircleClient } from './fakeCircleClient.mjs'

const RECIPIENT = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
const ACTION = { network: CIRCLE_BASE_NETWORK, asset: CIRCLE_BASE_USDC, amount: '1.0', recipient: RECIPIENT, resource: null, sender: null }
const OPTS = () => ({ circle: new FakeCircleClient(), walletId: 'wallet-1', tokenId: 'token-usdc-base', store: new InMemoryCircleRequestStore() })

test('recoveryMode is honestly stable-payment-identity, and a durable store is required', () => {
  const circle = new FakeCircleClient()
  const executor = new CircleCommerceExecutor({ circle, walletId: 'wallet-1', tokenId: 'token-usdc-base', store: new InMemoryCircleRequestStore() })
  assert.equal(executor.recoveryMode, 'stable-payment-identity')
  assert.equal(executor.id, 'circle-base-usdc')
  assert.throws(() => new CircleCommerceExecutor({ circle, walletId: 'wallet-1', tokenId: 'token-usdc-base' }), CircleStoreRequiredError)
})

test('deriveIdempotencyKey is deterministic and UUID-v4-shaped', () => {
  const a = deriveIdempotencyKey('attempt-1')
  const b = deriveIdempotencyKey('attempt-1')
  const c = deriveIdempotencyKey('attempt-2')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('prepare() makes no Circle call; submit() calls createTransfer exactly once with a derived idempotency key', async () => {
  const { circle, ...opts } = OPTS()
  const executor = new CircleCommerceExecutor({ circle, ...opts })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  assert.equal(circle.createTransferCalls.length, 0, 'prepare() must not call createTransfer')

  circle.onCreateTransfer = (input, client) => {
    const id = 'circle-txn-fixed'
    const result = { id, state: 'COMPLETE', txHash: '0x' + 'ab'.repeat(32) }
    client.transactions.set(id, result)
    return result
  }
  const outcome = await executor.submit(prepared)
  assert.equal(circle.createTransferCalls.length, 1)
  assert.equal(circle.createTransferCalls[0].idempotencyKey, deriveIdempotencyKey('attempt-1'))
  assert.equal(outcome.status, 'transaction-known')
  assert.equal(outcome.transactionHash, '0x' + 'ab'.repeat(32))
  assert.equal(outcome.providerReference, 'circle:circle-txn-fixed')
})

test('CONFIRMED (included, awaiting finality) is not treated as terminal -- only COMPLETE is', async () => {
  const { circle, ...opts } = OPTS()
  const executor = new CircleCommerceExecutor({ circle, ...opts })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })

  circle.onCreateTransfer = (input, client) => {
    const id = 'circle-txn-confirmed'
    const result = { id, state: 'CONFIRMED', txHash: '0x' + 'cd'.repeat(32) }
    client.transactions.set(id, result)
    return result
  }
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'submission-ambiguous')
  assert.match(outcome.reason, /CONFIRMED/)
  assert.equal(circle.createTransferCalls.length, 1)

  // Later resolves to COMPLETE -- resume() must poll, never resend.
  const generic = { clientSubmissionKey: 'attempt-1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  circle.transactions.set('circle-txn-confirmed', { id: 'circle-txn-confirmed', state: 'COMPLETE', txHash: '0x' + 'cd'.repeat(32) })
  const resumed = await executor.resume(generic)
  assert.equal(resumed.status, 'transaction-known')
  assert.equal(circle.createTransferCalls.length, 1, 'createTransfer must never be called a second time for this attempt, ever')
})

test('Circle FAILED is terminal, not endlessly retried as ambiguous', async () => {
  const { circle, ...opts } = OPTS()
  circle.onCreateTransfer = (input, client) => {
    const id = 'circle-txn-failed'
    const result = { id, state: 'FAILED' }
    client.transactions.set(id, result)
    return result
  }
  const executor = new CircleCommerceExecutor({ circle, ...opts })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'manual-recovery-required')
  assert.match(outcome.reason, /FAILED/)
})

test('a lost response after createTransfer succeeded is resumed from the durable store, not resent', async () => {
  const circle = new FakeCircleClient()
  const store = new InMemoryCircleRequestStore()
  circle.onCreateTransfer = (input, client) => {
    const id = 'circle-txn-stable'
    client.transactions.set(id, { id, state: 'COMPLETE', txHash: '0x' + 'ef'.repeat(32) })
    return { id, state: 'INITIATED' }
  }
  const executor = new CircleCommerceExecutor({ circle, walletId: 'wallet-1', tokenId: 'token-usdc-base', store })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  await executor.submit(prepared)
  assert.equal(circle.createTransferCalls.length, 1)

  const executor2 = new CircleCommerceExecutor({ circle, walletId: 'wallet-1', tokenId: 'token-usdc-base', store })
  const generic = { clientSubmissionKey: 'attempt-1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  const resumed = await executor2.resume(generic)
  assert.equal(resumed.status, 'transaction-known')
  assert.equal(circle.createTransferCalls.length, 1, 'createTransfer must never be called again after a restart')
})

test('a network drop between claiming the attempt and learning the transaction id refuses to silently retry', async () => {
  const { circle, ...opts } = OPTS()
  circle.onCreateTransfer = () => {
    throw new Error('simulated network drop -- Circle may or may not have created a transaction')
  }
  const executor = new CircleCommerceExecutor({ circle, ...opts })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  await assert.rejects(() => executor.submit(prepared))

  circle.onCreateTransfer = () => {
    throw new Error('createTransfer must not be called a second time for this clientSubmissionKey')
  }
  await assert.rejects(() => executor.submit(prepared), CircleAmbiguousSubmitError)
})

test('resume() with an already-confirmed prior transaction hash re-confirms on-chain and never re-sends', async () => {
  const knownTxHash = '0x' + '11'.repeat(32)
  const circle = new FakeCircleClient()
  circle.onCreateTransfer = () => {
    throw new Error('createTransfer must not be called when a transaction hash is already known')
  }
  const fakePublicClient = { getTransactionReceipt: async ({ hash }) => (hash === knownTxHash ? { status: 'success' } : Promise.reject(new Error('not found'))) }
  const executor = new CircleCommerceExecutor({ circle, walletId: 'wallet-1', tokenId: 'token-usdc-base', store: new InMemoryCircleRequestStore(), publicClient: fakePublicClient })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })

  const priorOutcome = { clientSubmissionKey: 'attempt-1', status: 'transaction-known', transactionHash: knownTxHash }
  const resumed = await executor.resume(prepared, priorOutcome)
  assert.equal(resumed.status, 'transaction-known')
  assert.equal(resumed.transactionHash, knownTxHash)
})
