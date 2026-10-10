// Company onboarding v1: workspace attribution and fee-transport setup for withOcd().
// Local only: no network, no real signing, no payment.
import assert from 'node:assert/strict'
import test from 'node:test'
import { x402Client } from '@x402/core/client'
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http'
import { wrapFetchWithPayment } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withOcd, createCommerceClient, InMemoryRecoveryStore } from '../dist/commerce/index.js'
import { NodeFileRecoveryStore } from '../dist/commerce/node.js'

const OCD = 'https://mcp.onchaindiligence.com'
const MERCHANT = 'https://merchant.example/paid'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAY_TO = '0x0000000000000000000000000000000000000001'
const OCD_PAY_TO = '0x63c347d7e42b940e79afec3d172bfc2921b6c897'
const TX = '0x' + 'ab'.repeat(32)
const KEY = 'ocd_test_workspace_key_do_not_leak'
const policy = { acknowledge_unconstrained: true }

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
const decision = { status: 'ALLOW', authorized: true, reasons: [] }
const receipt = (id, type = 'COMMERCE') => ({
  schema: 'onchaindiligence.receipt-envelope.v1',
  receipt: { receipt_id: id, receipt_type: type, decision, execution: { status: 'CONFIRMED', transaction_hash: TX }, settlement: { status: 'CONFIRMED', detail: null }, checks: [], links: {}, limitations: [] },
  proof: { signed: true },
})
const accepts = (payTo, amount, resource) => ({
  x402Version: 2,
  resource: { url: resource },
  accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: USDC, amount, payTo, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
})

/** Routes OCD and a merchant. `ownership` controls GET /me/operations/:id. */
function world({ ownership = 'owned', feeRequired = false } = {}) {
  const calls = []
  let operations = 0
  const fetch = async (input, init = {}) => {
    // @x402/fetch retries with a Request object; plain callers pass a string.
    const isRequest = typeof input === 'object' && input !== null && 'url' in input
    const url = new URL(isRequest ? input.url : String(input))
    const headers = new Headers(isRequest ? input.headers : init.headers)
    const method = isRequest ? input.method : init.method ?? 'GET'
    const body = isRequest ? await input.clone().text() : init.body ? String(init.body) : null
    calls.push({ origin: url.origin, path: url.pathname, method, headers, body: body || null })
    if (url.origin === 'https://merchant.example') {
      if (!headers.has('payment-signature')) return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(accepts(PAY_TO, '10000', MERCHANT)) } })
      return new Response('merchant-ok', { status: 200, headers: { 'payment-response': encodePaymentResponseHeader({ success: true, transaction: TX, network: 'eip155:8453', payer: '0x' + '2'.repeat(40) }) } })
    }
    if (url.pathname === '/operations' && method === 'POST') { operations += 1; return json({ operation_id: `op-${operations}`, recovery_credential: `secret-${operations}` }, 201) }
    if (url.pathname.startsWith('/me/operations/')) {
      if (ownership === 'unreachable') throw new Error('network down')
      return ownership === 'owned' ? json({ operation_id: 'op-1' }) : json({ error: 'missing or invalid account API key' }, 401)
    }
    if (url.pathname === '/x402/lifecycle/preflight-payment') {
      if (feeRequired && !headers.has('payment-signature')) {
        return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(accepts(OCD_PAY_TO, '10000', `${OCD}/x402/lifecycle/preflight-payment`)) } })
      }
      return json({ decision, checks: [], receipt: receipt('preflight-1', 'PREFLIGHT'), finalization: { capability: 'cap-1', expires_at: '2030-01-01T00:00:00.000Z', endpoint: '/finalize' } })
    }
    if (url.pathname.includes('/execution-bindings')) return json({ execution_request_id: 'binding-1' })
    if (url.pathname.endsWith('/finalize')) return json({ ...receipt('commerce-1'), ocd_lifecycle_evidence: null })
    if (url.pathname === '/observe-payment') return json(receipt('observation-only'))
    throw new Error(`unexpected fetch ${url}`)
  }
  return { fetch, calls, get operations() { return operations } }
}

