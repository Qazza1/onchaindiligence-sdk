// Provider-neutral x402 compatibility fixtures shaped like a Cloudflare Monetization Gateway 402.
// Local only: no network, no payment. Asserts OCD inspects the standard x402 v2 "exact" semantics
// and that provider/intermediary metadata neither enables nor strengthens anything.
import assert from 'node:assert/strict'
import test from 'node:test'
import { encodePaymentRequiredHeader, decodePaymentRequiredHeader } from '@x402/core/http'
import { withOcd } from '../dist/commerce/index.js'
import { decodeChallenge, validateChallenge, decimalToAtomic6 } from '../dist/commerce/x402Challenge.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAY_TO = '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea'
const RESOURCE = 'https://api.example-origin.test/v1/data'
const EXPECTED = { network: 'eip155:8453', asset: USDC, amount: decimalToAtomic6('0.01'), recipient: PAY_TO }

const accept = (over = {}) => ({ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' }, ...over })
const required = (over = {}, acceptOver = {}) => ({ x402Version: 2, resource: { url: RESOURCE, description: 'Paid API', mimeType: 'application/json' }, accepts: [accept(acceptOver)], ...over })
const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
const response402 = (header) => new Response('{}', { status: 402, headers: header === null ? {} : { 'payment-required': header } })

// --- hook driver (the buyer-side pre-signing path used by withOcd) ---
class HookClient { before = []; responses = []; onBeforePaymentCreation(h) { this.before.push(h); return this } onPaymentResponse(h) { this.responses.push(h); return this } }
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
function installFetch() {
  const original = globalThis.fetch; const calls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input); calls.push({ url, body: init.body ? String(init.body) : null })
    if (url.endsWith('/operations')) return json({ operation_id: 'op-1', recovery_credential: 'secret-1' })
    if (url.endsWith('/x402/lifecycle/preflight-payment')) {
      const decision = { status: 'ALLOW', authorized: true, reasons: [] }
      return json({ decision, checks: [], receipt: { schema: 'onchaindiligence.receipt-envelope.v1', receipt: { receipt_id: 'preflight-1', decision, links: {}, limitations: [] }, proof: { signed: true } }, finalization: { capability: 'cap-1', expires_at: '2030-01-01T00:00:00.000Z', endpoint: '/finalize' } })
    }
    if (url.includes('/execution-bindings')) return json({ execution_request_id: 'binding-1' })
    throw new Error(`unexpected fetch ${url}`)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}
/** Decodes the 402 header with the real @x402/core decoder, selects accepts[index], and runs the OCD pre-signing hook. */
async function runHook(header, index = 0) {
  const fake = installFetch()
  try {
    const client = new HookClient(); withOcd(client, { policy: { acknowledge_unconstrained: true }, onReceipt: () => {} })
    const paymentRequired = decodePaymentRequiredHeader(header)
    const outcome = await client.before[0]({ paymentRequired, selectedRequirements: paymentRequired.accepts[index] })
    const preflight = fake.calls.find((c) => c.url.endsWith('/x402/lifecycle/preflight-payment'))
    return { outcome, action: preflight ? JSON.parse(preflight.body).action : null, bodies: fake.calls.map((c) => c.body ?? '').join('\n'), urls: fake.calls.map((c) => c.url) }
  } finally { fake.restore() }
}
const EXPECTED_ACTION = { kind: 'PAYMENT', resource: RESOURCE, network: 'eip155:8453', asset: USDC, amount: '0.01', sender: null, recipient: PAY_TO }

test('A. Base / USDC / exact requirement: inspected with exact decimal/base-unit correctness on both paths', async () => {
  const header = encodePaymentRequiredHeader(required())
  validateChallenge(decodeChallenge(response402(header)), EXPECTED) // executor path
  const { outcome, action } = await runHook(header) // withOcd path
  assert.equal(outcome, undefined, 'ALLOW preflight lets signing proceed')
  assert.deepEqual(action, EXPECTED_ACTION)
  // Base-unit correctness: 6-decimal USDC, no floating point.
  assert.equal(decimalToAtomic6('0.01'), '10000')
  const small = await runHook(encodePaymentRequiredHeader(required({}, { amount: '1' })))
  assert.equal(small.action.amount, '0.000001')
  const large = await runHook(encodePaymentRequiredHeader(required({}, { amount: '123456789012' })))
  assert.equal(large.action.amount, '123456.789012')
})

test('B. same proposal without any Coinbase/Bazaar-specific metadata is inspected identically', async () => {
  const bare = required(); delete bare.resource.description; delete bare.resource.mimeType; delete bare.accepts[0].extra
  const header = encodePaymentRequiredHeader(bare)
  validateChallenge(decodeChallenge(response402(header)), EXPECTED)
  assert.deepEqual((await runHook(header)).action, EXPECTED_ACTION)
})

test('C. Cloudflare/intermediary metadata is carried but never trusted, forwarded or used to decide', async () => {
  const meta = { cloudflare: { gateway: 'monetization-gateway', zone: 'z-123', verified: true, trusted: true } }
  const withMeta = required({ extensions: meta }, { extra: { name: 'USD Coin', version: '2', ...meta } })
  withMeta.resource.url = 'https://shop.example-customer.test/v1/data'
  const header = encodePaymentRequiredHeader(withMeta)
  validateChallenge(decodeChallenge(response402(header)), EXPECTED)
  const result = await runHook(header)
  assert.deepEqual(result.action, { ...EXPECTED_ACTION, resource: 'https://shop.example-customer.test/v1/data' })
  assert.doesNotMatch(result.bodies, /cloudflare|gateway|trusted|verified/i, 'no intermediary metadata reaches OCD or the evidence')
  // Same proposal, different intermediary metadata: identical inspection (origin never changes the outcome).
  const other = await runHook(encodePaymentRequiredHeader(required({ extensions: { someFacilitator: { x: 1 } } })))
  assert.deepEqual({ ...other.action, resource: null }, { ...result.action, resource: null })
})

test('D. unknown optional fields are ignored without changing the inspected proposal', async () => {
  const header = encodePaymentRequiredHeader({ ...required({ futureTopLevel: { a: 1 }, error: 'payment required' }, { futureField: 'x', outputSchema: { type: 'object' } }) })
  validateChallenge(decodeChallenge(response402(header)), EXPECTED)
  assert.deepEqual((await runHook(header)).action, EXPECTED_ACTION)
})

test('E. malformed requirements fail closed', async () => {
  // Executor path: header problems and bad shapes throw before any signing.
  assert.throws(() => decodeChallenge(response402(null)), /no Payment-Required header/)
  assert.throws(() => decodeChallenge(response402('%%%not-base64%%%')), /not base64-encoded JSON/)
  assert.throws(() => decodeChallenge(response402(b64('just a string') + 'x')), /not base64-encoded JSON/)
  assert.throws(() => validateChallenge(required({ accepts: [] }), EXPECTED), /no accepts entry/)
  assert.throws(() => validateChallenge(required({}, { payTo: undefined }), EXPECTED), /recipient mismatch/)
  assert.throws(() => validateChallenge(required({}, { amount: 'abc' }), EXPECTED), /amount mismatch/)
  assert.throws(() => validateChallenge(required({}, { amount: '10000.0' }), EXPECTED), /amount mismatch/)
  assert.throws(() => validateChallenge(required({ x402Version: 1 }), EXPECTED), /unexpected x402 version/)
  // withOcd path: a non-integer amount or missing resource never reaches signing.
  for (const header of [b64(required({}, { amount: '1.5' })), b64(required({}, { amount: '-1' })), b64(required({}, { amount: 'abc' }))]) {
    const result = await runHook(header)
    assert.equal(result.outcome?.abort, true, 'malformed amount aborts before signing')
    assert.equal(result.urls.some((u) => u.endsWith('/x402/lifecycle/preflight-payment')), false, 'nothing is sent for preflight')
  }
  const noResource = required(); delete noResource.resource
  await assert.rejects(runHook(b64(noResource)), 'a requirement with no resource throws instead of proceeding')
})

test('F. unsupported schemes and out-of-scope assets are never converted into an inspected exact payment', async () => {
  for (const scheme of ['upto', 'deferred', 'subscription']) {
    const header = encodePaymentRequiredHeader(required({}, { scheme }))
    assert.throws(() => validateChallenge(decodeChallenge(response402(header)), EXPECTED), /unexpected scheme/)
    const result = await runHook(header)
    assert.equal(result.action, null, `${scheme} is not translated into an OCD payment action`)
    assert.deepEqual(result.urls, [], `${scheme}: no operation, preflight or receipt is created for it`)
  }
  // Out-of-scope network/asset: explicit abort with a stated reason.
  const wrongNetwork = await runHook(encodePaymentRequiredHeader(required({}, { network: 'eip155:137' })))
  assert.equal(wrongNetwork.outcome?.abort, true); assert.match(wrongNetwork.outcome.reason, /outside OCD independent-observation scope/)
  const wrongAsset = await runHook(encodePaymentRequiredHeader(required({}, { asset: '0x0000000000000000000000000000000000000001' })))
  assert.equal(wrongAsset.outcome?.abort, true)
})

test('multiple accepts: the hook inspects the selected entry; the executor validates only accepts[0] and fails closed otherwise', async () => {
  const header = encodePaymentRequiredHeader({ ...required(), accepts: [accept({ network: 'eip155:137' }), accept()] })
  assert.throws(() => validateChallenge(decodeChallenge(response402(header)), EXPECTED), /network mismatch/, 'never pays when the first entry differs')
  assert.deepEqual((await runHook(header, 1)).action, EXPECTED_ACTION)
})
