import assert from 'node:assert/strict'
import test from 'node:test'
import { withOcd, InMemoryRecoveryStore } from '../dist/commerce/index.js'

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TX = '0x' + 'ab'.repeat(32)

function envelope(status = 'ALLOW', id = 'r-1') {
  return {
    schema: 'onchaindiligence.receipt-envelope.v1',
    receipt: {
      receipt_id: id,
      receipt_digest: 'sha256:test',
      receipt_type: 'COMMERCE',
      issued_at: '2026-09-26T00:00:00.000Z',
      action: { kind: 'PAYMENT', resource: 'https://merchant.example/paid', network: 'eip155:8453', asset: BASE_USDC, amount: '0.01', sender: null, recipient: '0x0000000000000000000000000000000000000001' },
      decision: { status, authorized: status === 'ALLOW', reasons: [] },
      execution: { provider: null, status: 'CONFIRMED', transaction_hash: TX, submitted_at: null, confirmed_at: null },
      settlement: { status: 'CONFIRMED', detail: null },
      checks: [],
      links: { agent_evidence_bundle_digest: null, preflight_receipt_id: status === 'UNKNOWN' ? null : 'preflight-1' },
      limitations: [],
    },
    proof: { signed: true },
  }
}

class HookClient {
  before = []
  responses = []
  onBeforePaymentCreation(hook) { this.before.push(hook); return this }
  onPaymentResponse(hook) { this.responses.push(hook); return this }
}

function requirement(suffix = 'one', overrides = {}) {
  return { scheme: 'exact', network: 'eip155:8453', asset: BASE_USDC, amount: '10000', payTo: '0x0000000000000000000000000000000000000001', maxTimeoutSeconds: 60, extra: {}, ...overrides, suffix }
}

function context(requirements, version = 2, resource = 'https://merchant.example/paid') {
  return { paymentRequired: { x402Version: version, resource: { url: resource }, accepts: [requirements] }, selectedRequirements: requirements }
}

function response(requirements, settleResponse) {
  return { paymentPayload: { x402Version: 2, accepted: requirements, payload: {} }, requirements, settleResponse }
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function installOcdFetch({ decision = 'ALLOW', openFails = false, preflightFails = false, finalize = 'receipt', observeDelayMs = 0 } = {}) {
  const original = globalThis.fetch
  const calls = []
  let operations = 0
  let finalizeCalls = 0
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, method: init.method ?? 'GET', body: init.body })
    if (url.endsWith('/operations') && init.method === 'POST') {
      if (openFails) throw new Error('OCD unavailable')
      operations += 1
      return json({ operation_id: `op-${operations}`, recovery_credential: `secret-${operations}` })
    }
    if (url.endsWith('/x402/lifecycle/preflight-payment')) {
      if (preflightFails) throw new Error('preflight transport failure')
      return json({ decision: envelope(decision, `preflight-${operations}`).receipt.decision, checks: [], receipt: envelope(decision, `preflight-${operations}`), finalization: { capability: `cap-${operations}`, expires_at: '2030-01-01T00:00:00.000Z', endpoint: '/finalize' } })
    }
    if (url.includes('/execution-bindings') && init.method === 'POST') return json({ execution_request_id: `binding-${operations}` })
    if (url.endsWith('/finalize')) {
      finalizeCalls += 1
      if (finalize === 'pending' || (finalize === 'pending-once' && finalizeCalls === 1) || (finalize === 'pending-twice' && finalizeCalls <= 2) || (finalize === 'pending-then-terminal' && finalizeCalls === 1)) {
        return json({ error: 'not final' }, 425, { 'retry-after': '0.001' })
      }
      if (finalize === 'terminal' || finalize === 'pending-then-terminal') return json({ error: 'cannot finalize' }, 409)
      return json({ ...envelope('ALLOW', `commerce-${operations}`), ocd_lifecycle_evidence: null })
    }
    if (url.endsWith('/observe-payment')) {
      if (observeDelayMs) await new Promise((resolve) => setTimeout(resolve, observeDelayMs))
      return json(envelope('UNKNOWN', 'observation-only'))
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  return { calls, get finalizeCalls() { return finalizeCalls }, restore: () => { globalThis.fetch = original } }
}

async function flush(delay = 15) { await new Promise((resolve) => setTimeout(resolve, delay)) }

const policy = { acknowledge_unconstrained: true }

test('withOcd: allowed x402 v2 exact payment reaches a full lifecycle receipt without mutating the client response', async () => {
  const fake = installOcdFetch()
  try {
    const client = new HookClient()
    const received = []
    assert.equal(withOcd(client, { policy, onReceipt: (result) => received.push(result) }), client)
    const selected = requirement()
    const before = await client.before[0](context(selected))
    assert.equal(before, undefined)
    await client.responses[0](response(selected, { success: true, transaction: TX, network: 'eip155:8453', payer: '0xabc' }))
    await flush()
    assert.deepEqual(received.map((x) => x.kind), ['full-lifecycle'])
    assert.equal(received[0].operationId, 'op-1')
    const finalize = fake.calls.find((x) => x.url.endsWith('/finalize'))
    assert.equal(JSON.parse(finalize.body).execution_provider, 'x402')
  } finally { fake.restore() }
})