class HookClient {
  before = []
  responses = []
  onBeforePaymentCreation(hook) { this.before.push(hook); return this }
  onPaymentResponse(hook) { this.responses.push(hook); return this }
}
const requirement = () => ({ scheme: 'exact', network: 'eip155:8453', asset: USDC, amount: '10000', payTo: PAY_TO, maxTimeoutSeconds: 60, extra: {} })
const ctx = (r) => ({ paymentRequired: { x402Version: 2, resource: { url: MERCHANT }, accepts: [r] }, selectedRequirements: r })
const settled = (r) => ({ paymentPayload: { x402Version: 2, accepted: r, payload: {} }, requirements: r, settleResponse: { success: true, transaction: TX } })
const until = async (predicate, ms = 1500) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)) } }

test('withOcd forwards accountApiKey: key only on operation creation and one ownership read, never stored or sent elsewhere', async () => {
  const w = world(); const store = new InMemoryRecoveryStore(); const received = []
  const client = new HookClient()
  withOcd(client, { policy, ocdFetch: w.fetch, store, accountApiKey: ` ${KEY} `, onReceipt: (r) => received.push(r) })
  const r = requirement()
  assert.equal(await client.before[0](ctx(r)), undefined)
  await client.responses[0](settled(r))
  await until(() => received.length === 1)
  assert.equal(received[0].kind, 'full-lifecycle')
  assert.equal(received[0].operationId, 'op-1')

  const withKey = w.calls.filter((c) => c.headers.get('authorization') === `Bearer ${KEY}`)
  assert.deepEqual(withKey.map((c) => `${c.method} ${c.path}`), ['POST /operations', 'GET /me/operations/op-1'])
  assert.deepEqual(JSON.parse(w.calls.find((c) => c.path === '/operations').body), { client_source: 'sdk' })
  assert.ok(w.calls.findIndex((c) => c.path.startsWith('/me/operations/')) < w.calls.findIndex((c) => c.path === '/x402/lifecycle/preflight-payment'), 'ownership is confirmed BEFORE the paid preflight')
  for (const c of w.calls.filter((x) => !withKey.includes(x))) {
    assert.equal(JSON.stringify([...c.headers]).includes(KEY), false, `${c.path} must not carry the workspace key`)
    assert.equal(String(c.body).includes(KEY), false)
  }
  assert.equal(JSON.stringify(await store.load('op-1')).includes(KEY), false, 'the key never enters recovery storage')
})

test('withOcd without accountApiKey is unchanged: anonymous creation and no ownership read', async () => {
  const w = world(); const received = []
  const client = new HookClient()
  withOcd(client, { policy, ocdFetch: w.fetch, onReceipt: (r) => received.push(r) })
  const r = requirement()
  assert.equal(await client.before[0](ctx(r)), undefined)
  await client.responses[0](settled(r))
  await until(() => received.length === 1)
  assert.equal(w.calls.some((c) => c.path.startsWith('/me/')), false)
  assert.equal(w.calls.find((c) => c.path === '/operations').headers.has('authorization'), false, 'creation is anonymous')
  assert.equal(w.calls.some((c) => c.headers.get('authorization')?.includes('ocd_')), false)
})

test('withOcd aborts before the paid preflight when the workspace key does not own the new operation', async () => {
  const w = world({ ownership: 'rejected', feeRequired: true }); const received = []
  const client = new HookClient()
  withOcd(client, { policy, ocdFetch: w.fetch, accountApiKey: KEY, onReceipt: (r) => received.push(r) })
  const outcome = await client.before[0](ctx(requirement()))
  assert.equal(outcome.abort, true)
  assert.match(outcome.reason, /did not confirm ownership/)
  assert.match(outcome.reason, /no preflight fee was spent/)
  assert.equal(w.calls.some((c) => c.path === '/x402/lifecycle/preflight-payment'), false, 'no preflight request, so no fee')
  assert.equal(w.calls.some((c) => c.path.includes('/execution-bindings')), false)
  await until(() => received.length === 1)
  assert.deepEqual(received[0], { kind: 'no-receipt', reason: 'workspace-ownership-not-confirmed', operationId: 'op-1' })
})

