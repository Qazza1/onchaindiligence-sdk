import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { verifyBundleOffline } from '../dist/index.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const corpus = join(packageRoot, 'node_modules', '@onchaindiligence', 'agent-evidence', 'conformance')
const fixture = (name) => JSON.parse(readFileSync(join(corpus, name), 'utf8'))
const keys = fixture('valid-full-graph.json').verification_material.keys

test('verifyBundleOffline delegates to the protocol verifier with zero network access', () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('offline bundle verification attempted network access') }
  try {
    const report = verifyBundleOffline(fixture('bundle-with-artifacts.json'), keys, {
      now: new Date('2026-08-28T12:01:00.000Z'),
    })
    assert.equal(report.bundle_integrity.state, 'VALID')
    assert.equal(report.state, 'VALID')
    assert.equal(report.artifact_verifications.length, 6)
    assert.ok(report.reconciliation)
    assert.ok(report.limitations.length)
  } finally {
    globalThis.fetch = originalFetch
  }
})