for (const decision of ['BLOCK', 'REQUIRE_APPROVAL', 'UNKNOWN']) {
  test(`withOcd: ${decision} aborts before x402 signing`, async () => {
    const fake = installOcdFetch({ decision })
    try {
      const client = new HookClient()
      const received = []
      withOcd(client, { policy, onReceipt: (result) => received.push(result) })
      const blocked = await client.before[0](context(requirement(decision)))
      assert.equal(blocked.abort, true)
      assert.match(blocked.reason, new RegExp(decision))
      await flush()
      assert.deepEqual(received.map((x) => x.kind), ['blocked'])
    } finally { fake.restore() }
  })
}

test('withOcd: a missing PAYMENT-RESPONSE produces no-receipt and no finalization', async () => {
  const fake = installOcdFetch()
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onReceipt: (result) => received.push(result) })
    const selected = requirement('missing')
    await client.before[0](context(selected))
    await client.responses[0](response(selected, undefined))
    await flush()
    assert.deepEqual(received.map((x) => x.kind), ['no-receipt'])
    assert.equal(received[0].reason, 'settlement-response-missing')
    assert.equal(fake.calls.some((x) => x.url.endsWith('/finalize')), false)
  } finally { fake.restore() }
})

test('withOcd: concurrent selected requirements stay correlated through their exact object identity', async () => {
  const fake = installOcdFetch()
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onReceipt: (result) => received.push(result) })
    const a = requirement('a'); const b = requirement('b')
    await Promise.all([client.before[0](context(a)), client.before[0](context(b))])
    await Promise.all([
      client.responses[0](response(a, { success: true, transaction: TX, network: 'eip155:8453' })),
      client.responses[0](response(b, { success: true, transaction: '0x' + 'cd'.repeat(32), network: 'eip155:8453' })),
    ])
    await flush()
    assert.equal(received.filter((x) => x.kind === 'full-lifecycle').length, 2)
  } finally { fake.restore() }
})

test('withOcd: OCD-origin requests are skipped to prevent paid-preflight recursion', async () => {
  const fake = installOcdFetch()
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onReceipt: (result) => received.push(result) })
    const selected = requirement('ocd')
    assert.equal(await client.before[0](context(selected, 2, 'https://mcp.onchaindiligence.com/x402/lifecycle/preflight-payment')), undefined)
    assert.equal(fake.calls.length, 0)
    assert.deepEqual(received, [])
  } finally { fake.restore() }
})

test('withOcd: v1 does not fabricate an OCD result', async () => {
  const fake = installOcdFetch()
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onReceipt: (result) => received.push(result) })
    assert.equal(await client.before[0](context(requirement('v1'), 1)), undefined)
    assert.equal(fake.calls.length, 0)
    assert.deepEqual(received, [])
  } finally { fake.restore() }
})

test('withOcd: unsupported asset fails closed before signing', async () => {
  const fake = installOcdFetch()
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onReceipt: (result) => received.push(result) })
    const blocked = await client.before[0](context(requirement('asset', { asset: '0x0000000000000000000000000000000000000002' })))
    assert.equal(blocked.abort, true)
    await flush()
    assert.equal(received[0].reason, 'unsupported-canonical-asset')
    assert.equal(fake.calls.length, 0)
  } finally { fake.restore() }
})

test('withOcd: open failure aborts by default', async () => {
  const fake = installOcdFetch({ openFails: true })
  try {
    const client = new HookClient()
    withOcd(client, { policy, onReceipt: () => {} })
    const blocked = await client.before[0](context(requirement('open-abort')))
    assert.equal(blocked.abort, true)
  } finally { fake.restore() }
})

test('withOcd: open failure plus proceed creates only existing observation-only evidence after a settled tx without delaying the payment hook', async () => {
  const fake = installOcdFetch({ openFails: true, observeDelayMs: 30 })
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onOcdUnavailable: 'proceed', onReceipt: (result) => received.push(result) })
    const selected = requirement('fallback')
    assert.equal(await client.before[0](context(selected)), undefined)
    await client.responses[0](response(selected, { success: true, transaction: TX, network: 'eip155:8453' }))
    assert.deepEqual(received, [], 'the payment response hook must not wait for /observe-payment')
    await flush(50)
    assert.deepEqual(received.map((x) => x.kind), ['post-payment-evidence'])
    assert.equal(fake.calls.filter((x) => x.url.endsWith('/observe-payment')).length, 1)
  } finally { fake.restore() }
})

