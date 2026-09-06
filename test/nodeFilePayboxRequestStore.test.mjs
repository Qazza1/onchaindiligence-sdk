/** D2.6 live-reference prep: NodeFilePayboxRequestStore -- restart survival
 * and genuinely cross-process atomic claim() (backed by the filesystem's
 * O_EXCL create, not merely an in-process lock).
 *
 * Run with: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFilePayboxRequestStore } from '../dist/commerce/node.js'

function placeholder(clientSubmissionKey) {
  return {
    clientSubmissionKey,
    payboxRequestId: null,
    resourceUrl: 'https://merchant.example/api',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    atomicAmount: '1000',
    recipient: '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea',
    transactionHash: null,
  }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ocd-paybox-store-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('claim() on a fresh key creates the placeholder and reports claimed: true', () =>
  withTempDir(async (dir) => {
    const store = new NodeFilePayboxRequestStore(dir)
    const { claimed, record } = await store.claim('key-1', placeholder('key-1'))
    assert.equal(claimed, true)
    assert.equal(record.payboxRequestId, null)
    const loaded = await store.get('key-1')
    assert.deepEqual(loaded, placeholder('key-1'))
  }))

test('claim() on an already-claimed key reports claimed: false and returns the existing record unmodified', () =>
  withTempDir(async (dir) => {
    const store = new NodeFilePayboxRequestStore(dir)
    await store.claim('key-1', placeholder('key-1'))
    await store.set({ ...placeholder('key-1'), payboxRequestId: 'paybox-req-abc' })

    const second = await store.claim('key-1', placeholder('key-1'))
    assert.equal(second.claimed, false)
    assert.equal(second.record.payboxRequestId, 'paybox-req-abc', 'claim() must never overwrite an existing record')
  }))

test('concurrent claim() calls for the same key across store instances: exactly one wins', () =>
  withTempDir(async (dir) => {
    // Two independent store instances (simulating two processes sharing the
    // same directory) racing to claim the SAME clientSubmissionKey.
    const storeA = new NodeFilePayboxRequestStore(dir)
    const storeB = new NodeFilePayboxRequestStore(dir)
    const [a, b] = await Promise.all([storeA.claim('race-key', placeholder('race-key')), storeB.claim('race-key', placeholder('race-key'))])
    const claims = [a, b]
    assert.equal(claims.filter((c) => c.claimed).length, 1, 'exactly one of two concurrent claimants must win')
    assert.equal(claims.filter((c) => !c.claimed).length, 1)
  }))

test('set() and get() survive a fresh instance pointed at the same directory (process restart)', () =>
  withTempDir(async (dir) => {
    const store1 = new NodeFilePayboxRequestStore(dir)
    await store1.claim('key-1', placeholder('key-1'))
    await store1.set({ ...placeholder('key-1'), payboxRequestId: 'paybox-req-xyz', transactionHash: '0x' + 'aa'.repeat(32) })

    const store2 = new NodeFilePayboxRequestStore(dir)
    const loaded = await store2.get('key-1')
    assert.equal(loaded.payboxRequestId, 'paybox-req-xyz')
    assert.equal(loaded.transactionHash, '0x' + 'aa'.repeat(32))
  }))

test('get() on an unknown key returns null, not an error', () =>
  withTempDir(async (dir) => {
    const store = new NodeFilePayboxRequestStore(dir)
    assert.equal(await store.get('never-claimed'), null)
  }))

test('rejects a path-traversal-shaped clientSubmissionKey rather than escaping `directory`', () =>
  withTempDir(async (dir) => {
    const store = new NodeFilePayboxRequestStore(dir)
    await assert.rejects(() => store.claim('../../evil', placeholder('../../evil')), TypeError)
    await assert.rejects(() => store.get('../../evil'), TypeError)
  }))
