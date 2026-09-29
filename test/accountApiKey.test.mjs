import assert from 'node:assert/strict'
import test from 'node:test'
import { createCommerceClient, InMemoryRecoveryStore } from '../dist/commerce/index.js'
import { createFakeServer } from './fakeServer.mjs'

const KEY = 'ocd_test_workspace_key_do_not_leak'
const ACTION = { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1.00', sender: null, recipient: '0x2222222222222222222222222222222222222222' }
const POLICY = { max_amount: '5.00', allowed_networks: null, allowed_assets: null, expected_recipient: null, allowed_resource_origins: null }

function spy() {
  const server = createFakeServer(); const calls = []
  const fetch = async (url, init = {}) => { calls.push({ path: new URL(url).pathname, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body }); return server.fetch(url, init) }
  return { fetch, calls }
}

test('accountApiKey is sent on POST /operations only, with the SDK source marker', async () => {
  const { fetch, calls } = spy(); const recovery = new InMemoryRecoveryStore()
  const client = createCommerceClient({ accountApiKey: KEY, recovery, fetch })
  const op = await client.open({ action: ACTION, policy: POLICY })
  const create = calls.find((c) => c.path === '/operations' && c.method === 'POST')
  assert.equal(create.headers.authorization, `Bearer ${KEY}`)
  assert.deepEqual(JSON.parse(create.body), { client_source: 'sdk' })
  await op.preflight().catch(() => {})
  await client.getReceipt('OCD-RCP-AAAA-BBBB-CCCC-DDDD').catch(() => {})
  await client.verifyReceipt({}).catch(() => {})
  const others = calls.filter((c) => c !== create)
  assert.ok(others.length >= 2)
  for (const c of others) assert.equal(JSON.stringify(c.headers).includes(KEY), false, `${c.path} must not carry the workspace key`)
  // The key never enters recovery storage.
  assert.equal(JSON.stringify(await recovery.load(op.operationId)).includes(KEY), false)
})

test('without accountApiKey creation is anonymous (no Authorization header)', async () => {
  const { fetch, calls } = spy()
  await createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch }).open({ action: ACTION, policy: POLICY })
  assert.equal(calls.find((c) => c.path === '/operations').headers.authorization, undefined)
})
