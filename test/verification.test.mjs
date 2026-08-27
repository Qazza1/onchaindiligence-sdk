import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto'
import {
  canonicalizeJson,
  parseJsonNoDuplicateKeys,
  verifyAttestationOffline,
  verifyAttestationOnline,
  buildAnchorRequest,
} from '../dist/index.js'

const ISSUER = 'https://api.onchaindiligence.com'
const PURPOSE = 'compliance-screening-result'
const NOW = Date.parse('2026-08-27T12:00:00.000Z')
const ISSUED_AT = '2026-08-27T11:59:00.000Z'

function keyPair() {
  const pair = generateKeyPairSync('ed25519')
  const der = pair.publicKey.export({ type: 'spki', format: 'der' })
  return {
    ...pair,
    keyId: `ed25519-${createHash('sha256').update(der).digest('base64url').slice(0, 16)}`,
    pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function keyRecord(pair, overrides = {}) {
  return {
    key_id: pair.keyId,
    algorithm: 'ed25519',
    public_key_pem: pair.pem,
    status: 'active',
    valid_from: '2026-08-27T00:00:00.000Z',
    valid_until: null,
    status_changed_at: '2026-08-27T00:00:00.000Z',
    ...overrides,
  }
}

function v2Envelope(pair, data = { address: '0x0000000000000000000000000000000000000001', sanctioned: false }, metadata = {}) {
  const attestation = {
    signed: true,
    schema_version: 'onchaindiligence.attestation.v2',
    issuer: ISSUER,
    purpose: PURPOSE,
    issued_at: ISSUED_AT,
    key_id: pair.keyId,
    algorithm: 'ed25519',
    canonicalization: 'RFC8785',
    ...metadata,
  }
  const input = canonicalizeJson({
    schema_version: attestation.schema_version,
    issuer: attestation.issuer,
    purpose: attestation.purpose,
    data,
    issued_at: attestation.issued_at,
    key_id: attestation.key_id,
  })
  return {
    data,
    attestation: {
      ...attestation,
      signature: sign(null, Buffer.from(input), pair.privateKey).toString('base64url'),
    },
  }
}

function v1Envelope(pair, data = { legacy: true }) {
  const input = JSON.stringify({ data, issued_at: ISSUED_AT, key_id: pair.keyId })
  return {
    data,
    attestation: {
      signed: true,
      issued_at: ISSUED_AT,
      key_id: pair.keyId,
      algorithm: 'ed25519',
      signature: sign(null, Buffer.from(input), pair.privateKey).toString('base64url'),
    },
  }
}

function verify(envelope, records, options = {}) {
  return verifyAttestationOffline(envelope, { keys: records, issuer: ISSUER }, { now: NOW, ...options })
}

function readCorpus(name) {
  return JSON.parse(readFileSync(new URL(`../conformance/${name}`, import.meta.url), 'utf8'))
}

test('language-neutral RFC8785 corpus is enforced', () => {
  const corpus = readCorpus('rfc8785-vectors.json')
  for (const vector of corpus.canonicalization) {
    assert.equal(canonicalizeJson(vector.input), vector.expected, vector.id)
  }
  for (const vector of corpus.invalid_json) {
    assert.throws(() => parseJsonNoDuplicateKeys(vector.input), undefined, vector.id)
  }
})

test('language-neutral attestation corpus produces its declared tri-state results', async () => {
  const corpus = readCorpus('attestation-v1-v2-vectors.json')
  for (const fixture of corpus.fixtures) {
    const records = fixture.trust_records.map((id) => corpus.trust_records[id])
    const checked = await verifyAttestationOffline(
      corpus.envelopes[fixture.envelope],
      { issuer: ISSUER, keys: records },
      corpus.verifier_options
    )
    assert.equal(checked.state, fixture.expected_state, fixture.id)
  }
})

test('RFC8785 canonicalization covers ordering, Unicode, escapes, numbers, nesting and empty values', () => {
  const unicode = {
    '\u20ac': 'Euro Sign',
    '\r': 'Carriage Return',
    '\ufb33': 'Hebrew Letter Dalet With Dagesh',
    '1': 'One',
    '\ud83d\ude00': 'Emoji: Grinning Face',
    '\u0080': 'Control',
    '\u00f6': 'Latin Small Letter O With Diaeresis',
  }
  assert.equal(
    canonicalizeJson(unicode),
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}'
  )
  assert.equal(
    canonicalizeJson({ z: [], empty: {}, nested: [{ b: 'line\n"\\', a: null }], numbers: [333333333.3333333, 1e30, 4.5, 0.002, 1e-27, -0] }),
    '{"empty":{},"nested":[{"a":null,"b":"line\\n\\"\\\\"}],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],"z":[]}'
  )
  assert.throws(() => parseJsonNoDuplicateKeys('{"n":9007199254740993}'), /safe-integer/)
  assert.throws(() => canonicalizeJson(Number.POSITIVE_INFINITY), /non-finite/)
})

test('duplicate-key JSON and excessive nesting fail before verification', () => {
  assert.throws(() => parseJsonNoDuplicateKeys('{"data":1,"data":2}'), /duplicate/)
  assert.throws(() => parseJsonNoDuplicateKeys('[[[0]]]', 1), /maximum depth/)
})

test('valid v2 and explicit legacy v1 verify offline without fetch', async (t) => {
  const pair = keyPair()
  const originalFetch = global.fetch
  global.fetch = async () => { throw new Error('offline verifier attempted network access') }
  t.after(() => { global.fetch = originalFetch })

  const current = keyRecord(pair)
  const v2 = await verify(JSON.stringify(v2Envelope(pair)), [current])
  assert.equal(v2.state, 'VALID')
  assert.equal(v2.components.signature.state, 'PASS')
  assert.equal(v2.components.identity.state, 'PASS')
  assert.equal(v2.components.anchor.state, 'NOT_CHECKED')

  const v1 = await verify(v1Envelope(pair), [current])
  assert.equal(v1.state, 'VALID')
  assert.equal(v1.schemaVersion, 'legacy-v1')
  assert.match(v1.warnings[0], /no signed schema/)
})

test('payload mutation, wrong signature and wrong key fail as INVALID', async () => {
  const pair = keyPair()
  const other = keyPair()
  const envelope = v2Envelope(pair)
  const current = keyRecord(pair)

  const mutated = structuredClone(envelope)
  mutated.data.sanctioned = true
  assert.equal((await verify(mutated, [current])).code, 'signature_mismatch')

  const wrongSignature = structuredClone(envelope)
  wrongSignature.attestation.signature = v2Envelope(other).attestation.signature
  assert.equal((await verify(wrongSignature, [current])).state, 'INVALID')

  assert.equal(
    (await verify(envelope, [{ ...keyRecord(other), key_id: pair.keyId }])).code,
    'key_id_spki_mismatch'
  )
})

test('unknown key and missing strict validity metadata are UNVERIFIABLE', async () => {
  const pair = keyPair()
  const envelope = v2Envelope(pair)
  assert.equal((await verify(envelope, [])).code, 'unknown_key')
  const missingBoundary = await verify(envelope, [keyRecord(pair, { valid_from: null })])
  assert.equal(missingBoundary.state, 'UNVERIFIABLE')
  assert.equal(missingBoundary.code, 'missing_valid_from')
  assert.equal(missingBoundary.cryptographicallyValid, true)
})

test('issuer, purpose and version never downgrade to legacy verification', async () => {
  const pair = keyPair()
  const current = keyRecord(pair)
  assert.equal((await verify(v2Envelope(pair, undefined, { issuer: 'https://attacker.example' }), [current])).code, 'wrong_issuer')
  assert.equal((await verify(v2Envelope(pair, undefined, { purpose: 'other-purpose' }), [current])).code, 'wrong_purpose')

  const unsupported = v2Envelope(pair, undefined, { schema_version: 'onchaindiligence.attestation.v9' })
  const unsupportedResult = await verify(unsupported, [current])
  assert.equal(unsupportedResult.state, 'UNVERIFIABLE')
  assert.equal(unsupportedResult.code, 'unsupported_version')

  const missingIssuer = v2Envelope(pair)
  delete missingIssuer.attestation.issuer
  const noDowngrade = await verify(missingIssuer, [current])
  assert.equal(noDowngrade.state, 'INVALID')
  assert.equal(noDowngrade.code, 'wrong_issuer')
})

test('active and correctly bounded retired keys pass; outside interval fails', async () => {
  const pair = keyPair()
  const envelope = v2Envelope(pair)
  assert.equal((await verify(envelope, [keyRecord(pair)])).state, 'VALID')

  const retired = keyRecord(pair, {
    status: 'retired',
    valid_until: '2026-08-27T12:00:00.000Z',
    status_changed_at: '2026-08-27T12:00:00.000Z',
  })
  const historical = await verify(envelope, [retired])
  assert.equal(historical.state, 'VALID')
  assert.equal(historical.components.lifecycle.code, 'key_retired_historical')

  const tooEarly = keyRecord(pair, {
    status: 'retired',
    valid_from: '2026-08-27T12:00:00.000Z',
    valid_until: '2026-08-28T00:00:00.000Z',
  })
  assert.equal((await verify(envelope, [tooEarly])).code, 'outside_key_validity')
})

test('compromised and revoked keys fail closed after cryptographic verification', async () => {
  const pair = keyPair()
  const envelope = v2Envelope(pair)
  for (const status of ['compromised', 'revoked']) {
    const checked = await verify(envelope, [keyRecord(pair, { status })])
    assert.equal(checked.state, 'INVALID')
    assert.equal(checked.code, `key_${status}`)
    assert.equal(checked.cryptographicallyValid, true)
    assert.equal(checked.trusted, false)
  }
})

test('freshness is evaluated independently from signature and key validity', async () => {
  const pair = keyPair()
  const checked = await verify(v2Envelope(pair), [keyRecord(pair)], { maxAgeMs: 30_000 })
  assert.equal(checked.state, 'INVALID')
  assert.equal(checked.code, 'stale')
  assert.equal(checked.components.signature.state, 'PASS')
  assert.equal(checked.components.key_window.state, 'PASS')
  assert.equal(checked.components.freshness.state, 'FAIL')
})

test('online lookup is a separate wrapper and requires an explicit trust decision', async () => {
  const pair = keyPair()
  const envelope = v2Envelope(pair)
  const record = keyRecord(pair)
  const requested = []
  const fetch = async (url) => {
    requested.push(String(url))
    return { ok: true, status: 200, json: async () => ({ key: record }) }
  }

  const untrusted = await verifyAttestationOnline(envelope, { fetch, now: NOW })
  assert.equal(untrusted.state, 'UNVERIFIABLE')
  assert.equal(untrusted.code, 'online_registry_not_trusted')

  const trusted = await verifyAttestationOnline(envelope, { fetch, now: NOW, trustRegistry: true })
  assert.equal(trusted.state, 'VALID')
  assert.match(requested[0], new RegExp(`/attestation-keys/${pair.keyId}$`))
})

test('anchor requests require and preserve the complete signed envelope', () => {
  const envelope = v2Envelope(keyPair())
  assert.strictEqual(buildAnchorRequest(envelope), envelope)
  assert.throws(() => buildAnchorRequest({ attestation: envelope.attestation }), /complete signed/)
  assert.throws(() => buildAnchorRequest({ data: envelope.data, attestation: { signed: false } }), /complete signed/)
})
