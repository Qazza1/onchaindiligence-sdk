/** D3.4C3: unit-level tests for TurnkeyCommerceExecutor -- prepare()/submit()/
 * resume() mechanics against Turnkey's documented sendTransaction/
 * getTransactionStatus (ethSendTransaction/pollTransactionStatus) contract,
 * isolated from the OCD orchestrator. Fully offline: Turnkey is a fake
 * (FakeTurnkeyClient), no real Turnkey account, no real network, no real
 * payment -- see payboxExecutor.test.mjs's own header discipline mirrored here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TurnkeyCommerceExecutor,
  InMemoryTurnkeyRequestStore,
  TurnkeyAmbiguousSubmitError,
  TurnkeyStoreRequiredError,
  TURNKEY_BASE_NETWORK,
  TURNKEY_BASE_USDC,
} from '../dist/commerce/index.js'
import { FakeTurnkeyClient } from './fakeTurnkeyClient.mjs'

const RECIPIENT = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
const SENDER = '0x1111111111111111111111111111111111111a'
const ACTION = { network: TURNKEY_BASE_NETWORK, asset: TURNKEY_BASE_USDC, amount: '0.01', recipient: RECIPIENT, resource: null, sender: SENDER }

test('recoveryMode is honestly stable-payment-identity, not provider-idempotent or manual', () => {
  const executor = new TurnkeyCommerceExecutor({ turnkey: new FakeTurnkeyClient(), store: new InMemoryTurnkeyRequestStore() })
  assert.equal(executor.recoveryMode, 'stable-payment-identity')
  assert.equal(executor.id, 'turnkey-base-usdc')
})

test('constructing without a durable store fails fast, never silently defaults to volatile storage', () => {
  assert.throws(() => new TurnkeyCommerceExecutor({ turnkey: new FakeTurnkeyClient() }), TurnkeyStoreRequiredError)
})

test('prepare() makes no Turnkey call and requires action.sender', async () => {
  const turnkey = new FakeTurnkeyClient()
  const executor = new TurnkeyCommerceExecutor({ turnkey, store: new InMemoryTurnkeyRequestStore() })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  assert.equal(turnkey.sendTransactionCalls.length, 0, 'prepare() must not call sendTransaction')
  assert.equal(prepared.providerReference, null)

  await assert.rejects(() => executor.prepare({ clientSubmissionKey: 'attempt-2', action: { ...ACTION, sender: null } }), /action.sender is required/)
  await assert.rejects(() => executor.prepare({ clientSubmissionKey: 'attempt-3', action: { ...ACTION, network: 'eip155:1' } }), /only supports/)
})

test('submit() calls sendTransaction exactly once and attaches the durable provider reference', async () => {
  const turnkey = new FakeTurnkeyClient()
  const executor = new TurnkeyCommerceExecutor({ turnkey, store: new InMemoryTurnkeyRequestStore() })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })

  turnkey.onSendTransaction = (input, client) => {
    const id = 'sts_fixed'
    client.sends.set(id, { status: 'INCLUDED', txHash: '0x' + 'ab'.repeat(32) })
    return { sendTransactionStatusId: id }
  }
  const outcome = await executor.submit(prepared)
  assert.equal(turnkey.sendTransactionCalls.length, 1)
  assert.equal(outcome.status, 'transaction-known')
  assert.equal(outcome.transactionHash, '0x' + 'ab'.repeat(32))
  assert.equal(outcome.providerReference, 'turnkey:sts_fixed')
})

test('a BROADCASTING send is polled via getTransactionStatus, never resent via sendTransaction', async () => {
  const turnkey = new FakeTurnkeyClient()
  const executor = new TurnkeyCommerceExecutor({ turnkey, store: new InMemoryTurnkeyRequestStore() })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })

  const first = await executor.submit(prepared)
  assert.equal(first.status, 'submission-ambiguous')
  assert.match(first.reason, /BROADCASTING/)
  assert.equal(turnkey.sendTransactionCalls.length, 1)

  // The orchestrator would call resume() next, using ONLY clientSubmissionKey.
  const generic = { clientSubmissionKey: 'attempt-1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  const second = await executor.resume(generic)
  assert.equal(second.status, 'submission-ambiguous', 'still broadcasting -- resume() must poll, not resend')
  assert.equal(turnkey.sendTransactionCalls.length, 1, 'sendTransaction must never be called a second time')
  assert.equal(turnkey.getTransactionStatusCalls.length, 2, 'submit() and resume() each poll exactly once')

  // Turnkey later reports INCLUDED.
  const id = first.providerReference.replace('turnkey:', '')
  turnkey.sends.set(id, { status: 'INCLUDED', txHash: '0x' + 'cd'.repeat(32) })
  const third = await executor.resume(generic)
  assert.equal(third.status, 'transaction-known')
  assert.equal(turnkey.sendTransactionCalls.length, 1, 'sendTransaction must never be called a second time for this attempt, ever')
})

test('Turnkey FAILED is terminal, not endlessly retried as ambiguous', async () => {
  const turnkey = new FakeTurnkeyClient()
  turnkey.onSendTransaction = (input, client) => {
    const id = 'sts_failed'
    client.sends.set(id, { status: 'FAILED', error: { message: 'insufficient gas' } })
    return { sendTransactionStatusId: id }
  }
  const executor = new TurnkeyCommerceExecutor({ turnkey, store: new InMemoryTurnkeyRequestStore() })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'manual-recovery-required')
  assert.match(outcome.reason, /FAILED/)
  assert.match(outcome.reason, /insufficient gas/)
})

test('a lost response after sendTransaction succeeded is resumed from the durable store, not resent', async () => {
  const turnkey = new FakeTurnkeyClient()
  const store = new InMemoryTurnkeyRequestStore()
  turnkey.onSendTransaction = (input, client) => {
    const id = 'sts_stable'
    client.sends.set(id, { status: 'INCLUDED', txHash: '0x' + 'ef'.repeat(32) })
    return { sendTransactionStatusId: id }
  }
  const executor = new TurnkeyCommerceExecutor({ turnkey, store })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  await executor.submit(prepared)
  assert.equal(turnkey.sendTransactionCalls.length, 1)

  // Simulate "client restarted": a brand-new executor instance sharing only the durable store.
  const executor2 = new TurnkeyCommerceExecutor({ turnkey, store })
  const generic = { clientSubmissionKey: 'attempt-1', reference: { action: ACTION }, preparedAt: prepared.preparedAt }
  const resumed = await executor2.resume(generic)
  assert.equal(resumed.status, 'transaction-known')
  assert.equal(turnkey.sendTransactionCalls.length, 1, 'sendTransaction must never be called again after a restart')
})

test('a network drop between claiming the attempt and learning sendTransactionStatusId refuses to silently retry', async () => {
  const turnkey = new FakeTurnkeyClient()
  turnkey.onSendTransaction = () => {
    throw new Error('simulated network drop -- Turnkey may or may not have created a send')
  }
  const store = new InMemoryTurnkeyRequestStore()
  const executor = new TurnkeyCommerceExecutor({ turnkey, store })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  await assert.rejects(() => executor.submit(prepared))

  // Retrying submit() for the SAME clientSubmissionKey must not call sendTransaction again.
  turnkey.onSendTransaction = () => {
    throw new Error('sendTransaction must not be called a second time for this clientSubmissionKey')
  }
  await assert.rejects(() => executor.submit(prepared), TurnkeyAmbiguousSubmitError)
})

test('resume() with an already-confirmed prior transaction hash re-confirms on-chain and never re-sends', async () => {
  const knownTxHash = '0x' + '11'.repeat(32)
  const turnkey = new FakeTurnkeyClient()
  turnkey.onSendTransaction = () => {
    throw new Error('sendTransaction must not be called when a transaction hash is already known')
  }
  const fakePublicClient = { getTransactionReceipt: async ({ hash }) => (hash === knownTxHash ? { status: 'success' } : Promise.reject(new Error('not found'))) }
  const executor = new TurnkeyCommerceExecutor({ turnkey, store: new InMemoryTurnkeyRequestStore(), publicClient: fakePublicClient })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })

  const priorOutcome = { clientSubmissionKey: 'attempt-1', status: 'transaction-known', transactionHash: knownTxHash }
  const resumed = await executor.resume(prepared, priorOutcome)
  assert.equal(resumed.status, 'transaction-known')
  assert.equal(resumed.transactionHash, knownTxHash)
})

test('resume() with no Turnkey send on record honestly reports manual-recovery-required', async () => {
  const turnkey = new FakeTurnkeyClient()
  const executor = new TurnkeyCommerceExecutor({ turnkey, store: new InMemoryTurnkeyRequestStore() })
  const resumed = await executor.resume({ clientSubmissionKey: 'never-submitted', reference: { action: ACTION }, preparedAt: new Date().toISOString() })
  assert.equal(resumed.status, 'manual-recovery-required')
})
