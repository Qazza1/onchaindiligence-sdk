/**
 * @onchaindiligence/sdk
 * ---------------------
 * A small, typed client for the OnchainDiligence compliance API that hides the
 * 402 "pay-per-call" dance entirely. You provide a funded account once; every
 * method call transparently handles the payment challenge, settles on Tempo,
 * and returns a typed, signed result.
 *
 *   import { OnchainDiligence } from '@onchaindiligence/sdk'
 *   import { privateKeyToAccount } from 'viem/accounts'
 *
 *   const od = new OnchainDiligence({
 *     account: privateKeyToAccount(process.env.PAYER_KEY),
 *   })
 *
 *   const result = await od.screen('0x7f26…38E5')
 *   if (result.data.sanctioned) { ... }
 *
 * Under the hood this wraps `mppx/client`, which provides the payment-aware
 * fetch. The SDK's job is ergonomics: clean methods, typed responses, and one
 * place to configure the payer — so a developer never has to parse a 402,
 * build a payment header, or retry a request by hand.
 */

import { Mppx, tempo } from 'mppx/client'
import type { Account } from 'viem'

export interface OnchainDiligenceOptions {
  /** A viem account used to sign/settle payments (e.g. privateKeyToAccount). */
  account: Account
  /** Base URL of the API. Defaults to production. */
  baseUrl?: string
  /** Expected issuer for versioned attestations. Defaults to the production issuer. */
  expectedAttestationIssuer?: string
}

/** The signed-attestation envelope every paid response carries. */
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
}

export type AttestationKeyStatus = 'active' | 'retired' | 'revoked' | 'compromised'

export interface AttestationKeyRecord {
  key_id: string
  algorithm: 'ed25519'
  public_key_pem: string
  status: AttestationKeyStatus
  valid_from: string | null
  valid_until: string | null
  status_changed_at: string | null
  status_reason?: string
}

export interface Signed<T> {
  data: T
  attestation: Attestation
}

/** Result of locally verifying a signed attestation. */
export interface VerifyResult {
  valid: boolean
  /** Whether the Ed25519 signature itself matched, even if the key is distrusted. */
  cryptographicallyValid?: boolean
  /** Whether policy permits trusting this key status. */
  trusted?: boolean
  keyStatus?: AttestationKeyStatus
  schemaVersion?: string
  /** The key_id the signature was checked against, when available. */
  keyId?: string
  /** Human-readable reason when `valid` is false. */
  reason?: string
}

/** One address's outcome within a re-screen batch. */
export interface RescreenItem {
  address: string
  /** True if the screen call succeeded; false if it errored. */
  ok: boolean
  /** Present when ok: whether the address is currently sanctioned. */
  sanctioned?: boolean
  /** Present when ok: the full signed result (verify with verifyAttestation). */
  result?: Signed<SanctionsResult>
  /** Present when ok is false: why this address failed. */
  error?: string
}

export interface RescreenOptions {
  /** Max concurrent screens (default 4). Kept modest to respect rate limits. */
  concurrency?: number
  /** Fired as each address resolves — useful for progress UI. */
  onResult?: (item: RescreenItem) => void
}

/** Summary of a re-screen batch: the "who is flagged now" answer. */
export interface RescreenReport {
  total: number
  /** How many screens succeeded. */
  screened: number
  /** How many came back sanctioned. */
  flagged: number
  /** How many errored. */
  errors: number
  /** The addresses that are currently sanctioned — act on these. */
  flaggedAddresses: string[]
  items: RescreenItem[]
}

export interface SanctionsResult {
  address: string
  sanctioned: boolean
  identifications: unknown[]
  source: string
  checked_at: string
}

export interface NameScreenMatch {
  ent_num: number
  matched_name: string
  matched_on: 'primary' | 'alias'
  sdn_type: string | null
  program: string | null
  score: number
}

export interface NameScreenResult {
  query: string
  normalized_query: string
  hit: boolean
  matches: NameScreenMatch[]
  list_date: string | null
  threshold: number
  source: string
  note: string
}

export interface CompanyResult {
  profile: {
    companyNumber: string
    companyName: string
    status: string
    incorporatedOn?: string
    registeredAddress?: string
  }
  pscList: unknown[]
  source: string
}

