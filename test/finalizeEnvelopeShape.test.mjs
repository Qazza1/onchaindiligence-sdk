/** Regression test for a confirmed live D2.5A defect: after a genuinely
 * successful, independently-observed OneSource execution (execution
 * CONFIRMED, settlement CONFIRMED, binding PAYMENT_IDENTITY_LINKED), the
 * operator reported "Commerce verification: INVALID (schema-invalid)" for a
 * validly-signed Commerce receipt.
 *
 * Root cause: onchaindiligence-mcp's POST /operations/:id/finalize responds
 * `{...envelope, ocd_lifecycle_evidence}` -- a transport convenience shape,
 * never the canonical Public Action Receipt v1 envelope itself (which is
 * exactly {schema, receipt, proof}, closed-schema, additionalProperties:
 * false at every level -- see receipts.ts's closedKeys/validateReceiptShape).
 * CommerceOperation.observeAndFinalize() assigned that whole enriched body
 * to `receipt` unchanged and handed it to verifyReceipt() and to the
 * caller -- an envelope carrying an extra `ocd_lifecycle_evidence` key
 * fails the real server's closed-schema check with exactly "envelope has an
 * unexpected field: ocd_lifecycle_evidence" (code schema-invalid),
 * regardless of how validly the receipt itself was signed.
 *
 * test/fakeServer.mjs's /verify-receipt used to return VALID
 * unconditionally, which is exactly why this was invisible to every
 * existing SDK test -- it now performs the same closed-schema check the
 * real server does for this field.
 *
 * Run with: npm test (builds, then node --test test/*.test.mjs)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommerceClient, InMemoryRecoveryStore, MockCommerceExecutor } from '../dist/commerce/index.js'
import { createFakeServer } from './fakeServer.mjs'

const ACTION = {
  kind: 'PAYMENT',
  resource: 'https://service.example/api',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '1.00',
  sender: null,
  recipient: '0x000000000000000000000000000000000000dEaD',
}
const POLICY = { max_amount: '5.00', allowed_networks: null, allowed_assets: null, expected_recipient: null, allowed_resource_origins: null }

test('observeAndFinalize() returns a canonical {schema, receipt, proof} envelope that independently verifies VALID', async () => {
  const server = createFakeServer()
  // trust.verifyReceipts:true also exercises the SAME bug's second call
  // site (the client's own internal best-effort verification) -- it must
  // not throw or silently fail either.
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch, trust: { verifyReceipts: true } })
  const op = await client.open({ action: ACTION, policy: POLICY })
  const evaluation = await op.preflight()
  assert.equal(evaluation.kind, 'ready')

  const execution = await op.execute({ executor: new MockCommerceExecutor() })
  assert.equal(execution.kind, 'execution-recorded')

  const result = await op.observeAndFinalize()
  assert.equal(result.kind, 'receipt-produced')

  assert.deepEqual(
    Object.keys(result.receipt).sort(),
    ['proof', 'receipt', 'schema'],
    'the returned receipt must be exactly the canonical envelope -- no ocd_lifecycle_evidence or any other extra top-level field'
  )

  const verification = await client.verifyReceipt(result.receipt)
  assert.equal(verification.state, 'VALID', `must independently verify VALID, not ${verification.state} (${verification.code}: ${verification.message})`)

  // Lifecycle evidence must still be available -- just as its own separate
  // field, never folded into the signed envelope (D2.5A requirement: binding
  // strength/profile data lives in the linked lifecycle evidence, not as an
  // unsigned extension to the receipt envelope).
  assert.ok(result.evidence, 'lifecycle evidence must still be surfaced, just not inside the envelope')
  assert.ok(result.evidence.bundle_digest)
  assert.ok(result.evidence.binding_strength)
})
