/** D3.4C5: minimum unit-level tests for CdpCommerceExecutor -- submit at
 * most once, resume-by-identity, and provider-evidence attachment, per the
 * task's own "keep this lean" instruction. Fully offline: CDP is a fake
 * (FakeCdpClient), no real CDP account, no real network, no real payment.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CdpCommerceExecutor,
  InMemoryCdpRequestStore,
  CdpAmbiguousSubmitError,
  CdpStoreRequiredError,
  CdpSendError,
  CDP_BASE_NETWORK,
  CDP_BASE_USDC,
} from '../dist/commerce/index.js'
import { FakeCdpClient } from './fakeCdpClient.mjs'

const RECIPIENT = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
const SENDER = '0x1111111111111111111111111111111111111a'
const ACTION = { network: CDP_BASE_NETWORK, asset: CDP_BASE_USDC, amount: '1.0', recipient: RECIPIENT, resource: null, sender: SENDER }

test('recoveryMode is honestly stable-payment-identity, and a durable store is required', () => {
  const executor = new CdpCommerceExecutor({ cdp: new FakeCdpClient(), store: new InMemoryCdpRequestStore() })
  assert.equal(executor.recoveryMode, 'stable-payment-identity')
  assert.equal(executor.id, 'cdp-base-usdc')
  assert.throws(() => new CdpCommerceExecutor({ cdp: new FakeCdpClient() }), CdpStoreRequiredError)
})

test('prepare() makes no CDP call; submit() calls sendTransaction exactly once, passing clientSubmissionKey as the idempotency key, and attaches provider evidence', async () => {
  const cdp = new FakeCdpClient()
  const executor = new CdpCommerceExecutor({ cdp, store: new InMemoryCdpRequestStore() })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  assert.equal(cdp.sendTransactionCalls.length, 0, 'prepare() must not call sendTransaction')

  const outcome = await executor.submit(prepared)
  assert.equal(cdp.sendTransactionCalls.length, 1)
  assert.equal(cdp.sendTransactionCalls[0].idempotencyKey, 'attempt-1')
  assert.equal(outcome.status, 'transaction-known')
  assert.equal(outcome.transactionHash, '0x' + 'ab'.repeat(32))
  assert.equal(outcome.providerReference, `cdp:${'0x' + 'ab'.repeat(32)}`)
  assert.equal(outcome.providerEvidence.provider, 'cdp')
  assert.equal(outcome.providerEvidence.payload.status, 'success')
  assert.equal(outcome.providerEvidence.payload.transaction_hash, outcome.transactionHash)
})

test('resume() by durable record after a lost response never resends', async () => {
  const cdp = new FakeCdpClient()
  const store = new InMemoryCdpRequestStore()
  const executor = new CdpCommerceExecutor({ cdp, store })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  await executor.submit(prepared)
  assert.equal(cdp.sendTransactionCalls.length, 1)

  // Simulate "client restarted": a brand-new executor instance sharing only the durable store.
  const executor2 = new CdpCommerceExecutor({ cdp, store })
  const generic = { clientSubmissionKey: 'attempt-1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  const resumed = await executor2.resume(generic)
  assert.equal(resumed.status, 'transaction-known')
  assert.equal(cdp.sendTransactionCalls.length, 1, 'sendTransaction must never be called again after a restart')
})

test('a network drop between claiming the attempt and learning the result refuses to silently retry', async () => {
  const cdp = new FakeCdpClient()
  cdp.onSendTransaction = () => {
    throw new Error('simulated network drop -- CDP may or may not have broadcast a transaction')
  }
  // A genuine network-level drop (not a CdpSendError) leaves NEITHER a hash NOR a definitive `failed` record --
  // this executor treats CdpSendError as a definitive terminal failure, but a bare thrown Error is still recorded as `failed`
  // per this adapter's own submit() catch. To exercise the true ambiguous-crash window, simulate a store that never persists.
  const store = new InMemoryCdpRequestStore()
  const originalSet = store.set.bind(store)
  let allowPersist = true
  store.set = async (record) => {
    if (!allowPersist) return // simulates a crash before the result is durably recorded
    return originalSet(record)
  }
  const executor = new CdpCommerceExecutor({ cdp, store })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  allowPersist = false
  await executor.submit(prepared) // claim is persisted (via claim()), but the failure outcome write is dropped
  allowPersist = true

  await assert.rejects(() => executor.submit(prepared), CdpAmbiguousSubmitError)
  assert.equal(cdp.sendTransactionCalls.length, 1, 'sendTransaction must never be called a second time for this clientSubmissionKey')
})

test('a CDP send failure (CdpSendError) is terminal, not endlessly retried as ambiguous, and attaches failed provider evidence', async () => {
  const cdp = new FakeCdpClient()
  cdp.onSendTransaction = () => {
    throw new CdpSendError('insufficient balance for gas * price + value', 'insufficient_funds')
  }
  const executor = new CdpCommerceExecutor({ cdp, store: new InMemoryCdpRequestStore() })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'manual-recovery-required')
  assert.match(outcome.reason, /insufficient_funds/)
  assert.equal(outcome.providerEvidence.payload.status, 'failed')
  assert.equal(outcome.providerEvidence.payload.error.code, 'insufficient_funds')

  // Retrying submit() for the SAME clientSubmissionKey must not call sendTransaction again -- it's terminal.
  cdp.onSendTransaction = () => {
    throw new Error('sendTransaction must not be called a second time for this clientSubmissionKey')
  }
  const second = await executor.submit(prepared)
  assert.equal(second.status, 'manual-recovery-required')
  assert.equal(cdp.sendTransactionCalls.length, 1)
})

test('resume() with an already-confirmed prior transaction hash re-confirms on-chain and never re-sends', async () => {
  const knownTxHash = '0x' + '11'.repeat(32)
  const cdp = new FakeCdpClient()
  cdp.onSendTransaction = () => {
    throw new Error('sendTransaction must not be called when a transaction hash is already known')
  }
  const fakePublicClient = { getTransactionReceipt: async ({ hash }) => (hash === knownTxHash ? { status: 'success' } : Promise.reject(new Error('not found'))) }
  const executor = new CdpCommerceExecutor({ cdp, store: new InMemoryCdpRequestStore(), publicClient: fakePublicClient })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })

  const priorOutcome = { clientSubmissionKey: 'attempt-1', status: 'transaction-known', transactionHash: knownTxHash }
  const resumed = await executor.resume(prepared, priorOutcome)
  assert.equal(resumed.status, 'transaction-known')
  assert.equal(resumed.transactionHash, knownTxHash)
})
