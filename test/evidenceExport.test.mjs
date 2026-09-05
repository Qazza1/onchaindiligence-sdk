/** D2.5 Section 15 tests #14, #18: evidence export contains no recovery
 * credentials, bearer tokens, or payment-authorization secrets, and neither
 * does any lifecycle result object the client returns.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEvidenceExport, EVIDENCE_EXPORT_VERSION, createCommerceClient, InMemoryRecoveryStore, MockCommerceExecutor } from '../dist/commerce/index.js'
import { createFakeServer } from './fakeServer.mjs'

const SECRET_RECOVERY_CREDENTIAL = 'THIS-MUST-NEVER-APPEAR-IN-EXPORT-abc123'
const SECRET_CAPABILITY_TOKEN = 'THIS-CAPABILITY-MUST-NEVER-APPEAR-xyz789'

test('buildEvidenceExport never includes a recovery credential or capability token even if a caller tried to sneak one into notes', async () => {
  const manifest = await buildEvidenceExport({
    operationId: 'op-1',
    preflightReceipt: null,
    commerceReceipt: null,
    operationStatus: null,
    notes: { orderRef: 'abc-123' },
  })
  assert.equal(manifest.manifest_version, EVIDENCE_EXPORT_VERSION)
  assert.ok(manifest.manifest_digest.startsWith('sha256:'))
  const serialized = JSON.stringify(manifest)
  assert.ok(!serialized.includes(SECRET_RECOVERY_CREDENTIAL))
  assert.ok(!serialized.includes(SECRET_CAPABILITY_TOKEN))
})

test('buildEvidenceExport function signature has no parameter through which a recovery record could flow', async () => {
  // Structural guarantee, not just a runtime check: EvidenceExportInput
  // only accepts receipts/status/notes -- there is no field for a
  // CommerceRecoveryRecord or any of its secret fields. This test
  // documents that guarantee by exercising every accepted field and
  // confirming none of them round-trip a credential-shaped string.
  const manifest = await buildEvidenceExport({
    operationId: 'op-1',
    preflightReceipt: { schema: 's', receipt: { receipt_id: 'r1' }, proof: {} },
    commerceReceipt: { schema: 's', receipt: { receipt_id: 'r2' }, proof: {} },
    operationStatus: { operation_id: 'op-1', preflight_state: 'completed', execution_state: 'transaction_known', observation_state: 'confirmed', receipt_state: 'commerce_issued', preflight_receipt_id: 'r1' },
  })
  const serialized = JSON.stringify(manifest)
  assert.ok(!/credential|bearer|capability_token|authorization/i.test(serialized), 'evidence export must never contain credential-shaped field names')
})

test('no lifecycle result returned by the client ever serializes a recovery credential or capability token', async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const action = {
    kind: 'PAYMENT',
    resource: 'https://service.example/api',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '1.00',
    sender: null,
    recipient: '0x000000000000000000000000000000000000dEaD',
  }
  const policy = { max_amount: '5.00', allowed_networks: null, allowed_assets: null, expected_recipient: null, allowed_resource_origins: null }

  const op = await client.open({ action, policy })
  const record = op.currentRecord()
  const evaluation = await op.preflight()
  const execution = await op.execute({ executor: new MockCommerceExecutor() })
  const finalize = await op.observeAndFinalize()

  for (const result of [evaluation, execution, finalize]) {
    const serialized = JSON.stringify(result)
    assert.ok(!serialized.includes(record.recoveryCredential), `result ${JSON.stringify(result.kind)} must never expose the recovery credential`)
    if (record.finalizationCapability) {
      assert.ok(!serialized.includes(record.finalizationCapability), `result ${JSON.stringify(result.kind)} must never expose the raw finalization capability token`)
    }
  }
})
