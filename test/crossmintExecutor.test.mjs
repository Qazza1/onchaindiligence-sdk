/** D3.4C4: minimum unit-level tests for CrossmintCommerceExecutor -- submit
 * exactly once + resume by transferId, per the task's own "keep this lean"
 * instruction. Fully offline: Crossmint is a fake (FakeCrossmintClient), no
 * real Crossmint account, no real network, no real payment.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CrossmintCommerceExecutor,
  InMemoryCrossmintRequestStore,
  CrossmintAmbiguousSubmitError,
  CrossmintStoreRequiredError,
  CROSSMINT_BASE_NETWORK,
  CROSSMINT_BASE_USDC,
} from '../dist/commerce/index.js'
import { FakeCrossmintClient } from './fakeCrossmintClient.mjs'

const RECIPIENT = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
const SENDER = '0x1111111111111111111111111111111111111a'
const ACTION = { network: CROSSMINT_BASE_NETWORK, asset: CROSSMINT_BASE_USDC, amount: '1.0', recipient: RECIPIENT, resource: null, sender: SENDER }

test('recoveryMode is honestly stable-payment-identity, and a durable store is required', () => {
  const executor = new CrossmintCommerceExecutor({ crossmint: new FakeCrossmintClient(), store: new InMemoryCrossmintRequestStore() })
  assert.equal(executor.recoveryMode, 'stable-payment-identity')
  assert.equal(executor.id, 'crossmint-base-usdc')
  assert.throws(() => new CrossmintCommerceExecutor({ crossmint: new FakeCrossmintClient() }), CrossmintStoreRequiredError)
})

test('prepare() makes no Crossmint call; submit() calls transfer exactly once, passing clientSubmissionKey as x-idempotency-key', async () => {
  const crossmint = new FakeCrossmintClient()
  const executor = new CrossmintCommerceExecutor({ crossmint, store: new InMemoryCrossmintRequestStore() })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  assert.equal(crossmint.transferCalls.length, 0, 'prepare() must not call transfer')

  crossmint.onTransfer = (input, client) => {
    const id = 'transfer_fixed'
    const result = { id, status: 'success', onChain: { txId: '0x' + 'ab'.repeat(32) } }
    client.transfers.set(id, result)
    return result
  }
  const outcome = await executor.submit(prepared)
  assert.equal(crossmint.transferCalls.length, 1)
  assert.equal(crossmint.transferCalls[0].idempotencyKey, 'attempt-1')
  assert.equal(outcome.status, 'transaction-known')
  assert.equal(outcome.transactionHash, '0x' + 'ab'.repeat(32))
  assert.equal(outcome.providerReference, 'crossmint:transfer_fixed')
})

test('resume() by transferId after a lost response never resends', async () => {
  const crossmint = new FakeCrossmintClient()
  const store = new InMemoryCrossmintRequestStore()
  crossmint.onTransfer = (input, client) => {
    const id = 'transfer_stable'
    const result = { id, status: 'success', onChain: { txId: '0x' + 'ef'.repeat(32) } }
    client.transfers.set(id, result)
    return result
  }
  const executor = new CrossmintCommerceExecutor({ crossmint, store })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  await executor.submit(prepared)
  assert.equal(crossmint.transferCalls.length, 1)

  // Simulate "client restarted": a brand-new executor instance sharing only the durable store.
  const executor2 = new CrossmintCommerceExecutor({ crossmint, store })
  const generic = { clientSubmissionKey: 'attempt-1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  const resumed = await executor2.resume(generic)
  assert.equal(resumed.status, 'transaction-known')
  assert.equal(crossmint.transferCalls.length, 1, 'transfer must never be called again after a restart')
})

test('a network drop between claiming the attempt and learning the transfer id refuses to silently retry', async () => {
  const crossmint = new FakeCrossmintClient()
  crossmint.onTransfer = () => {
    throw new Error('simulated network drop -- Crossmint may or may not have created a transfer')
  }
  const executor = new CrossmintCommerceExecutor({ crossmint, store: new InMemoryCrossmintRequestStore() })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  await assert.rejects(() => executor.submit(prepared))

  crossmint.onTransfer = () => {
    throw new Error('transfer must not be called a second time for this clientSubmissionKey')
  }
  await assert.rejects(() => executor.submit(prepared), CrossmintAmbiguousSubmitError)
})

test('a pending transfer is polled via getTransaction, never resent via transfer', async () => {
  const crossmint = new FakeCrossmintClient()
  const executor = new CrossmintCommerceExecutor({ crossmint, store: new InMemoryCrossmintRequestStore() })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })

  const first = await executor.submit(prepared)
  assert.equal(first.status, 'submission-ambiguous')
  assert.match(first.reason, /pending/)
  assert.equal(crossmint.transferCalls.length, 1)

  const id = first.providerReference.replace('crossmint:', '')
  crossmint.transfers.set(id, { id, status: 'success', onChain: { txId: '0x' + 'cd'.repeat(32) } })
  const generic = { clientSubmissionKey: 'attempt-1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  const second = await executor.resume(generic)
  assert.equal(second.status, 'transaction-known')
  assert.equal(crossmint.transferCalls.length, 1, 'transfer must never be called a second time for this attempt, ever')
})

test('Crossmint failed is terminal, not endlessly retried as ambiguous', async () => {
  const crossmint = new FakeCrossmintClient()
  crossmint.onTransfer = (input, client) => {
    const id = 'transfer_failed'
    const result = { id, status: 'failed', error: { reason: 'insufficient_funds', message: 'insufficient balance' } }
    client.transfers.set(id, result)
    return result
  }
  const executor = new CrossmintCommerceExecutor({ crossmint, store: new InMemoryCrossmintRequestStore() })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'manual-recovery-required')
  assert.match(outcome.reason, /failed/)
})
