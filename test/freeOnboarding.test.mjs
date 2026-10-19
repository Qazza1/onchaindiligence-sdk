import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('primary onboarding explicitly selects free without changing legacy recovery', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const primary = readme.split('### Existing x402 client:')[0]
  assert.equal((primary.match(/createCommerceClient\(\{/g) || []).length, 2)
  assert.equal((primary.match(/preflightMode: 'free'/g) || []).length, 2)
  assert.match(primary, /evaluation.kind !== 'ready'/)
  assert.match(readme, /withOcd` has no\s+`preflightMode` option/)
  assert.match(readme, /Historical recovery records without a\s+mode are paid/)
  assert.match(readme, /Free exhaustion never authorizes a paid retry/)
})
