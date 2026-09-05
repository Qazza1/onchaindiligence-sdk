/** D2.5 Section 15 test #17: the x402 executor preserves authorization/
 * payment identity through resume — plus prepare()'s pre-signing validation
 * and submit()'s honest ambiguous-outcome handling.
 *
 * Fully offline: `fetch` is entirely faked (no real network, no real
 * facilitator); the viem account is a throwaway test private key used only
 * to sign an off-chain EIP-3009 authorization (no funds, no chain
 * interaction) via the real @x402/evm ExactEvmScheme + @x402/fetch
 * wrapFetchWithPayment — the exact same library calls
 * onchaindiligence-mcp's own proven D2.2A/D2.2B code uses.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'
import { X402BaseUsdcExecutor, BASE_NETWORK, BASE_USDC } from '../dist/commerce/index.js'

const TEST_ACCOUNT = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
const RESOURCE_URL = 'https://merchant.example/api/thing'
const RECIPIENT = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
const ATOMIC_AMOUNT = '10000' // $0.01 at 6 decimals

function base64utf8(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

function validChallenge(overrides = {}) {
  // `extra.name`/`extra.version` are the EIP-712 domain parameters for the
  // asset contract -- a real facilitator's challenge for USDC always
  // includes these (required by ExactEvmScheme.createPaymentPayload to sign
  // the transferWithAuthorization typed-data message); a fixture without
  // them fails signing, not settlement, so it must be present here too.
  return {
    x402Version: 2,
    accepts: [{ scheme: 'exact', network: BASE_NETWORK, asset: BASE_USDC, payTo: RECIPIENT, amount: ATOMIC_AMOUNT, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' }, ...overrides }],
  }
}

const ACTION = { network: BASE_NETWORK, asset: BASE_USDC, amount: '0.01', recipient: RECIPIENT, resource: RESOURCE_URL, sender: null }

test('prepare() validates the challenge and never signs/pays', async () => {
  let fetchCalls = 0
  const fakeFetch = async () => {
    fetchCalls++
    return new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  }
  const executor = new X402BaseUsdcExecutor({ account: TEST_ACCOUNT, fetch: fakeFetch })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  assert.equal(prepared.clientSubmissionKey, 'attempt-1')
  assert.equal(fetchCalls, 1, 'prepare() must make exactly one read-only probe request, never more')
})

test('prepare() rejects a challenge quoting the wrong recipient before any signing could occur', async () => {
  const fakeFetch = async () => new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge({ payTo: '0x1111111111111111111111111111111111111a' })) } })
  const executor = new X402BaseUsdcExecutor({ account: TEST_ACCOUNT, fetch: fakeFetch })
  await assert.rejects(() => executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION }), /recipient mismatch/)
})

test('prepare() rejects a challenge quoting a different amount', async () => {
  const fakeFetch = async () => new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge({ amount: '999999' })) } })
  const executor = new X402BaseUsdcExecutor({ account: TEST_ACCOUNT, fetch: fakeFetch })
  await assert.rejects(() => executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION }), /amount mismatch/)
})

test('submit() completes and extracts the transaction hash from the settlement response', async () => {
  const fakeTxHash = '0x' + 'ab'.repeat(32)
  const fakeFetch = async (url, init) => {
    const req = url instanceof Request ? url : new Request(url, init)
    if (req.headers.get('payment-signature')) {
      return new Response('{}', { status: 200, headers: { 'x-payment-response': base64utf8({ transaction: fakeTxHash }) } })
    }
    return new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  }
  const executor = new X402BaseUsdcExecutor({ account: TEST_ACCOUNT, fetch: fakeFetch })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'transaction-known')
  assert.equal(outcome.transactionHash, fakeTxHash)
})

test('submit() reports submission-ambiguous, never throws unrecoverably, when no response is received', async () => {
  const fakeFetch = async () => {
    throw new Error('simulated network drop')
  }
  const executor = new X402BaseUsdcExecutor({ account: TEST_ACCOUNT, fetch: fakeFetch })
  // Skip prepare()'s own probe (it would also throw) -- construct the
  // PrepareResult directly to isolate submit()'s own ambiguous-handling.
  const prepared = { clientSubmissionKey: 'attempt-1', reference: { resourceUrl: RESOURCE_URL, network: BASE_NETWORK, asset: BASE_USDC, atomicAmount: ATOMIC_AMOUNT, recipient: RECIPIENT }, preparedAt: new Date().toISOString() }
  const outcome = await executor.submit(prepared)
  assert.equal(outcome.status, 'submission-ambiguous')
  assert.ok(outcome.reason.length > 0)
})

test('D2.5 Section 15 #17: resume() preserves and re-confirms a known transaction hash without resubmitting', async () => {
  const knownTxHash = '0x' + 'cd'.repeat(32)
  let paidFetchCalls = 0
  const fakeFetch = async (url, init) => {
    const req = url instanceof Request ? url : new Request(url, init)
    if (req.headers.get('payment-signature')) paidFetchCalls++
    return new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  }
  const fakePublicClient = { getTransactionReceipt: async ({ hash }) => (hash === knownTxHash ? { status: 'success' } : Promise.reject(new Error('not found'))) }
  const executor = new X402BaseUsdcExecutor({ account: TEST_ACCOUNT, fetch: fakeFetch, publicClient: fakePublicClient })

  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  const priorOutcome = { clientSubmissionKey: 'attempt-1', status: 'transaction-known', transactionHash: knownTxHash }
  const resumed = await executor.resume(prepared, priorOutcome)

  assert.equal(resumed.status, 'transaction-known')
  assert.equal(resumed.transactionHash, knownTxHash, 'resume() must return the SAME transaction hash, never a new one')
  assert.equal(paidFetchCalls, 0, 'resume() must never attempt a new payment')
})

test('resume() with no prior transaction hash honestly reports manual-recovery-required', async () => {
  const fakeFetch = async () => new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  const executor = new X402BaseUsdcExecutor({ account: TEST_ACCOUNT, fetch: fakeFetch })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  const resumed = await executor.resume(prepared)
  assert.equal(resumed.status, 'manual-recovery-required')
  assert.equal(executor.recoveryMode, 'manual', 'this executor must honestly declare manual recovery, not a guarantee it cannot back up')
})

test('resume() reports ambiguous (not a fabricated failure) when the known hash is not yet found on-chain', async () => {
  const knownTxHash = '0x' + 'ef'.repeat(32)
  const fakeFetch = async () => new Response(null, { status: 402, headers: { 'payment-required': base64utf8(validChallenge()) } })
  const fakePublicClient = { getTransactionReceipt: async () => Promise.reject(new Error('not found')) }
  const executor = new X402BaseUsdcExecutor({ account: TEST_ACCOUNT, fetch: fakeFetch, publicClient: fakePublicClient })
  const prepared = await executor.prepare({ clientSubmissionKey: 'attempt-1', action: ACTION })
  const resumed = await executor.resume(prepared, { clientSubmissionKey: 'attempt-1', status: 'transaction-known', transactionHash: knownTxHash })
  assert.equal(resumed.status, 'submission-ambiguous', 'not-yet-found must stay ambiguous, never be reported as a definitive failure')
})
