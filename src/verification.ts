/**
 * Zero-network verification for existing OnChainDiligence attestations.
 *
 * This module deliberately has no HTTP client and never discovers keys. The
 * caller supplies the exact key records it has independently chosen to trust.
 * Online discovery is implemented separately in index.ts as a convenience
 * wrapper around this core.
 */

export const ATTESTATION_V2_SCHEMA = 'onchaindiligence.attestation.v2'
export const DEFAULT_ATTESTATION_ISSUER = 'https://api.onchaindiligence.com'
export const COMPLIANCE_ATTESTATION_PURPOSE = 'compliance-screening-result'
export const FIXTURE_ATTESTATION_PURPOSE = 'verification-fixture'

export type VerificationState = 'VALID' | 'INVALID' | 'UNVERIFIABLE'
export type ComponentState = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_CHECKED'
export type AttestationKeyStatus = 'active' | 'retired' | 'revoked' | 'compromised'

export interface Attestation {
  signed: boolean
  schema_version?: string
  issuer?: string
  purpose?: string
  key_id?: string
  algorithm?: string
  canonicalization?: string
  signature?: string
  issued_at?: string
  [key: string]: unknown
}

export interface Signed<T> {
  data: T
  attestation: Attestation
}

export interface AttestationKeyRecord {
  key_id: string
  algorithm: 'ed25519'
  public_key_pem: string
  status: AttestationKeyStatus
  valid_from: string | null
  valid_until: string | null
  status_changed_at?: string | null
  status_reason?: string
  replacement_key_id?: string | null
  compromised_at?: string | null
}

/**
 * Passing this object is an explicit caller trust decision. A key embedded in
 * an attestation or downloaded from an arbitrary URL MUST NOT be copied here
 * automatically.
 */
export interface TrustedAttestationKeySet {
  keys: readonly AttestationKeyRecord[]
  /** Optional identity namespace represented by these trusted records. */
  issuer?: string
  /** Human/machine-readable description of the out-of-band trust source. */
  trust_source?: string
  /** Reserved for future signed registry snapshot/root policy. */
  registry_version?: number
}

export interface VerificationComponent {
  state: ComponentState
  code: string
  message: string
}

export interface AttestationVerificationComponents {
  structure: VerificationComponent
  signature: VerificationComponent
  identity: VerificationComponent
  lifecycle: VerificationComponent
  timestamp: VerificationComponent
  key_window: VerificationComponent
  freshness: VerificationComponent
  anchor: VerificationComponent
}

export interface AttestationVerificationResult {
  state: VerificationState
  /** Compatibility convenience. Security-sensitive callers should use state. */
  valid: boolean
  code: string
  reason: string
  schemaVersion?: string
  keyId?: string
  keyStatus?: AttestationKeyStatus
  cryptographicallyValid?: boolean
  trusted?: boolean
  components: AttestationVerificationComponents
  warnings: string[]
}

export interface VerifyAttestationOptions {
  expectedIssuer?: string
  allowedPurposes?: readonly string[]
  /** Default true. A missing active valid_from is UNVERIFIABLE. */
  requireValidFrom?: boolean
  /** Evaluate business freshness separately from signature/key validity. */
  maxAgeMs?: number
  /** Injected for deterministic verification/tests. */
  now?: Date | number | string
  /** Default five minutes. */
  maxFutureSkewMs?: number
}

const KEY_ID_PATTERN = /^ed25519-[A-Za-z0-9_-]{16}$/
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/

const notChecked = (code: string, message: string): VerificationComponent => ({
  state: 'NOT_CHECKED',
  code,
  message,
})

function initialComponents(): AttestationVerificationComponents {
  return {
    structure: notChecked('not_checked', 'Envelope structure was not checked.'),
    signature: notChecked('not_checked', 'Signature was not checked.'),
    identity: notChecked('not_checked', 'Signer identity was not checked.'),
    lifecycle: notChecked('not_checked', 'Key lifecycle was not checked.'),
    timestamp: notChecked('not_checked', 'Signed timestamp was not checked.'),
    key_window: notChecked('not_checked', 'Key validity window was not checked.'),
    freshness: notChecked('not_requested', 'No freshness policy was requested.'),
    anchor: notChecked(
      'not_requested',
      'Anchor status is independent and was not supplied to this verifier.'
    ),
  }
}

