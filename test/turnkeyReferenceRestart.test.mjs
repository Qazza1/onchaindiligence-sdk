// A process restart must never turn one approved reference payment into two payments.
// Offline only: fake OCD server, fake Turnkey client, no signing, no network, no money.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommerceClient, InMemoryRecoveryStore, TurnkeyCommerceExecutor, InMemoryTurnkeyRequestStore } from '../dist/commerce/index.js'
import { FileReferenceRunState, runReferencePayment, ReferenceRunMismatchError, ReferenceRunStateError } from '../scripts/turnkeyReferenceRun.mjs'
import { createFakeServer } from './fakeServer.mjs'
import { FakeTurnkeyClient } from './fakeTurnkeyClient.mjs'

const CFG = { wallet: '0x1111111111111111111111111111111111111111', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: '0x2222222222222222222222222222222222222222', amount: '0.001' }
const TX = '0x' + 'ab'.repeat(32)
const API_KEY_SENTINEL = 'ocd_SENTINEL_workspace_key_must_not_be_persisted'

function world(serverOptions = {}) {
  const server = createFakeServer(serverOptions)
  const recovery = new InMemoryRecoveryStore()
  const turnkey = new FakeTurnkeyClient()
  turnkey.onSendTransaction = (_input, fake) => { fake.sends.set('sts_1', { status: 'INCLUDED', txHash: TX }); return { sendTransactionStatusId: 'sts_1' } }
  const tkStore = new InMemoryTurnkeyRequestStore()
  const statePath = join(mkdtempSync(join(tmpdir(), 'ocd-ref-')), 'reference-run.json')
  const calls = []
  let failFinalizeOnce = false
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname; calls.push(`${init.method ?? 'GET'} ${path}`)
    if (failFinalizeOnce && path.endsWith('/finalize')) { failFinalizeOnce = false; throw new Error('process died before the finalize response') }
    return server.fetch(url, init)
  }
  return {
    server, turnkey, recovery, tkStore, statePath, calls,
    crashOnNextFinalize() { failFinalizeOnce = true },
    count: (needle) => calls.filter((c) => c === needle).length,
    /** A "restart": brand-new client/executor/state objects over the SAME durable stores. */
    run(cfg = CFG) {
      const client = createCommerceClient({ recovery, fetch, accountApiKey: API_KEY_SENTINEL })
      const executor = new TurnkeyCommerceExecutor({ turnkey, store: tkStore })
      return runReferencePayment({ cfg, client, executor, state: new FileReferenceRunState(statePath) })
    },
  }
}

test('1. a first run creates exactly one operation and records it before payment steps', async () => {
  const w = world(); const result = await w.run()
  assert.equal(result.kind, 'completed')
  assert.equal(w.count('POST /operations'), 1)
  const state = JSON.parse(readFileSync(w.statePath, 'utf8'))
  assert.equal(state.operationId, result.operationId); assert.equal(state.completedAt !== null, true)
  assert.equal(w.turnkey.sendTransactionCalls.length, 1)
  // Ordering: the state file exists by the time the paid preflight is requested.
  const w2 = world(); let existedAtPreflight = null
  const original = w2.server.fetch
  w2.server.fetch = async (url, init) => { if (new URL(url).pathname.endsWith('/preflight-payment')) existedAtPreflight = existsSync(w2.statePath); return original(url, init) }
  await w2.run(); assert.equal(existedAtPreflight, true, 'operation id is durably recorded before the paid preflight')
})

test('2. restart with the same configuration reuses the operation and opens nothing new', async () => {
  const w = world(); w.crashOnNextFinalize()
  await assert.rejects(w.run(), /process died/)
  const first = JSON.parse(readFileSync(w.statePath, 'utf8')).operationId
  const result = await w.run()
  assert.equal(result.operationId, first)
  assert.equal(w.count('POST /operations'), 1, 'still exactly one operation')
  assert.equal(w.server.stats().preflightAttempts, 1, 'the paid preflight ran once')
})

test('3. restart after the Turnkey submission never submits again', async () => {
  const w = world(); w.crashOnNextFinalize()
  await assert.rejects(w.run(), /process died/)
  assert.equal(w.turnkey.sendTransactionCalls.length, 1)
  const result = await w.run(); await w.run()
  assert.equal(result.kind, 'completed')
  assert.equal(w.turnkey.sendTransactionCalls.length, 1, 'Turnkey sendTransaction was called exactly once across all restarts')
  assert.equal(w.count('POST /operations'), 1)
})

test('3b. restart while Turnkey is still BROADCASTING polls the existing send, never resends', async () => {
  const w = world(); w.turnkey.onSendTransaction = null // default send stays BROADCASTING
  const first = await w.run()
  assert.equal(first.kind, 'execution-not-recorded')
  assert.equal(w.turnkey.sendTransactionCalls.length, 1)
  w.turnkey.sends.set('sts_1', { status: 'INCLUDED', txHash: TX })
  const second = await w.run()
  assert.equal(second.kind, 'completed')
  assert.equal(w.turnkey.sendTransactionCalls.length, 1, 'never resent')
  assert.equal(w.count('POST /operations'), 1)
})

