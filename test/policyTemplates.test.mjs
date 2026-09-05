/** D2.5 Section 15 test #13: policy templates produce strict, valid policy
 * objects -- exactly what onchaindiligence-mcp's own closed-schema policy
 * parser accepts, with no extra fields.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apiPurchasePolicy, approvalAboveThresholdPolicy, fixedRecipientPolicy, POLICY_TEMPLATE_VERSION } from '../dist/commerce/index.js'

const ALLOWED_POLICY_KEYS = new Set(['max_amount', 'allowed_networks', 'allowed_assets', 'expected_recipient', 'allowed_resource_origins', 'acknowledge_unconstrained', 'expected_payer'])

function assertStrictPolicyShape(policy) {
  for (const key of Object.keys(policy)) {
    assert.ok(ALLOWED_POLICY_KEYS.has(key), `template produced an unrecognized policy field: "${key}" -- this would be REJECTED by the server's strict policy parser`)
  }
}

test('apiPurchasePolicy produces a strict, server-acceptable policy with a max amount', () => {
  const { policy, templateVersion, templateName } = apiPurchasePolicy({ maxAmount: '1.00', allowedNetwork: 'eip155:8453', allowedAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' })
  assertStrictPolicyShape(policy)
  assert.equal(policy.max_amount, '1.00')
  assert.deepEqual(policy.allowed_networks, ['eip155:8453'])
  assert.equal(templateVersion, POLICY_TEMPLATE_VERSION)
  assert.equal(templateName, 'bounded-api-purchase')
})

test('approvalAboveThresholdPolicy produces an explicitly-acknowledged unconstrained-amount policy', () => {
  const { policy } = approvalAboveThresholdPolicy({ allowedNetwork: 'eip155:8453', allowedAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' })
  assertStrictPolicyShape(policy)
  assert.equal(policy.max_amount, null)
  assert.equal(policy.acknowledge_unconstrained, true, 'an intentionally-unconstrained amount must carry the explicit acknowledgment the server requires')
})

test('fixedRecipientPolicy pins both amount and recipient', () => {
  const { policy } = fixedRecipientPolicy({
    maxAmount: '5.00',
    allowedNetwork: 'eip155:8453',
    allowedAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    expectedRecipient: '0x000000000000000000000000000000000000dEaD',
  })
  assertStrictPolicyShape(policy)
  assert.equal(policy.max_amount, '5.00')
  assert.equal(policy.expected_recipient, '0x000000000000000000000000000000000000dEaD')
})

test('every template is versioned', () => {
  for (const result of [
    apiPurchasePolicy({ maxAmount: '1.00', allowedNetwork: 'eip155:8453', allowedAsset: '0xasset' }),
    approvalAboveThresholdPolicy({ allowedNetwork: 'eip155:8453', allowedAsset: '0xasset' }),
    fixedRecipientPolicy({ maxAmount: '1.00', allowedNetwork: 'eip155:8453', allowedAsset: '0xasset', expectedRecipient: '0xrecipient' }),
  ]) {
    assert.equal(result.templateVersion, POLICY_TEMPLATE_VERSION)
    assert.ok(typeof result.templateName === 'string' && result.templateName.length > 0)
  }
})