test('withOcd treats an unreachable ownership read like an unavailable OCD: abort by default, narrow fallback on request', async () => {
  const aborting = world({ ownership: 'unreachable' }); const clientA = new HookClient(); const receivedA = []
  withOcd(clientA, { policy, ocdFetch: aborting.fetch, accountApiKey: KEY, onReceipt: (r) => receivedA.push(r) })
  assert.equal((await clientA.before[0](ctx(requirement()))).abort, true)
  assert.equal(aborting.calls.some((c) => c.path === '/x402/lifecycle/preflight-payment'), false)

  const proceeding = world({ ownership: 'unreachable' }); const clientP = new HookClient(); const receivedP = []
  withOcd(clientP, { policy, ocdFetch: proceeding.fetch, accountApiKey: KEY, onOcdUnavailable: 'proceed', onReceipt: (r) => receivedP.push(r) })
  const r = requirement()
  assert.equal(await clientP.before[0](ctx(r)), undefined)
  await clientP.responses[0](settled(r))
  await until(() => receivedP.length === 1)
  assert.equal(receivedP[0].kind, 'post-payment-evidence', 'observation-only evidence, never a full lifecycle')
  assert.equal(proceeding.calls.some((c) => c.path === '/x402/lifecycle/preflight-payment'), false)
})

test('one existing x402 client pays both OCD\'s preflight fee and the merchant: one signer, no recursive preflight', async () => {
  const w = world({ feeRequired: true }); const received = []
  const signed = []
  // A throwaway local key: the real exact-EVM scheme signs EIP-3009 offline. No RPC, no funds, no payment.
  const scheme = new ExactEvmScheme(privateKeyToAccount(generatePrivateKey()))
  const createPaymentPayload = scheme.createPaymentPayload.bind(scheme)
  scheme.createPaymentPayload = async (version, requirements, context) => {
    signed.push({ payTo: requirements.payTo, amount: requirements.amount })
    return createPaymentPayload(version, requirements, context)
  }
  const client = new x402Client().register('eip155:8453', scheme)
  withOcd(client, { policy, accountApiKey: KEY, onReceipt: (r) => received.push(r), ocdFetch: wrapFetchWithPayment(w.fetch, client) })

  const response = await wrapFetchWithPayment(w.fetch, client)(MERCHANT)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'merchant-ok')
  await until(() => received.length === 1)

  assert.deepEqual(signed.map((s) => s.payTo.toLowerCase()), [OCD_PAY_TO, PAY_TO], 'the same signer paid OCD\'s fee first, then the merchant')
  assert.equal(w.operations, 1, 'paying OCD\'s own challenge did not open a second operation')
  assert.equal(received[0].kind, 'full-lifecycle')
  const feeCall = w.calls.find((c) => c.path === '/x402/lifecycle/preflight-payment' && c.headers.has('payment-signature'))
  assert.ok(feeCall, 'the paid preflight request carried a payment signature')
  const merchantPaid = w.calls.findIndex((c) => c.origin === 'https://merchant.example' && c.headers.has('payment-signature'))
  assert.ok(w.calls.indexOf(feeCall) < merchantPaid, 'OCD preflight completed before the merchant payment was signed')
})

test('withOcd with NodeFileRecoveryStore leaves a durable record a restarted process can load and keep finalizing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ocd-withocd-recovery-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const w = world(); const received = []
  const client = new HookClient()
  withOcd(client, { policy, ocdFetch: w.fetch, store: new NodeFileRecoveryStore(dir), accountApiKey: KEY, onReceipt: (r) => received.push(r) })
  const r = requirement()
  assert.equal(await client.before[0](ctx(r)), undefined)
  await client.responses[0](settled(r))
  await until(() => received.length === 1)

  // "Restart": a brand-new store and client over the same directory.
  const restarted = createCommerceClient({ endpoint: OCD, recovery: new NodeFileRecoveryStore(dir), fetch: w.fetch })
  const op = await restarted.load('op-1')
  assert.ok(op, 'the operation survives a process restart')
  const record = await new NodeFileRecoveryStore(dir).load('op-1')
  assert.equal(record.transactionHash, TX)
  assert.equal(record.preflightReceiptId, 'preflight-1')
  assert.equal(JSON.stringify(record).includes(KEY), false)
  const again = await op.observeAndFinalize()
  assert.equal(again.kind, 'receipt-produced', 'finalization is repeatable from the durable record, with no new operation')
  assert.equal(w.operations, 1)
  assert.equal(w.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/execution-bindings')).length, 1, 'no second execution binding')
})