test('withOcd: retries one pending finalization on the same operation and emits one full-lifecycle receipt', async () => {
  const fake = installOcdFetch({ finalize: 'pending-once' })
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onReceipt: (result) => received.push(result) })
    const selected = requirement('finalize-pending-once')
    await client.before[0](context(selected))
    await client.responses[0](response(selected, { success: true, transaction: TX, network: 'eip155:8453' }))
    await flush(40)
    assert.deepEqual(received.map((x) => x.kind), ['full-lifecycle'])
    assert.equal(fake.finalizeCalls, 2)
    assert.equal(fake.calls.filter((x) => x.url.endsWith('/execution-bindings')).length, 1)
    assert.equal(fake.calls.filter((x) => x.url.endsWith('/operations')).length, 1)
  } finally { fake.restore() }
})

test('withOcd: repeated pending finalization retries do not create another payment or binding', async () => {
  const fake = installOcdFetch({ finalize: 'pending-twice' })
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onReceipt: (result) => received.push(result) })
    const selected = requirement('finalize-pending-twice')
    await client.before[0](context(selected))
    await client.responses[0](response(selected, { success: true, transaction: TX, network: 'eip155:8453' }))
    await flush(50)
    assert.deepEqual(received.map((x) => x.kind), ['full-lifecycle'])
    assert.equal(fake.finalizeCalls, 3)
    assert.equal(fake.calls.filter((x) => x.url.endsWith('/execution-bindings')).length, 1)
    assert.equal(fake.calls.filter((x) => x.url.endsWith('/operations')).length, 1)
  } finally { fake.restore() }
})

test('withOcd: a terminal finalization error emits no-receipt with its operation id', async () => {
  const fake = installOcdFetch({ finalize: 'terminal' })
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onReceipt: (result) => received.push(result) })
    const selected = requirement('finalize-terminal')
    await client.before[0](context(selected))
    await client.responses[0](response(selected, { success: true, transaction: TX, network: 'eip155:8453' }))
    await flush()
    assert.deepEqual(received, [{ kind: 'no-receipt', reason: 'finalization-terminal-error', operationId: 'op-1' }])
  } finally { fake.restore() }
})

test('withOcd: Solana canonical USDC comparison is exact and case-sensitive', async () => {
  const fake = installOcdFetch()
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onReceipt: (result) => received.push(result) })
    const canonical = requirement('solana-canonical', {
      network: 'solana:mainnet',
      asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    })
    assert.equal(await client.before[0](context(canonical)), undefined)
    await client.responses[0](response(canonical, { success: false, transaction: '', network: 'solana:mainnet' }))
    const mutated = requirement('solana-mutated', {
      network: 'solana:mainnet',
      asset: 'epjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    })
    const blocked = await client.before[0](context(mutated))
    assert.equal(blocked.abort, true)
    await flush()
    assert.ok(received.some((result) => result.kind === 'no-receipt' && result.reason === 'unsupported-canonical-asset'))
  } finally { fake.restore() }
})

test('withOcd: a preflight attempt that remains pending never invokes observation-only fallback', async () => {
  const fake = installOcdFetch({ preflightFails: true })
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onOcdUnavailable: 'proceed', onReceipt: (result) => received.push(result) })
    const selected = requirement('preflight-error')
    const blocked = await client.before[0](context(selected))
    assert.equal(blocked.abort, true)
    await flush()
    assert.equal(received[0].reason, 'preflight-not-ready')
    assert.equal(fake.calls.filter((x) => x.url.endsWith('/observe-payment')).length, 0)
  } finally { fake.restore() }
})

test('withOcd: payment failure never creates a receipt', async () => {
  const fake = installOcdFetch()
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onReceipt: (result) => received.push(result) })
    const selected = requirement('failed')
    await client.before[0](context(selected))
    await client.responses[0](response(selected, { success: false, transaction: '', network: 'eip155:8453' }))
    await flush()
    assert.equal(received[0].reason, 'payment-failed')
  } finally { fake.restore() }
})

test('withOcd: a pending finalization preserves the supplied recovery record before a later terminal result', async () => {
  const fake = installOcdFetch({ finalize: 'pending-then-terminal' })
  try {
    const store = new InMemoryRecoveryStore(); const client = new HookClient(); const received = []
    withOcd(client, { policy, store, onReceipt: (result) => received.push(result) })
    const selected = requirement('pending')
    await client.before[0](context(selected))
    await client.responses[0](response(selected, { success: true, transaction: TX, network: 'eip155:8453' }))
    await flush(40)
    assert.deepEqual(received, [{ kind: 'no-receipt', reason: 'finalization-terminal-error', operationId: 'op-1' }])
    const record = await store.load('op-1')
    assert.equal(record.transactionHash, TX)
  } finally { fake.restore() }
})

test('withOcd: receipt delivery fires once for repeated response-hook delivery', async () => {
  const fake = installOcdFetch()
  try {
    const client = new HookClient(); const received = []
    withOcd(client, { policy, onReceipt: (result) => received.push(result) })
    const selected = requirement('once')
    await client.before[0](context(selected))
    const settled = response(selected, { success: true, transaction: TX, network: 'eip155:8453' })
    await client.responses[0](settled)
    await client.responses[0](settled)
    await flush()
    assert.equal(received.filter((x) => x.kind === 'full-lifecycle').length, 1)
  } finally { fake.restore() }
})
