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
import {
  DEFAULT_ATTESTATION_ISSUER,
  verifyAttestationOffline,
  type Attestation,
  type AttestationKeyRecord,
  type AttestationVerificationResult,
  type Signed,
  type TrustedAttestationKeySet,
  type VerifyAttestationOptions,
} from './verification.js'

export * from './verification.js'

export interface OnchainDiligenceOptions {
  /** A viem account used to sign/settle payments (e.g. privateKeyToAccount). */
  account: Account
  /** Base URL of the API. Defaults to production. */
  baseUrl?: string
  /** Expected issuer for versioned attestations. Defaults to the production issuer. */
  expectedAttestationIssuer?: string
}

/** @deprecated Use AttestationVerificationResult and inspect its state. */
export type VerifyResult = AttestationVerificationResult

export interface OnlineAttestationVerificationOptions extends VerifyAttestationOptions {
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  /**
   * Explicit policy decision to trust exact key records delivered by the
   * configured HTTPS issuer registry. Without this, valid bytes remain
   * UNVERIFIABLE for publisher identity.
   */
  trustRegistry?:
    | boolean
    | ((record: AttestationKeyRecord, context: { baseUrl: string }) => boolean | Promise<boolean>)
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
export async function resolveAttestationKeyOnline(
  keyId: string,
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {}
): Promise<AttestationKeyRecord> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (!fetchImpl) throw new Error('fetch is unavailable in this runtime')

  const exact = await fetchImpl(
    `${baseUrl}/.well-known/attestation-keys/${encodeURIComponent(keyId)}`
  )
  if (exact.ok) {
    const payload = (await exact.json()) as { key?: AttestationKeyRecord }
    if (!payload.key || payload.key.key_id !== keyId) {
      throw new Error('attestation key registry returned an invalid or mismatched key')
    }
    return payload.key
  }
  if (exact.status !== 404) {
    throw new OnchainDiligenceError(exact.status, 'could not fetch attestation public key')
  }

  const legacy = await fetchImpl(`${baseUrl}/.well-known/attestation-key`)
  if (!legacy.ok) {
    throw new OnchainDiligenceError(legacy.status, 'could not fetch attestation public key')
  }
  const text = await legacy.text()
  let reportedKeyId = ''
  let pem = text.trim()
  let algorithm = 'ed25519'
  let status: AttestationKeyRecord['status'] = 'active'
  if (!pem.includes('BEGIN PUBLIC KEY')) {
    const payload = JSON.parse(text) as Record<string, string>
    reportedKeyId = payload.key_id || ''
    pem = (payload.public_key_pem || payload.publicKey || payload.pem || payload.key || '').trim()
    algorithm = payload.algorithm || algorithm
    status = (payload.status as AttestationKeyRecord['status']) || status
  }
  if (reportedKeyId !== keyId || !pem.includes('BEGIN PUBLIC KEY') || algorithm !== 'ed25519') {
    throw new Error('legacy attestation-key endpoint did not return the requested key_id')
  }
  return {
    key_id: keyId,
    algorithm: 'ed25519',
    public_key_pem: pem,
    status,
    valid_from: null,
    valid_until: null,
    status_changed_at: null,
  }
}

/** Validate and return the complete signed envelope required by `/anchor`. */
export function buildAnchorRequest(envelope: Signed<unknown>): Signed<unknown> {
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    !Object.hasOwn(envelope, 'data') ||
    !envelope.attestation ||
    typeof envelope.attestation !== 'object' ||
    envelope.attestation.signed !== true
  ) {
    throw new TypeError('anchor requires the complete signed attestation envelope')
  }
  return envelope
}

/** Explicit online-discovery wrapper around the zero-network verifier core. */
export async function verifyAttestationOnline(
  signed: unknown,
  options: OnlineAttestationVerificationOptions = {}
): Promise<AttestationVerificationResult> {
  let parsed: unknown = signed
  if (typeof signed === 'string') {
    try {
      parsed = JSON.parse(signed)
    } catch {
      return verifyAttestationOffline(signed, { keys: [] }, options)
    }
  }
  const keyId = (parsed as { attestation?: { key_id?: unknown } })?.attestation?.key_id
  if (typeof keyId !== 'string') {
    return verifyAttestationOffline(signed, { keys: [] }, options)
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  let record: AttestationKeyRecord
  try {
    record = await resolveAttestationKeyOnline(keyId, { baseUrl, fetch: options.fetch })
  } catch (error) {
    const offline = await verifyAttestationOffline(signed, { keys: [] }, options)
    if (offline.state === 'INVALID') return offline
    return {
      ...offline,
      state: 'UNVERIFIABLE',
      valid: false,
      code: 'online_key_resolution_failed',
      reason: error instanceof Error ? error.message : 'Online key resolution failed.',
    }
  }

  const material: TrustedAttestationKeySet = {
    keys: [record],
    issuer: options.expectedIssuer ?? DEFAULT_ATTESTATION_ISSUER,
    trust_source: `online-registry:${baseUrl}`,
  }
  const offline = await verifyAttestationOffline(signed, material, options)
  const trustDecision =
    typeof options.trustRegistry === 'function'
      ? await options.trustRegistry(record, { baseUrl })
      : options.trustRegistry === true
  if (trustDecision || offline.state === 'INVALID') return offline

  return {
    ...offline,
    state: 'UNVERIFIABLE',
    valid: false,
    code: 'online_registry_not_trusted',
    reason: 'The key was discovered online but the caller did not trust that registry as identity authority.',
    trusted: false,
    components: {
      ...offline.components,
      identity: {
        state: 'UNKNOWN',
        code: 'online_registry_not_trusted',
        message: 'Online key discovery is not an out-of-band trust decision.',
      },
    },
  }
}

export class OnchainDiligence {
  private readonly baseUrl: string
  private readonly expectedAttestationIssuer: string
  private readonly fetch: typeof globalThis.fetch

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

  /** Anchor a complete authentic attestation envelope on Tempo (paid). */
  anchor(envelope: Signed<unknown>): Promise<Signed<AnchorResult>> {
    return this.post(`/anchor`, buildAnchorRequest(envelope))
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
  /**
   * Compatibility online wrapper. Prefer the standalone zero-network
   * verifyAttestationOffline() with caller-supplied trust material.
   */
  verifyAttestation(signed: Signed<unknown>): Promise<VerifyResult> {
    return verifyAttestationOnline(signed, {
      baseUrl: this.baseUrl,
      expectedIssuer: this.expectedAttestationIssuer,
      fetch: this.fetch,
      // This preserves the historical SDK behavior: constructing this client
      // explicitly chooses its configured HTTPS issuer registry as authority.
      trustRegistry: true,
      // Compatibility until production publishes a real activation boundary.
      requireValidFrom: false,
    })
  }

  verifyAttestationOnline(
    signed: Signed<unknown>,
    options: Omit<OnlineAttestationVerificationOptions, 'baseUrl' | 'fetch'> = {}
  ): Promise<AttestationVerificationResult> {
    return verifyAttestationOnline(signed, {
      ...options,
      baseUrl: this.baseUrl,
      expectedIssuer: options.expectedIssuer ?? this.expectedAttestationIssuer,
      fetch: this.fetch,
    })
  }
}