/** US public-company record from SEC EDGAR (public companies & funds only). */
export interface USCompanyResult {
  source: string
  cik: string
  name: string | null
  former_names: string[]
  entity_type: string | null
  sic: string | null
  sic_description: string | null
  state_of_incorporation: string | null
  tickers: string[]
  exchanges: string[]
  business_address: {
    street1: string | null
    street2: string | null
    city: string | null
    state_or_country: string | null
    zip_code: string | null
  } | null
  latest_filing: {
    form: string | null
    filing_date: string | null
    primary_document: string | null
  } | null
  /** Explicit reminder that "not found" means "not an SEC filer", not "not real". */
  coverage_note: string
  checked_at?: string
}

export interface DiligenceResult {
  wallet_check?: unknown
  company_check?: unknown
  link_disclaimer: string
  checked_at: string
}

export interface AnchorResult {
  anchor_hash: string
  tx_hash: string | null
  already_anchored: boolean
  chain: string
  contract: string
  note: string
}

export interface AnchorStatus {
  anchor_hash: string
  anchored: boolean
  anchored_at: string | null
  chain: string
  contract: string
}

export class OnchainDiligenceError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'OnchainDiligenceError'
  }
}

const DEFAULT_BASE_URL = 'https://api.onchaindiligence.com'
const DEFAULT_ATTESTATION_ISSUER = 'https://api.onchaindiligence.com'
const V2_SCHEMA = 'onchaindiligence.attestation.v2'
const V2_PURPOSE = 'compliance-screening-result'
const V2_FIXTURE_PURPOSE = 'verification-fixture'

export class OnchainDiligence {
  private readonly baseUrl: string
  private readonly expectedAttestationIssuer: string
  private readonly fetch: typeof globalThis.fetch
  private readonly attestationKeys = new Map<string, AttestationKeyRecord>()

  constructor(opts: OnchainDiligenceOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.expectedAttestationIssuer = opts.expectedAttestationIssuer ?? DEFAULT_ATTESTATION_ISSUER
    // Payment-aware fetch: transparently answers 402 challenges and retries.
    const client = Mppx.create({ methods: [tempo({ account: opts.account })] })
    this.fetch = client.fetch
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetch(`${this.baseUrl}${path}`)
    return this.handle<T>(res)
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return this.handle<T>(res)
  }

  private async handle<T>(res: Response): Promise<T> {
    if (!res.ok) {
      let detail = res.statusText
      try {
        const j = (await res.json()) as { error?: string; detail?: string }
        detail = j.detail || j.error || detail
      } catch {
        /* non-JSON error body */
      }
      throw new OnchainDiligenceError(res.status, detail)
    }
    return (await res.json()) as T
  }

  // --- Checks (paid) -------------------------------------------------------

  /** Sanctions-screen a wallet address against the Chainalysis on-chain oracle. */
  screen(address: string): Promise<Signed<SanctionsResult>> {
    return this.get(`/screen/${encodeURIComponent(address)}`)
  }

  /** Screen a person/company name against the OFAC SDN list (fuzzy match). */
  screenName(
    name: string,
    opts?: { threshold?: number }
  ): Promise<Signed<NameScreenResult>> {
    const q = new URLSearchParams({ name })
    if (opts?.threshold != null) q.set('threshold', String(opts.threshold))
    return this.get(`/screen-name?${q.toString()}`)
  }

  /** Verify a UK company by its Companies House registration number. */
  verifyCompany(companyNumber: string): Promise<Signed<CompanyResult>> {
    return this.get(`/company/${encodeURIComponent(companyNumber)}`)
  }

  /**
   * Verify a US public company via SEC EDGAR, by ticker, CIK, or name.
   * Covers SEC-registered public companies and funds only — a "not found"
   * (404) means "not an SEC filer", not "not a real company".
   */
  verifyUSCompany(query: string): Promise<Signed<USCompanyResult>> {
    const qs = new URLSearchParams({ q: query })
    return this.get(`/us-company?${qs.toString()}`)
  }

  /** Run wallet + company checks together (independent results). */
  diligence(params: {
    wallet?: string
    company?: string
  }): Promise<Signed<DiligenceResult>> {
    const q = new URLSearchParams()
    if (params.wallet) q.set('wallet', params.wallet)
    if (params.company) q.set('company', params.company)
    return this.get(`/diligence?${q.toString()}`)
  }

