/** Regenerate the language-neutral attestation corpus using a public RFC 8032 test seed. */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { canonicalizeJson } from '../dist/index.js'

const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der',
  type: 'pkcs8',
})
const publicKey = createPublicKey(privateKey)
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const keyId = `ed25519-${createHash('sha256')
  .update(publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64url')
  .slice(0, 16)}`
const issuedAt = '2026-08-27T12:00:00.000Z'
const now = '2026-08-27T12:01:00.000Z'
const data = {
  address: '0x0000000000000000000000000000000000000001',
  nested: { empty: [], unicode: '€ 😀' },
  sanctioned: false,
}

const active = {
  key_id: keyId,
  algorithm: 'ed25519',
  public_key_pem: publicKeyPem,
  status: 'active',
  valid_from: '2026-08-27T00:00:00.000Z',
  valid_until: null,
  status_changed_at: '2026-08-27T00:00:00.000Z',
}

function v2(schemaVersion = 'onchaindiligence.attestation.v2') {
  const metadata = {
    signed: true,
    schema_version: schemaVersion,
    issuer: 'https://api.onchaindiligence.com',
    purpose: 'compliance-screening-result',
    issued_at: issuedAt,
    key_id: keyId,
    algorithm: 'ed25519',
    canonicalization: 'RFC8785',
  }
  const input = canonicalizeJson({
    schema_version: metadata.schema_version,
    issuer: metadata.issuer,
    purpose: metadata.purpose,
    data,
    issued_at: metadata.issued_at,
    key_id: metadata.key_id,
  })
  return {
    data,
    attestation: {
      ...metadata,
      signature: sign(null, Buffer.from(input), privateKey).toString('base64url'),
    },
  }
}

function v1() {
  const input = JSON.stringify({ data, issued_at: issuedAt, key_id: keyId })
  return {
    data,
    attestation: {
      signed: true,
      issued_at: issuedAt,
      key_id: keyId,
      algorithm: 'ed25519',
      signature: sign(null, Buffer.from(input), privateKey).toString('base64url'),
    },
  }
}

const valid = v2()
const tampered = structuredClone(valid)
tampered.data.sanctioned = true
const corpus = {
  corpus_version: 1,
  description: 'Test-only OnChainDiligence v1/v2 trust-foundation fixtures. No production key material.',
  verifier_options: { now },
  trust_records: {
    active,
    retired: { ...active, status: 'retired', valid_until: '2026-08-27T12:30:00.000Z', status_changed_at: '2026-08-27T12:30:00.000Z' },
    compromised: { ...active, status: 'compromised', compromised_at: '2026-08-27T12:30:00.000Z', status_changed_at: '2026-08-27T12:30:00.000Z' },
  },
  envelopes: {
    valid_v2: valid,
    tampered_payload: tampered,
    valid_v1: v1(),
    unsupported_version: v2('onchaindiligence.attestation.v9'),
  },
  fixtures: [
    { id: 'valid-v2-active', expected_state: 'VALID', envelope: 'valid_v2', trust_records: ['active'] },
    { id: 'valid-v2-retired', expected_state: 'VALID', envelope: 'valid_v2', trust_records: ['retired'] },
    { id: 'compromised-key', expected_state: 'INVALID', envelope: 'valid_v2', trust_records: ['compromised'] },
    { id: 'tampered-payload', expected_state: 'INVALID', envelope: 'tampered_payload', trust_records: ['active'] },
    { id: 'unknown-key', expected_state: 'UNVERIFIABLE', envelope: 'valid_v2', trust_records: [] },
    { id: 'valid-v1-legacy', expected_state: 'VALID', envelope: 'valid_v1', trust_records: ['active'] },
    { id: 'unsupported-version', expected_state: 'UNVERIFIABLE', envelope: 'unsupported_version', trust_records: ['active'] },
  ],
}

process.stdout.write(JSON.stringify(corpus, null, 2) + '\n')