test('4. restart while observation/finalization is pending continues recovery', async () => {
  const w = world({ simulateFinalizePendingOnce: true })
  const first = await w.run()
  assert.equal(first.kind, 'pending'); assert.equal(first.phase, 'observation-pending')
  assert.equal(JSON.parse(readFileSync(w.statePath, 'utf8')).completedAt, null)
  const second = await w.run()
  assert.equal(second.kind, 'completed'); assert.equal(second.operationId, first.operationId)
  assert.equal(w.count('POST /operations'), 1); assert.equal(w.turnkey.sendTransactionCalls.length, 1)
  assert.equal(w.server.stats().preflightAttempts, 1)
})

test('5. restart after completion reports completed and sends nothing; state is preserved as evidence', async () => {
  const w = world(); const done = await w.run()
  const before = w.calls.length
  const again = await w.run()
  assert.equal(again.kind, 'completed'); assert.equal(again.operationId, done.operationId); assert.equal(again.receiptId, done.receiptId)
  assert.equal(w.calls.length, before, 'no network call at all on a completed rerun')
  assert.equal(w.turnkey.sendTransactionCalls.length, 1)
  assert.ok(existsSync(w.statePath), 'state file is kept')
})

for (const [name, change] of [
  ['6. changed recipient', { recipient: '0x3333333333333333333333333333333333333333' }],
  ['7. changed amount', { amount: '0.002' }],
  ['8a. changed network', { network: 'eip155:1' }],
  ['8b. changed asset', { asset: '0x0000000000000000000000000000000000000001' }],
  ['8c. changed wallet', { wallet: '0x4444444444444444444444444444444444444444' }],
]) {
  test(`${name} fails closed before any network call`, async () => {
    const w = world({ simulateFinalizePendingOnce: true }); await w.run()
    const before = w.calls.length
    await assert.rejects(w.run({ ...CFG, ...change }), (err) => err instanceof ReferenceRunMismatchError && /different/.test(err.message) && /clear the reference-run state/.test(err.message))
    assert.equal(w.calls.length, before); assert.equal(w.turnkey.sendTransactionCalls.length, 1)
  })
}

test('equivalent formatting of the same configuration is not a mismatch', async () => {
  const w = world({ simulateFinalizePendingOnce: true }); await w.run()
  const result = await w.run({ ...CFG, amount: '0.0010', recipient: CFG.recipient.toUpperCase().replace('0X', '0x'), wallet: CFG.wallet })
  assert.equal(result.kind, 'completed'); assert.equal(w.count('POST /operations'), 1)
})

test('9. corrupted or malformed state fails closed', async () => {
  for (const bad of ['{ not json', '[]', JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, ...{ wallet: CFG.wallet, network: CFG.network, asset: CFG.asset, recipient: CFG.recipient, amount: '1000', operationId: 'nope', createdAt: 'x', completedAt: null, receiptId: null } }), JSON.stringify({ version: 1, wallet: CFG.wallet, network: CFG.network, asset: CFG.asset, recipient: CFG.recipient, amount: '1000', operationId: 'OCD-OP-abc', createdAt: 'x', completedAt: null, receiptId: null, recoveryCredential: 'smuggled' })]) {
    const w = world(); writeFileSync(w.statePath, bad)
    await assert.rejects(w.run(), ReferenceRunStateError)
    assert.equal(w.calls.length, 0, 'nothing sent'); assert.equal(w.turnkey.sendTransactionCalls.length, 0)
  }
})

test('a recorded run whose SDK recovery record is missing fails closed instead of opening a new operation', async () => {
  const w = world({ simulateFinalizePendingOnce: true }); await w.run()
  w.recovery = new InMemoryRecoveryStore() // simulate a lost recovery directory
  const client = createCommerceClient({ recovery: w.recovery, fetch: async (u, i) => { w.calls.push(`${i?.method ?? 'GET'} ${new URL(u).pathname}`); return w.server.fetch(u, i) } })
  const before = w.count('POST /operations')
  await assert.rejects(runReferencePayment({ cfg: CFG, client, executor: new TurnkeyCommerceExecutor({ turnkey: w.turnkey, store: w.tkStore }), state: new FileReferenceRunState(w.statePath) }), /recovery record could not be loaded/)
  assert.equal(w.count('POST /operations'), before); assert.equal(w.turnkey.sendTransactionCalls.length, 1)
})

test('10. no secret values are written to the reference-run state', async () => {
  const w = world(); await w.run()
  const text = readFileSync(w.statePath, 'utf8')
  const state = JSON.parse(text)
  assert.deepEqual(Object.keys(state).sort(), ['amount', 'asset', 'completedAt', 'createdAt', 'network', 'operationId', 'receiptId', 'recipient', 'version', 'wallet'])
  const record = await w.recovery.load(state.operationId)
  assert.ok(record.recoveryCredential, 'the recovery credential lives only in the SDK recovery store')
  for (const secret of [record.recoveryCredential, record.finalizationCapability, API_KEY_SENTINEL]) assert.equal(text.includes(secret), false)
  assert.doesNotMatch(text, /key|secret|credential|capability|token/i)
})
