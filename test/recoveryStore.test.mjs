/** D2.5 Section 15 tests #4, #5, #8: recovery store atomicity, CAS
 * concurrency, and restart-survival (a fresh store instance pointed at the
 * same directory sees everything a prior instance wrote).
 *
 * Run with: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileRecoveryStore, InMemoryRecoveryStore, RecoveryRecordExistsError, RecoveryRecordNotFoundError, VersionConflictError } from '../dist/commerce/index.js'

function baseRecord(operationId) {
  return {
    operationId,
    recoveryCredential: 'test-credential-value',
    preflightReceiptId: null,
    finalizationCapability: null,
    finalizationCapabilityExpiresAt: null,
    executionRequestId: null,
    clientSubmissionKey: null,
    executorId: null,
    transactionHash: null,
    localPhase: 'opened',
  }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ocd-recovery-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

for (const [label, makeStore] of [
  ['InMemoryRecoveryStore', () => new InMemoryRecoveryStore()],
]) {
  test(`${label}: create is atomic -- a second create for the same id fails`, async () => {
    const store = makeStore()
    await store.create(baseRecord('op-1'))
    await assert.rejects(() => store.create(baseRecord('op-1')), RecoveryRecordExistsError)
  })

  test(`${label}: update with a stale version fails with VersionConflictError`, async () => {
    const store = makeStore()
    const created = await store.create(baseRecord('op-1'))
    assert.equal(created.version, 1)
    await store.update('op-1', { localPhase: 'a' }, 1)
    await assert.rejects(() => store.update('op-1', { localPhase: 'b' }, 1), VersionConflictError)
  })

  test(`${label}: update on an unknown operation fails with RecoveryRecordNotFoundError`, async () => {
    const store = makeStore()
    await assert.rejects(() => store.update('nope', { localPhase: 'x' }, 1), RecoveryRecordNotFoundError)
  })
}

test('NodeFileRecoveryStore: survives a fresh instance pointed at the same directory (process restart)', async () => {
  await withTempDir(async (dir) => {
    const store1 = new NodeFileRecoveryStore(dir)
    await store1.create({ ...baseRecord('op-restart'), finalizationCapability: 'secret-token-abc' })

    // Simulate a process restart: a BRAND NEW store instance, same directory.
    const store2 = new NodeFileRecoveryStore(dir)
    const loaded = await store2.load('op-restart')
    assert.ok(loaded)
    assert.equal(loaded.operationId, 'op-restart')
    assert.equal(loaded.finalizationCapability, 'secret-token-abc')
  })
})

test('NodeFileRecoveryStore: concurrent CAS updates -- exactly one wins, the other conflicts', async () => {
  await withTempDir(async (dir) => {
    const store = new NodeFileRecoveryStore(dir)
    await store.create(baseRecord('op-race'))

    const results = await Promise.allSettled([store.update('op-race', { localPhase: 'a' }, 1), store.update('op-race', { localPhase: 'b' }, 1)])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(fulfilled.length, 1, 'exactly one concurrent update at the same base version must win')
    assert.equal(rejected.length, 1)
    assert.ok(rejected[0].reason instanceof VersionConflictError)
  })
})

test('NodeFileRecoveryStore: rejects a path-traversal-shaped operationId rather than escaping `directory`', async () => {
  await withTempDir(async (dir) => {
    const store = new NodeFileRecoveryStore(dir)
    await assert.rejects(() => store.create(baseRecord('../../etc/passwd')), TypeError)
  })
})

test('NodeFileRecoveryStore: findByClientSubmissionKey locates a record after restart', async () => {
  await withTempDir(async (dir) => {
    const store1 = new NodeFileRecoveryStore(dir)
    await store1.create({ ...baseRecord('op-find'), clientSubmissionKey: 'attempt-xyz' })
    const store2 = new NodeFileRecoveryStore(dir)
    const found = await store2.findByClientSubmissionKey('attempt-xyz')
    assert.ok(found)
    assert.equal(found.operationId, 'op-find')
    assert.equal(await store2.findByClientSubmissionKey('does-not-exist'), null)
  })
})