function result(
  state: VerificationState,
  code: string,
  reason: string,
  components: AttestationVerificationComponents,
  details: Partial<AttestationVerificationResult> = {}
): AttestationVerificationResult {
  return {
    state,
    valid: state === 'VALID',
    code,
    reason,
    components,
    warnings: [],
    ...details,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** RFC 8785 canonical JSON for values in the I-JSON data model. */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('attestation contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
      .join(',')}}`
  }
  throw new TypeError(`value of type ${typeof value} is not valid JSON`)
}

/**
 * Parse JSON while rejecting duplicate object member names. JSON.parse keeps
 * the last duplicate, which is unsafe for signed formats because another
 * implementation may keep the first.
 */
export function parseJsonNoDuplicateKeys(text: string, maxDepth = 64): unknown {
  const parsed = JSON.parse(text) as unknown
  let index = 0

  const whitespace = () => {
    while (/\s/.test(text[index] ?? '')) index += 1
  }
  const stringToken = (): string => {
    const start = index
    index += 1
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2
      } else if (text[index] === '"') {
        index += 1
        return text.slice(start, index)
      } else {
        index += 1
      }
    }
    throw new SyntaxError('unterminated JSON string')
  }
  const value = (depth: number): void => {
    if (depth > maxDepth) throw new SyntaxError(`JSON exceeds maximum depth ${maxDepth}`)
    whitespace()
    const ch = text[index]
    if (ch === '{') {
      index += 1
      whitespace()
      const keys = new Set<string>()
      if (text[index] === '}') {
        index += 1
        return
      }
      while (true) {
        whitespace()
        if (text[index] !== '"') throw new SyntaxError('expected JSON object key')
        const token = stringToken()
        const key = JSON.parse(token) as string
        if (keys.has(key)) throw new SyntaxError(`duplicate JSON object key: ${key}`)
        keys.add(key)
        whitespace()
        if (text[index] !== ':') throw new SyntaxError('expected colon after JSON object key')
        index += 1
        value(depth + 1)
        whitespace()
        if (text[index] === '}') {
          index += 1
          return
        }
        if (text[index] !== ',') throw new SyntaxError('expected comma in JSON object')
        index += 1
      }
    }
    if (ch === '[') {
      index += 1
      whitespace()
      if (text[index] === ']') {
        index += 1
        return
      }
      while (true) {
        value(depth + 1)
        whitespace()
        if (text[index] === ']') {
          index += 1
          return
        }
        if (text[index] !== ',') throw new SyntaxError('expected comma in JSON array')
        index += 1
      }
    }
    if (ch === '"') {
      stringToken()
      return
    }
    const match = text.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)
    if (!match) throw new SyntaxError('invalid JSON value')
    if (/^-?(?:0|[1-9]\d*)$/.test(match[0])) {
      const integer = BigInt(match[0])
      if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new SyntaxError('JSON integer exceeds the interoperable safe-integer range; encode it as a string')
      }
    }
    index += match[0].length
  }

  value(0)
  whitespace()
  if (index !== text.length) throw new SyntaxError('unexpected data after JSON value')
  return parsed
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  if (!b64) throw new TypeError('public key PEM is empty')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function b64urlToBytes(value: string): Uint8Array {
  const b64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

function parseExactIso(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null
}

function parseNow(value: VerifyAttestationOptions['now']): number {
  if (value == null) return Date.now()
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new TypeError('verification now value is invalid')
  return timestamp
}

export async function deriveAttestationKeyId(publicKeyPem: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('WebCrypto (crypto.subtle) is unavailable')
  const digest = await subtle.digest('SHA-256', toArrayBuffer(pemToDer(publicKeyPem)))
  return `ed25519-${bytesToBase64url(new Uint8Array(digest)).slice(0, 16)}`
}

/** Verify using only the supplied envelope and caller-trusted key records. */
export async function verifyAttestationOffline(
  input: unknown,
  trustMaterial: TrustedAttestationKeySet,
  options: VerifyAttestationOptions = {}
): Promise<AttestationVerificationResult> {
  const components = initialComponents()
  let envelope: unknown
  try {
    envelope = typeof input === 'string' ? parseJsonNoDuplicateKeys(input) : input
  } catch (error) {
    components.structure = {
      state: 'FAIL',
      code: 'malformed_json',
      message: error instanceof Error ? error.message : 'Input is not valid JSON.',
    }
    return result('INVALID', 'malformed_json', components.structure.message, components)
  }

  if (
    !isObject(envelope) ||
    !Object.hasOwn(envelope, 'data') ||
    !isObject(envelope.attestation)
  ) {
    components.structure = {
      state: 'FAIL',
      code: 'malformed_envelope',
      message: 'Expected an object with data and attestation fields.',
    }
    return result('INVALID', 'malformed_envelope', components.structure.message, components)
  }

  const att = envelope.attestation
  if (
    att.signed !== true ||
    att.algorithm !== 'ed25519' ||
    typeof att.key_id !== 'string' ||
    !KEY_ID_PATTERN.test(att.key_id) ||
    typeof att.signature !== 'string' ||
    !SIGNATURE_PATTERN.test(att.signature) ||
    b64urlToBytes(att.signature).length !== 64 ||
    typeof att.issued_at !== 'string'
  ) {
    components.structure = {
      state: 'FAIL',
      code: 'malformed_attestation',
      message: 'Attestation metadata or Ed25519 signature encoding is invalid.',
    }
    return result('INVALID', 'malformed_attestation', components.structure.message, components)
  }
  components.structure = {
    state: 'PASS',
    code: 'well_formed',
    message: 'The attestation envelope is structurally valid.',
  }

  const keyId = att.key_id
  const hasVersion = Object.hasOwn(att, 'schema_version')
  const schemaVersion = hasVersion ? String(att.schema_version) : 'legacy-v1'
  const expectedIssuer = options.expectedIssuer ?? DEFAULT_ATTESTATION_ISSUER
  const allowedPurposes = options.allowedPurposes ?? [
    COMPLIANCE_ATTESTATION_PURPOSE,
    FIXTURE_ATTESTATION_PURPOSE,
  ]

  let signingInput: string
  const warnings: string[] = []
  try {
    if (hasVersion) {
      if (att.schema_version !== ATTESTATION_V2_SCHEMA) {
        components.identity = {
          state: 'UNKNOWN',
          code: 'unsupported_version',
          message: `Unsupported attestation schema: ${String(att.schema_version)}.`,
        }
        return result('UNVERIFIABLE', 'unsupported_version', components.identity.message, components, {
          keyId,
          schemaVersion,
        })
      }
      if (att.issuer !== expectedIssuer) {
        components.identity = {
          state: 'FAIL',
          code: 'wrong_issuer',
          message: `Expected issuer ${expectedIssuer}; received ${String(att.issuer)}.`,
        }
        return result('INVALID', 'wrong_issuer', components.identity.message, components, {
          keyId,
          schemaVersion,
        })
      }
      if (typeof att.purpose !== 'string' || !allowedPurposes.includes(att.purpose)) {
        components.identity = {
          state: 'FAIL',
          code: 'wrong_purpose',
          message: `Attestation purpose is not allowed: ${String(att.purpose)}.`,
        }
        return result('INVALID', 'wrong_purpose', components.identity.message, components, {
          keyId,
          schemaVersion,
        })
      }
      if (att.canonicalization !== 'RFC8785') {
        components.structure = {
          state: 'FAIL',
          code: 'wrong_canonicalization',
          message: 'Version 2 requires RFC8785 canonicalization.',
        }
        return result('INVALID', 'wrong_canonicalization', components.structure.message, components, {
          keyId,
          schemaVersion,
        })
      }
      signingInput = canonicalizeJson({
        schema_version: att.schema_version,
        issuer: att.issuer,
        purpose: att.purpose,
        data: envelope.data,
        issued_at: att.issued_at,
        key_id: keyId,
      })
      components.identity = {
        state: 'PASS',
        code: 'v2_domain_match',
        message: 'Signed issuer and purpose match the verifier policy.',
      }
    } else {
      signingInput = JSON.stringify({
        data: envelope.data,
        issued_at: att.issued_at,
        key_id: keyId,
      })
      warnings.push(
        'Legacy v1 has no signed schema, issuer, purpose, or canonicalization fields.'
      )
      components.identity = {
        state: 'PASS',
        code: 'legacy_exact_key_trust',
        message: 'Legacy identity is bound only through the caller-trusted exact key.',
      }
    }
  } catch (error) {
    components.structure = {
      state: 'FAIL',
      code: 'invalid_json_model',
      message: error instanceof Error ? error.message : 'Signed data is not canonicalizable JSON.',
    }
    return result('INVALID', 'invalid_json_model', components.structure.message, components, {
      keyId,
      schemaVersion,
    })
  }

  const issuedAt = parseExactIso(att.issued_at)
  if (issuedAt == null) {
    components.timestamp = {
      state: 'FAIL',
      code: 'invalid_issued_at',
      message: 'issued_at must be an exact UTC ISO-8601 timestamp.',
    }
    return result('INVALID', 'invalid_issued_at', components.timestamp.message, components, {
      keyId,
      schemaVersion,
      warnings,
    })
  }
  const now = parseNow(options.now)
  const maxFutureSkewMs = options.maxFutureSkewMs ?? 5 * 60 * 1000
  if (issuedAt > now + maxFutureSkewMs) {
    components.timestamp = {
      state: 'FAIL',
      code: 'future_issued_at',
      message: 'issued_at is beyond the allowed future clock skew.',
    }
    return result('INVALID', 'future_issued_at', components.timestamp.message, components, {
      keyId,
      schemaVersion,
      warnings,
    })
  }
  components.timestamp = {
    state: 'PASS',
    code: 'signed_time_well_formed',
    message: "The signature authenticates the signer's timestamp assertion; it is not external time proof.",
  }

  const matchingKeys = Array.isArray(trustMaterial?.keys)
    ? trustMaterial.keys.filter((key) => key?.key_id === keyId)
    : []
  if (matchingKeys.length === 0) {
    components.identity = {
      state: 'UNKNOWN',
      code: 'unknown_key',
      message: `Caller-supplied trust material has no exact record for ${keyId}.`,
    }
    return result('UNVERIFIABLE', 'unknown_key', components.identity.message, components, {
      keyId,
      schemaVersion,
      warnings,
    })
  }
  if (matchingKeys.length !== 1) {
    components.identity = {
      state: 'UNKNOWN',
      code: 'duplicate_trusted_key',
      message: `Caller-supplied trust material contains duplicate records for ${keyId}.`,
    }
    return result('UNVERIFIABLE', 'duplicate_trusted_key', components.identity.message, components, {
      keyId,
      schemaVersion,
      warnings,
    })
  }
  const keyRecord = matchingKeys[0]
  if (keyRecord.algorithm !== 'ed25519' || typeof keyRecord.public_key_pem !== 'string') {
    components.identity = {
      state: 'UNKNOWN',
      code: 'unusable_trust_material',
      message: 'Trusted key metadata is missing a usable Ed25519 public key.',
    }
    return result('UNVERIFIABLE', 'unusable_trust_material', components.identity.message, components, {
      keyId,
      schemaVersion,
      keyStatus: keyRecord.status,
      warnings,
    })
  }

  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    components.signature = {
      state: 'UNKNOWN',
      code: 'webcrypto_unavailable',
      message: 'WebCrypto Ed25519 verification is unavailable in this runtime.',
    }
    return result('UNVERIFIABLE', 'webcrypto_unavailable', components.signature.message, components, {
      keyId,
      schemaVersion,
      keyStatus: keyRecord.status,
      warnings,
    })
  }

  let der: Uint8Array
  let publicKey: CryptoKey
  try {
    der = pemToDer(keyRecord.public_key_pem)
    const derivedKeyId = await deriveAttestationKeyId(keyRecord.public_key_pem)
    if (derivedKeyId !== keyId) {
      components.identity = {
        state: 'FAIL',
        code: 'key_id_spki_mismatch',
        message: `Key ID ${keyId} does not match the supplied SPKI public key.`,
      }
      return result('INVALID', 'key_id_spki_mismatch', components.identity.message, components, {
        keyId,
        schemaVersion,
        keyStatus: keyRecord.status,
        warnings,
      })
    }
    publicKey = await subtle.importKey('spki', toArrayBuffer(der), { name: 'Ed25519' }, false, ['verify'])
  } catch (error) {
    components.identity = {
      state: 'UNKNOWN',
      code: 'unusable_public_key',
      message: error instanceof Error ? error.message : 'The supplied public key is unusable.',
    }
    return result('UNVERIFIABLE', 'unusable_public_key', components.identity.message, components, {
      keyId,
      schemaVersion,
      keyStatus: keyRecord.status,
      warnings,
    })
  }

  const signatureValid = await subtle.verify(
    'Ed25519',
    publicKey,
    toArrayBuffer(b64urlToBytes(att.signature)),
    toArrayBuffer(new TextEncoder().encode(signingInput))
  )
  components.signature = signatureValid
    ? { state: 'PASS', code: 'signature_valid', message: 'Ed25519 signature matches.' }
    : { state: 'FAIL', code: 'signature_mismatch', message: 'Ed25519 signature does not match.' }
  if (!signatureValid) {
    return result('INVALID', 'signature_mismatch', components.signature.message, components, {
      keyId,
      schemaVersion,
      keyStatus: keyRecord.status,
      cryptographicallyValid: false,
      trusted: false,
      warnings,
    })
  }

  if (keyRecord.status === 'compromised' || keyRecord.status === 'revoked') {
    components.lifecycle = {
      state: 'FAIL',
      code: `key_${keyRecord.status}`,
      message: `The exact signing key is marked ${keyRecord.status} and fails closed.`,
    }
    return result('INVALID', `key_${keyRecord.status}`, components.lifecycle.message, components, {
      keyId,
      schemaVersion,
      keyStatus: keyRecord.status,
      cryptographicallyValid: true,
      trusted: false,
      warnings,
    })
  }
  if (keyRecord.status !== 'active' && keyRecord.status !== 'retired') {
    components.lifecycle = {
      state: 'UNKNOWN',
      code: 'unknown_key_status',
      message: `Unsupported key lifecycle status: ${String(keyRecord.status)}.`,
    }
    return result('UNVERIFIABLE', 'unknown_key_status', components.lifecycle.message, components, {
      keyId,
      schemaVersion,
      keyStatus: keyRecord.status,
      cryptographicallyValid: true,
      trusted: false,
      warnings,
    })
  }
  components.lifecycle = {
    state: 'PASS',
    code: keyRecord.status === 'active' ? 'key_active' : 'key_retired_historical',
    message:
      keyRecord.status === 'active'
        ? 'The exact key is active.'
        : 'The exact key is normally retired and may verify historical signatures in its interval.',
  }

  const requireValidFrom = options.requireValidFrom ?? true
  const validFrom = keyRecord.valid_from == null ? null : parseExactIso(keyRecord.valid_from)
  const validUntil = keyRecord.valid_until == null ? null : parseExactIso(keyRecord.valid_until)
  if (requireValidFrom && validFrom == null) {
    components.key_window = {
      state: 'UNKNOWN',
      code: 'missing_valid_from',
      message: 'Trusted key metadata lacks the required valid_from boundary.',
    }
    return result('UNVERIFIABLE', 'missing_valid_from', components.key_window.message, components, {
      keyId,
      schemaVersion,
      keyStatus: keyRecord.status,
      cryptographicallyValid: true,
      trusted: false,
      warnings,
    })
  }
  if (
    (keyRecord.valid_from != null && validFrom == null) ||
    (keyRecord.valid_until != null && validUntil == null) ||
    (validFrom != null && validUntil != null && validUntil < validFrom) ||
    (keyRecord.status === 'retired' && validUntil == null)
  ) {
    components.key_window = {
      state: 'UNKNOWN',
      code: 'unsafe_key_interval',
      message: 'Trusted key metadata contains an incomplete or incoherent validity interval.',
    }
    return result('UNVERIFIABLE', 'unsafe_key_interval', components.key_window.message, components, {
      keyId,
      schemaVersion,
      keyStatus: keyRecord.status,
      cryptographicallyValid: true,
      trusted: false,
      warnings,
    })
  }
  if ((validFrom != null && issuedAt < validFrom) || (validUntil != null && issuedAt > validUntil)) {
    components.key_window = {
      state: 'FAIL',
      code: 'outside_key_validity',
      message: 'issued_at falls outside the exact key validity interval.',
    }
    return result('INVALID', 'outside_key_validity', components.key_window.message, components, {
      keyId,
      schemaVersion,
      keyStatus: keyRecord.status,
      cryptographicallyValid: true,
      trusted: false,
      warnings,
    })
  }
  components.key_window = {
    state: 'PASS',
    code: 'inside_key_validity',
    message: 'issued_at falls inside the exact key validity interval.',
  }

  if (options.maxAgeMs != null) {
    if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
      throw new TypeError('maxAgeMs must be a non-negative finite number')
    }
    const age = now - issuedAt
    components.freshness =
      age <= options.maxAgeMs
        ? { state: 'PASS', code: 'fresh', message: 'Attestation satisfies the requested max age.' }
        : { state: 'FAIL', code: 'stale', message: 'Attestation exceeds the requested max age.' }
    if (components.freshness.state === 'FAIL') {
      return result('INVALID', 'stale', components.freshness.message, components, {
        keyId,
        schemaVersion,
        keyStatus: keyRecord.status,
        cryptographicallyValid: true,
        trusted: true,
        warnings,
      })
    }
  }

  return result('VALID', 'valid', 'Attestation is valid under the supplied trust policy.', components, {
    keyId,
    schemaVersion,
    keyStatus: keyRecord.status,
    cryptographicallyValid: true,
    trusted: true,
    warnings,
  })
}
