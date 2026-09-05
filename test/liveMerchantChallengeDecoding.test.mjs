/** Regression test for a confirmed live D2.5A defect: X402BaseUsdcExecutor's
 * prepare() failed to decode a genuinely valid, byte-identical 402 challenge
 * from a real independent merchant (OneSource), aborting with "Payment-
 * Required header was not base64-encoded JSON" -- a message that reads like
 * a merchant-format problem but wasn't one.
 *
 * Root cause: x402Executor.ts's own base64ToUtf8() called `Buffer.from(...)`
 * -- a Node global, not a browser one. In a real browser (confirmed live:
 * `typeof Buffer !== 'undefined'` is false), that throws `ReferenceError:
 * Buffer is not defined`, which decodeChallenge()'s try/catch swallowed and
 * relabeled as the misleading "not base64-encoded JSON" error. Node's own
 * test runner defines `Buffer` globally, so this was invisible to every
 * existing Node-based test -- exactly the same class of bug as
 * browserFetchBinding.test.mjs, and exactly why this test must delete
 * `globalThis.Buffer` to actually reproduce it.
 *
 * Fixture: test/fixtures/onesource-live-payment-required-header.txt is the
 * EXACT byte-for-byte Payment-Required header value captured from a live
 * `GET https://api.onesource.io/api/chain/block-number` 402 response (and
 * independently confirmed byte-identical through the local operator's
 * same-origin proxy) -- not a hand-rebuilt approximation, so this test
 * cannot pass merely by matching whatever shape the fix's author assumed.
 * It carries TWO `accepts` entries (`exact` then `batch-settlement`) and a
 * large nested Bazaar extension block, exactly as OneSource sends it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { X402BaseUsdcExecutor, BASE_NETWORK, BASE_USDC, toClientEvmSigner } from '../dist/commerce/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LIVE_HEADER_VALUE = readFileSync(path.join(__dirname, 'fixtures', 'onesource-live-payment-required-header.txt'), 'utf8').trim()

// The real values OneSource's live challenge actually carries (decoded
// independently via Python's stdlib base64/json, not this package's own
// decoder, to avoid validating the fix against itself).
const LIVE_RECIPIENT = '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea'
const LIVE_ATOMIC_AMOUNT = '1000' // $0.001 at 6 decimals

test('X402BaseUsdcExecutor.prepare() decodes a real merchant 402 challenge with no `Buffer` global (real-browser condition)', async () => {
  // Node's own `fetch`/Response machinery (undici) lazily initializes
  // itself on first use and, at least in this Node version, that one-time
  // initialization itself needs `Buffer` to exist -- nothing to do with
  // this package's own code. Force that lazy init to happen now, while
  // Buffer still exists, so deleting it below reproduces ONLY the actual
  // bug under test (this package's own base64ToUtf8 calling `Buffer.from`)
  // rather than an unrelated Node runtime artifact.
  void new Response('warmup', { status: 200 })

  const realBuffer = globalThis.Buffer
  // Reproduce the actual failure condition: `Buffer` genuinely does not
  // exist in a browser. Node defines it globally, which is exactly why the
  // original bug was invisible to every existing test.
  // eslint-disable-next-line no-undef
  delete globalThis.Buffer
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url) !== 'https://merchant.example/onesource-like-thing') throw new Error(`unexpected fetch to ${url}`)
    return new Response(null, { status: 402, headers: { 'payment-required': LIVE_HEADER_VALUE } })
  }
  try {
    const signer = toClientEvmSigner(privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001'))
    const executor = new X402BaseUsdcExecutor({ signer })
    const context = {
      clientSubmissionKey: 'test-key',
      action: {
        network: BASE_NETWORK,
        asset: BASE_USDC,
        amount: '0.001',
        recipient: LIVE_RECIPIENT,
        resource: 'https://merchant.example/onesource-like-thing',
        sender: null,
      },
    }
    const prepared = await executor.prepare(context)
    assert.equal(prepared.clientSubmissionKey, 'test-key')
    assert.deepEqual(prepared.reference, {
      resourceUrl: 'https://merchant.example/onesource-like-thing',
      network: BASE_NETWORK,
      asset: BASE_USDC,
      atomicAmount: LIVE_ATOMIC_AMOUNT,
      recipient: LIVE_RECIPIENT,
    })
  } finally {
    globalThis.fetch = realFetch
    if (realBuffer !== undefined) globalThis.Buffer = realBuffer
  }
})

test('sanity: the live fixture really does carry two accepts entries and a Bazaar extension block, unmodified', () => {
  const decoded = JSON.parse(Buffer.from(LIVE_HEADER_VALUE, 'base64').toString('utf8'))
  assert.equal(decoded.x402Version, 2)
  assert.equal(decoded.accepts.length, 2)
  assert.equal(decoded.accepts[0].scheme, 'exact')
  assert.equal(decoded.accepts[1].scheme, 'batch-settlement')
  assert.equal(decoded.accepts[0].payTo, LIVE_RECIPIENT)
  assert.equal(decoded.accepts[0].amount, LIVE_ATOMIC_AMOUNT)
  assert.ok(decoded.extensions?.bazaar, 'fixture must retain the real Bazaar extension block')
})