  /**
   * Re-screen a list of wallet addresses and report which are now flagged.
   * The "watch my counterparties" primitive: store your address list, call
   * this on a schedule, and act on `flaggedAddresses`.
   *
   * Each address is a separate paid `/screen` call, fanned out client-side
   * with bounded concurrency — so the cost is the per-call sanctions price
   * times the number of unique addresses, and every result carries its own
   * signed attestation. Per-address failures are captured, not thrown, so one
   * bad address never sinks the whole batch.
   */
  async rescreen(addresses: string[], opts?: RescreenOptions): Promise<RescreenReport> {
    const concurrency = Math.max(1, opts?.concurrency ?? 4)
    const unique = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))]
    const items: RescreenItem[] = new Array(unique.length)

    let next = 0
    const worker = async (): Promise<void> => {
      for (let i = next++; i < unique.length; i = next++) {
        const address = unique[i]
        let item: RescreenItem
        try {
          const result = await this.screen(address)
          item = { address, ok: true, sanctioned: result.data.sanctioned, result }
        } catch (err) {
          item = { address, ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        items[i] = item
        opts?.onResult?.(item)
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, unique.length) }, () => worker())
    )

    const flaggedAddresses = items.filter((it) => it.sanctioned).map((it) => it.address)
    return {
      total: unique.length,
      screened: items.filter((it) => it.ok).length,
      flagged: flaggedAddresses.length,
      errors: items.filter((it) => !it.ok).length,
      flaggedAddresses,
      items,
    }
  }

  /** Anchor an attestation's signature hash on Tempo (paid). */
  anchor(signature: string): Promise<Signed<AnchorResult>> {
    return this.post(`/anchor`, { signature })
  }

  // --- Free endpoints ------------------------------------------------------

  /** Check whether an attestation has been anchored on-chain (free). */
  anchored(signature: string): Promise<AnchorStatus> {
    return this.get(`/anchored?signature=${encodeURIComponent(signature)}`)
  }

  /** Service health (free). */
  health(): Promise<{
    status: 'ok' | 'degraded'
    upstreams: Record<string, string>
    attestation: string
  }> {
    return this.get(`/health`)
  }

  // --- Verification (local, free, no trust in this SDK or the server) -------

  /**
   * Verify a signed attestation locally. Fetches the server's published
   * exact Ed25519 key identified by `key_id` (cached), then verifies either
   * the domain-separated RFC 8785 version 2 input or the legacy version 1
   * JSON.stringify input. Revoked/compromised keys remain cryptographically
   * checkable but return `valid: false` and `trusted: false`.
   *
   * Uses WebCrypto (`globalThis.crypto.subtle`) so it runs dependency-free in
   * Node 18+, edge runtimes, and modern browsers.
   */
  async verifyAttestation(signed: Signed<unknown>): Promise<VerifyResult> {
    const att = signed?.attestation
    if (!att || att.signed === false) return { valid: false, reason: 'response is not signed' }
    if (!att.signature || !att.key_id || !att.issued_at) {
      return { valid: false, reason: 'attestation is missing signature, key_id, or issued_at' }
    }
    if (att.algorithm && att.algorithm !== 'ed25519') {
      return { valid: false, reason: `unsupported algorithm: ${att.algorithm}`, keyId: att.key_id }
    }
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return { valid: false, reason: 'WebCrypto (crypto.subtle) is unavailable in this runtime' }

    let key: CryptoKey
    let keyRecord: AttestationKeyRecord
    try {
      keyRecord = await this.getAttestationKey(att.key_id)
      key = await subtle.importKey(
        'spki',
        pemToDer(keyRecord.public_key_pem),
        { name: 'Ed25519' },
        false,
        ['verify']
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { valid: false, reason: `could not load public key: ${msg}`, keyId: att.key_id }
    }

    let signingInput: string
    if (att.schema_version === V2_SCHEMA) {
      if (att.issuer !== this.expectedAttestationIssuer) {
        return {
          valid: false,
          trusted: false,
          reason: `unexpected attestation issuer: ${att.issuer ?? 'missing'}`,
          keyId: att.key_id,
          keyStatus: keyRecord.status,
          schemaVersion: att.schema_version,
        }
      }
      if (
        (att.purpose !== V2_PURPOSE && att.purpose !== V2_FIXTURE_PURPOSE) ||
        att.canonicalization !== 'RFC8785'
      ) {
        return {
          valid: false,
          trusted: false,
          reason: 'version 2 attestation has an unexpected purpose or canonicalization',
          keyId: att.key_id,
          keyStatus: keyRecord.status,
          schemaVersion: att.schema_version,
        }
      }
      signingInput = canonicalizeJson({
        schema_version: att.schema_version,
        issuer: att.issuer,
        purpose: att.purpose,
        data: signed.data,
        issued_at: att.issued_at,
        key_id: att.key_id,
      })
    } else if (!att.schema_version) {
      signingInput = JSON.stringify({
        data: signed.data,
        issued_at: att.issued_at,
        key_id: att.key_id,
      })
    } else {
      return {
        valid: false,
        trusted: false,
        reason: `unsupported attestation schema: ${att.schema_version}`,
        keyId: att.key_id,
        keyStatus: keyRecord.status,
        schemaVersion: att.schema_version,
      }
    }
    const ok = await subtle.verify(
      'Ed25519',
      key,
      b64urlToBytes(att.signature),
      new TextEncoder().encode(signingInput)
    )
    if (!ok) {
      return {
        valid: false,
        cryptographicallyValid: false,
        trusted: false,
        reason: 'signature does not match',
        keyId: att.key_id,
        keyStatus: keyRecord.status,
        schemaVersion: att.schema_version ?? 'legacy-v1',
      }
    }

    const trusted = keyRecord.status === 'active' || keyRecord.status === 'retired'
    return {
      valid: trusted,
      cryptographicallyValid: true,
      trusted,
      ...(trusted ? {} : { reason: `attestation key is ${keyRecord.status}` }),
      keyId: att.key_id,
      keyStatus: keyRecord.status,
      schemaVersion: att.schema_version ?? 'legacy-v1',
    }
  }

  /**
   * Resolve and cache the exact public key named in an attestation. The legacy
   * current-key endpoint is accepted only when its reported key_id matches.
   */
  private async getAttestationKey(keyId: string): Promise<AttestationKeyRecord> {
    const cached = this.attestationKeys.get(keyId)
    if (cached) return cached

    const exact = await this.fetch(
      `${this.baseUrl}/.well-known/attestation-keys/${encodeURIComponent(keyId)}`
    )
    if (exact.ok) {
      const payload = (await exact.json()) as { key?: AttestationKeyRecord }
      const record = payload.key
      if (!record || record.key_id !== keyId || !record.public_key_pem?.includes('BEGIN PUBLIC KEY')) {
        throw new Error('attestation key registry returned an invalid or mismatched key')
      }
      this.attestationKeys.set(keyId, record)
      return record
    }
    if (exact.status !== 404) {
      throw new OnchainDiligenceError(exact.status, 'could not fetch attestation public key')
    }

    const legacy = await this.fetch(`${this.baseUrl}/.well-known/attestation-key`)
    if (!legacy.ok) {
      throw new OnchainDiligenceError(legacy.status, 'could not fetch attestation public key')
    }
    const text = await legacy.text()
    let reportedKeyId = ''
    let pem = text.trim()
    if (!pem.includes('BEGIN PUBLIC KEY')) {
      const payload = JSON.parse(text) as Record<string, string>
      reportedKeyId = payload.key_id || ''
      pem = (payload.public_key_pem || payload.publicKey || payload.pem || payload.key || '').trim()
    }
    if (reportedKeyId !== keyId || !pem.includes('BEGIN PUBLIC KEY')) {
      throw new Error('legacy attestation-key endpoint did not return the requested key_id')
    }
    const record: AttestationKeyRecord = {
      key_id: keyId,
      algorithm: 'ed25519',
      public_key_pem: pem,
      status: 'active',
      valid_from: null,
      valid_until: null,
      status_changed_at: null,
    }
    this.attestationKeys.set(keyId, record)
    return record
  }
}

// --- Internal helpers (isomorphic: no Buffer, no Node built-ins) ------------

/** Decode a PEM (SPKI) public key to its raw DER bytes. */
function pemToDer(pem: string) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Decode a base64url string to bytes. */
function b64urlToBytes(s: string) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** RFC 8785 canonicalization for values already in the JSON data model. */
function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number in attestation')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(',')}}`
  }
  throw new TypeError(`value of type ${typeof value} is not valid JSON`)
}
