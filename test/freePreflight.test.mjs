import assert from 'node:assert/strict'
import test from 'node:test'
import { createCommerceClient, InMemoryRecoveryStore, MockCommerceExecutor } from '../dist/commerce/index.js'
import { createFakeServer } from './fakeServer.mjs'

const KEY = 'ocd_' + 'k'.repeat(43)
const BASE = { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '0.001', sender: null, recipient: '0x' + '2'.repeat(40) }
const SOLANA = { ...BASE, network: 'solana:mainnet', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', recipient: '11111111111111111111111111111112' }
const policy = { max_amount: '0.01' }

function fixture({ failure, server = createFakeServer(), recovery = new InMemoryRecoveryStore() } = {}) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname, headers = new Headers(init.headers)
    calls.push(path)
    if (path.endsWith('/preflight/free')) {
      const operationId = path.split('/')[2]
      const saved = await recovery.load(operationId)
      assert.equal(saved.preflightMode, 'free')
      assert.equal(headers.get('x-ocd-recovery-credential'), saved.recoveryCredential, 'credential durable before request')
      assert.equal(headers.get('authorization'), `Bearer ${KEY}`)
      assert.equal(JSON.stringify(saved).includes(KEY), false)
      if (failure) return failure()
      // Contract adapter only: existing fixture retains its input dedupe and signed-result shape.
      return server.fetch('https://fixture/x402/lifecycle/preflight-payment', init)
    }
    assert.equal(path.includes('/x402/'), false, 'free client must not call the paid route')
    if (path !== '/operations') assert.equal(headers.has('authorization'), false)
    return server.fetch(url, init)
  }
  const client = createCommerceClient({ accountApiKey: KEY, preflightMode: 'free', recovery, fetch })
  return { client, calls, recovery, server }
}

for (const action of [BASE, SOLANA]) test(`free ${action.network}: exact contract, persisted recovery, same-operation replay`, async () => {
  const f = fixture(), op = await f.client.open({ action, policy })
  const first = await op.preflight(), repeat = await op.preflight()
  assert.equal(first.kind, 'ready')
  assert.equal(first.receipt.receipt.action.network, action.network)
  assert.equal(first.receipt.receipt.action.asset, action.asset)
  assert.equal(repeat.receipt.receipt.receipt_id, first.receipt.receipt.receipt_id)
  assert.equal(f.calls.filter(p => p === '/operations').length, 1)
  const resumed = await f.client.open({ operationId: op.operationId, action, policy })
  assert.equal((await resumed.preflight()).receipt.receipt.receipt_id, first.receipt.receipt.receipt_id)
})

test('free mode requires key before any network, and rejects mode switching after restart', async () => {
  assert.throws(() => createCommerceClient({ preflightMode: 'free', recovery: new InMemoryRecoveryStore() }), /workspace API key/)
  const f = fixture(), op = await f.client.open({ action: BASE, policy })
  const paid = createCommerceClient({ recovery: f.recovery, fetch: () => { throw new Error('must not send') } })
  const resumed = await paid.open({ operationId: op.operationId, action: BASE, policy })
  assert.equal((await resumed.preflight()).error, 'preflight_mode_conflict')
})

for (const [status, error, kind] of [[429, 'free_allowance_exhausted', 'terminal-error'], [503, 'free_preflight_disabled', 'terminal-error'], [503, 'free_preflight_unavailable', 'pending'], [404, 'not_found', 'terminal-error'], [401, 'unauthorized', 'terminal-error'], [402, 'payment_required', 'terminal-error'], [409, 'preflight_input_conflict', 'terminal-error']]) {
  test(`free ${error}: no fallback or merchant execution`, async () => {
    const f = fixture({ failure: () => new Response(JSON.stringify({ error, reset_at: '2026-11-01T00:00:00.000Z', paid_fallback: false }), { status }) })
    const op = await f.client.open({ action: BASE, policy }), result = await op.preflight()
    assert.equal(result.kind, kind)
    if (kind === 'pending') assert.equal(result.mayAlreadyHavePaid, false)
    if (status === 429) { assert.equal(result.paidFallback, false); assert.equal(result.resetAt, '2026-11-01T00:00:00.000Z') }
    let sends = 0
    await assert.rejects(() => op.execute({ executor: { prepare: () => { sends++; throw new Error('must not execute') } } }))
    assert.equal(sends, 0)
    assert.equal(f.calls.filter(p => p.endsWith('/preflight/free')).length, 1)
  })
}

test('free timeout retries the same persisted operation; BLOCK prevents executor dispatch', async () => {
  const f = fixture({ failure: () => { throw new Error('response lost') } })
  const op = await f.client.open({ action: BASE, policy })
  const result = await op.preflight()
  assert.equal(result.kind, 'pending'); assert.equal(result.mayAlreadyHavePaid, false)
  await op.preflight()
  assert.equal(f.calls.filter(p => p === '/operations').length, 1)
  const blocked = fixture(), blockedOp = await blocked.client.open({ action: BASE, policy: { max_amount: '0' } })
  assert.equal((await blockedOp.preflight()).kind, 'blocked')
  await assert.rejects(() => blockedOp.execute({ executor: new MockCommerceExecutor() }), /not ALLOW/)
})
