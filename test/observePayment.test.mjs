import assert from 'node:assert/strict'
import test from 'node:test'
import { createCommerceClient, InMemoryRecoveryStore } from '../dist/commerce/index.js'

const TX = '0x' + 'AB'.repeat(32)
function receipt(overrides = {}) {
  return {
    schema: 'onchaindiligence.public-action-receipt.v1',
    receipt: {
      receipt_id: 'OCD-RCP-TEST-TEST-TEST-TEST', receipt_digest: 'sha256:x', receipt_type: 'COMMERCE', issued_at: '2026-09-28T00:00:00.000Z',
      action: { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '1', sender: null, recipient: null },
      decision: { status: 'UNKNOWN', authorized: null, reasons: [] },
      execution: { provider: null, status: 'CONFIRMED', transaction_hash: TX.toLowerCase(), submitted_at: null, confirmed_at: null },
      settlement: { status: 'CONFIRMED', detail: 'observed' }, checks: [], links: { preflight_receipt_id: null, agent_evidence_bundle_digest: null }, limitations: [],
      ...overrides,
    },
    proof: { signed: true },
  }
}
function client(status, body, headers = {}) {
  const calls = []
  const fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }) }
  return { calls, ocd: createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch }) }
}

test('observePayment posts only the existing /observe-payment contract and returns the signed receipt unchanged', async () => {
  const signed = receipt(); const { calls, ocd } = client(200, signed)
  const result = await ocd.observePayment({ network: 'eip155:8453', transactionReference: TX })
  assert.equal(result.kind, 'receipt'); assert.equal(result.existing, false); assert.deepEqual(result.receipt, signed)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://mcp.onchaindiligence.com/observe-payment')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { network: 'eip155:8453', transaction_hash: TX })
})

test('caller expectations are sent only when supplied, under the backend field names', async () => {
  const { calls, ocd } = client(200, receipt())
  await ocd.observePayment({ network: 'eip155:8453', transactionReference: TX, expected: { recipient: '0x' + '22'.repeat(20), amount: '1.50' } })
  assert.deepEqual(JSON.parse(calls[0].init.body), { network: 'eip155:8453', transaction_hash: TX, expected_recipient: '0x' + '22'.repeat(20), expected_amount: '1.50' })
})

test('a deduplicated observation is reported as existing', async () => {
  const { ocd } = client(200, receipt(), { 'x-ocd-existing-receipt': 'true' })
  assert.equal((await ocd.observePayment({ network: 'eip155:8453', transactionReference: TX })).existing, true)
})

test('not-found, not-yet-final, unavailable and rate-limited are pending, never failures', async () => {
  const cases = [
    [425, { error: 'not found', reason: 'transaction-not-found' }, 'transaction-not-found'],
    [425, { error: 'depth', reason: 'insufficient-confirmations' }, 'insufficient-confirmations'],
    [503, { error: 'rpc down', reason: 'rpc-unavailable' }, 'observation-unavailable'],
    [503, { error: 'signing unavailable' }, 'observation-unavailable'],
    [429, { error: 'slow down' }, 'rate-limited'],
  ]
  for (const [status, body, reason] of cases) {
    const { ocd } = client(status, body, { 'retry-after': '10' })
    const result = await ocd.observePayment({ network: 'eip155:8453', transactionReference: TX })
    assert.equal(result.kind, 'pending'); assert.equal(result.reason, reason); assert.equal(result.retryAfterSeconds, 10)
  }
})

test('invalid input is rejected with the backend message; unexpected errors throw', async () => {
  const rejected = await client(400, { error: 'settlement verification does not support network "eip155:10"' }).ocd.observePayment({ network: 'eip155:10', transactionReference: TX })
  assert.deepEqual(rejected, { kind: 'rejected', message: 'settlement verification does not support network "eip155:10"' })
  await assert.rejects(client(502, { error: 'boom' }).ocd.observePayment({ network: 'eip155:8453', transactionReference: TX }), /observe-payment failed: boom/)
})

