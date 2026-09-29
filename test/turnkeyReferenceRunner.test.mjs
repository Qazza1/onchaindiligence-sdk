import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveRunMode, assertMayExecute, loadPaymentConfig } from '../scripts/turnkeyReferenceGuards.mjs'
import { createTurnkeyClient } from '../scripts/turnkeyClientAdapter.mjs'
import { probePreflightChallenge } from '../scripts/turnkeyPreflightProbe.mjs'
import { createCommerceClient, InMemoryRecoveryStore, TurnkeyCommerceExecutor, InMemoryTurnkeyRequestStore } from '../dist/commerce/index.js'
import { createFakeServer } from './fakeServer.mjs'

const CONFIG = { TURNKEY_REFERENCE_RECIPIENT: '0x2222222222222222222222222222222222222222', TURNKEY_REFERENCE_AMOUNT: '0.001', TURNKEY_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111' }

test('readiness is the default and cannot execute', () => {
  assert.equal(resolveRunMode({}), 'readiness')
  assert.throws(() => assertMayExecute(resolveRunMode({})), /TURNKEY_REFERENCE_EXECUTE=true/)
})

test('execution requires exactly TURNKEY_REFERENCE_EXECUTE=true', () => {
  for (const v of ['1', 'yes', 'TRUE', 'True', '', ' true']) assert.equal(resolveRunMode({ TURNKEY_REFERENCE_EXECUTE: v }), 'readiness', v)
  assert.equal(resolveRunMode({ TURNKEY_REFERENCE_EXECUTE: 'true' }), 'execute')
  assert.doesNotThrow(() => assertMayExecute('execute'))
})

test('recipient and amount come only from configuration', () => {
  assert.throws(() => loadPaymentConfig({ TURNKEY_WALLET_ADDRESS: CONFIG.TURNKEY_WALLET_ADDRESS }), /RECIPIENT[\s\S]*AMOUNT/)
  assert.equal(loadPaymentConfig(CONFIG).network, 'eip155:8453')
  assert.throws(() => loadPaymentConfig({ ...CONFIG, TURNKEY_REFERENCE_NETWORK: 'eip155:1' }), /Base mainnet/)
})

test('Turnkey adapter maps to ethSendTransaction calls[] and never reports unknown states as success', async () => {
  const seen = []
  const api = {
    ethSendTransaction: async (i) => { seen.push(i); return { sendTransactionStatusId: 'sts_1' } },
    getSendTransactionStatus: async () => ({ txStatus: 'SOMETHING_NEW' }),
  }
  const client = createTurnkeyClient(api)
  assert.deepEqual(await client.sendTransaction({ from: '0xa', to: '0xb', value: '0', data: '0xdead', caip2: 'eip155:8453' }), { sendTransactionStatusId: 'sts_1' })
  assert.deepEqual(seen[0], { from: '0xa', caip2: 'eip155:8453', calls: [{ to: '0xb', value: '0', data: '0xdead' }] })
  assert.equal((await client.getTransactionStatus('sts_1')).status, 'BROADCASTING')
})

test('finalize declares execution_provider turnkey for the Turnkey executor, not other', async () => {
  const server = createFakeServer(); let body = null
  const fetch = async (url, init = {}) => { if (String(url).endsWith('/finalize')) body = JSON.parse(init.body); return server.fetch(url, init) }
  const ACTION = { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1.00', sender: '0x1111111111111111111111111111111111111111', recipient: '0x2222222222222222222222222222222222222222' }
  const POLICY = { max_amount: '5.00', allowed_networks: null, allowed_assets: null, expected_recipient: null, allowed_resource_origins: null }
  const turnkey = { sendTransaction: async () => ({ sendTransactionStatusId: 'sts_1' }), getTransactionStatus: async () => ({ status: 'INCLUDED', txHash: '0x' + 'ab'.repeat(32) }) }
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch })
  const op = await client.open({ action: ACTION, policy: POLICY })
  await op.preflight()
  await op.execute({ executor: new TurnkeyCommerceExecutor({ turnkey, store: new InMemoryTurnkeyRequestStore() }) })
  await op.observeAndFinalize().catch(() => {})
  assert.ok(body, 'finalize was reached')
  assert.equal(body.execution_provider, 'turnkey')
})

test('execute mode wires x402 exactly like the proven executor: core client import, exact configured network', () => {
  const runner = readFileSync(new URL('../scripts/turnkey-reference-payment.mjs', import.meta.url), 'utf8')
  assert.match(runner, /const \{ wrapFetchWithPayment \} = await import\('@x402\/fetch'\)/)
  assert.match(runner, /const \{ x402Client \} = await import\('@x402\/core\/client'\)/)
  assert.ok(!runner.includes("{ wrapFetchWithPayment, x402Client }"), 'x402Client is not imported from @x402/fetch')
  assert.match(runner, /new x402Client\(\)\.register\(cfg\.network, new ExactEvmScheme\(toClientEvmSigner\(buyer\)\)\)/)
  assert.doesNotMatch(runner, /eip155:\*/)
})

test('readiness probe supplies operation headers and a valid preflight body, and no payment authorization', async () => {
  const seen = []
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response('{}', { status: 402 }) }
  const action = { kind: 'PAYMENT', network: 'eip155:8453' }; const policy = { max_amount: '0.001' }
  const result = await probePreflightChallenge({ endpoint: 'https://mcp.example/', operationId: 'OCD-OP-x', recoveryCredential: 'cred-x', action, policy, fetchImpl })
  assert.deepEqual(result, { status: 402, live: true })
  const { url, init } = seen[0]
  assert.equal(url, 'https://mcp.example/x402/lifecycle/preflight-payment')
  assert.equal(init.headers['x-ocd-operation-id'], 'OCD-OP-x'); assert.equal(init.headers['x-ocd-recovery-credential'], 'cred-x')
  assert.deepEqual(JSON.parse(init.body), { action, policy, options: {}, references: {}, publication: {} })
  const names = Object.keys(init.headers).map((h) => h.toLowerCase())
  assert.ok(!names.some((h) => h.includes('payment') || h === 'authorization'), 'no x402 payment authorization')
  const runner = readFileSync(new URL('../scripts/turnkey-reference-payment.mjs', import.meta.url), 'utf8')
  const readinessBody = runner.slice(runner.indexOf('async function readiness'), runner.indexOf('async function execute'))
  assert.match(readinessBody, /probePreflightChallenge\(/)
  assert.doesNotMatch(readinessBody, /OCD_PREFLIGHT_BUYER_KEY|wrapFetchWithPayment|TurnkeyCommerceExecutor|ethSendTransaction|sendTransaction/)
})