test('a receipt for a different transaction or network is never returned as the requested one', async () => {
  const other = receipt({ execution: { ...receipt().receipt.execution, transaction_hash: '0x' + 'cd'.repeat(32) } })
  await assert.rejects(client(200, other).ocd.observePayment({ network: 'eip155:8453', transactionReference: TX }), /does not match/)
  await assert.rejects(client(200, receipt()).ocd.observePayment({ network: 'eip155:1', transactionReference: TX }), /does not match/)
  const solana = receipt({ action: { ...receipt().receipt.action, network: 'solana:mainnet' }, execution: { ...receipt().receipt.execution, transaction_hash: 'SigCase' } })
  await assert.rejects(client(200, solana).ocd.observePayment({ network: 'solana:mainnet', transactionReference: 'sigcase' }), /does not match/, 'Solana signatures compare case-sensitively')
})

test('supplied expectations are forwarded exactly, including empty strings; omitted ones stay omitted', async () => {
  for (const field of ['recipient', 'asset', 'amount']) {
    const { calls, ocd } = client(400, { error: `expected_${field} must be a non-empty string, or null` })
    const result = await ocd.observePayment({ network: 'eip155:8453', transactionReference: TX, expected: { [field]: '' } })
    assert.deepEqual(JSON.parse(calls[0].init.body), { network: 'eip155:8453', transaction_hash: TX, [`expected_${field}`]: '' }, `${field}: "" is not silently omitted`)
    assert.equal(result.kind, 'rejected')
  }
  const omitted = client(200, receipt())
  await omitted.ocd.observePayment({ network: 'eip155:8453', transactionReference: TX, expected: {} })
  assert.deepEqual(JSON.parse(omitted.calls[0].init.body), { network: 'eip155:8453', transaction_hash: TX })
  const exact = client(200, receipt())
  const values = { recipient: ' 0xAbC0000000000000000000000000000000000001', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1.500' }
  await exact.ocd.observePayment({ network: 'eip155:8453', transactionReference: TX, expected: values })
  const sent = JSON.parse(exact.calls[0].init.body)
  assert.equal(sent.expected_recipient, values.recipient); assert.equal(sent.expected_asset, values.asset); assert.equal(sent.expected_amount, values.amount)
})

test('Arc needs no client-side branch: it is forwarded like every other network and keeps UNKNOWN semantics', async () => {
  const ARC_TX = '0x' + '47'.repeat(32)
  const arc = receipt({
    action: { ...receipt().receipt.action, network: 'eip155:5042', asset: '0xfffffffffffffffffffffffffffffffffffffffe' },
    execution: { ...receipt().receipt.execution, transaction_hash: ARC_TX },
  })
  const { calls, ocd } = client(200, arc, { 'x-ocd-existing-receipt': 'true' })
  const result = await ocd.observePayment({ network: 'eip155:5042', transactionReference: ARC_TX })
  assert.equal(result.kind, 'receipt'); assert.equal(result.existing, true); assert.deepEqual(result.receipt, arc)
  assert.equal(result.receipt.receipt.decision.status, 'UNKNOWN'); assert.equal(result.receipt.receipt.decision.authorized, null)
  assert.equal(result.receipt.receipt.execution.provider, null); assert.equal(result.receipt.receipt.links.agent_evidence_bundle_digest, null)
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://mcp.onchaindiligence.com/observe-payment')
  assert.deepEqual(JSON.parse(calls[0].init.body), { network: 'eip155:5042', transaction_hash: ARC_TX })
  const pending = await client(425, { error: 'not final', reason: 'insufficient-confirmations' }, { 'retry-after': '10' }).ocd.observePayment({ network: 'eip155:5042', transactionReference: ARC_TX })
  assert.deepEqual(pending, { kind: 'pending', reason: 'insufficient-confirmations', message: 'not final', retryAfterSeconds: 10 })
  await assert.rejects(client(200, receipt()).ocd.observePayment({ network: 'eip155:5042', transactionReference: TX }), /does not match/, 'a Base receipt is never returned for an Arc request')
})

test('the observation client adds no wallet or execution method, and the README documents all five networks as observation-only', async () => {
  const ocd = client(200, receipt()).ocd
  for (const name of ['sendPayment', 'submitPayment', 'signTransaction', 'executePayment', 'createPaymentReceipt']) assert.equal(typeof ocd[name], 'undefined', name)
  const { readFileSync } = await import('node:fs')
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const id of ['eip155:8453', 'eip155:1', 'eip155:4217', 'eip155:5042', 'solana:mainnet']) assert.ok(readme.includes('`' + id + '`'), id)
  assert.match(readme, /Arc is observation-only here/); assert.match(readme, /native USDC system Transfer\s+stream at 18-decimal precision/)
  assert.match(readme, /not an ordinary ERC-20 token contract/)
})
