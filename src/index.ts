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
}

/** The signed-attestation envelope every paid response carries. */
export interface Attestation {
  signed: boolean
  key_id?: string
  algorithm?: string
  signature?: string
  issued_at?: string
}

export interface Signed<T> {
  data: T
  attestation: Attestation
}

/** Result of locally verifying a signed attestation. */
export interface VerifyResult {
  valid: boolean
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

export class OnchainDiligence {
  private readonly baseUrl: string
  private readonly fetch: typeof globalThis.fetch
  private attestationKeyPem: string | null = null

  constructor(opts: OnchainDiligenceOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
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
   * Ed25519 public key once (cached), then checks the signature over the
   * canonical signing input `JSON.stringify({ data, issued_at, key_id })` —
   * the exact bytes the server signs. A `valid: true` result means the data
   * has not been altered since the server signed it, provable without trusting
   * this SDK.
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
    try {
      const pem = await this.getAttestationKeyPem()
      key = await subtle.importKey('spki', pemToDer(pem), { name: 'Ed25519' }, false, ['verify'])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { valid: false, reason: `could not load public key: ${msg}`, keyId: att.key_id }
    }

    const signingInput = JSON.stringify({
      data: signed.data,
      issued_at: att.issued_at,
      key_id: att.key_id,
    })
    const ok = await subtle.verify(
      'Ed25519',
      key,
      b64urlToBytes(att.signature),
      new TextEncoder().encode(signingInput)
    )
    return ok
      ? { valid: true, keyId: att.key_id }
      : { valid: false, reason: 'signature does not match', keyId: att.key_id }
  }

  /**
   * Fetch and cache the server's Ed25519 public key (PEM) from
   * `/.well-known/attestation-key`. Accepts a raw PEM body or a JSON wrapper
   * exposing the PEM under a common field name.
   */
  private async getAttestationKeyPem(): Promise<string> {
    if (this.attestationKeyPem) return this.attestationKeyPem
    const res = await this.fetch(`${this.baseUrl}/.well-known/attestation-key`)
    if (!res.ok) {
      throw new OnchainDiligenceError(res.status, 'could not fetch attestation public key')
    }
    const text = await res.text()
    let pem = text.trim()
    if (!pem.includes('BEGIN PUBLIC KEY')) {
      try {
        const j = JSON.parse(text) as Record<string, string>
        pem = (j.public_key_pem || j.publicKey || j.pem || j.key || '').trim()
      } catch {
        /* not JSON — fall through to the check below */
      }
    }
    if (!pem.includes('BEGIN PUBLIC KEY')) {
      throw new Error('attestation-key endpoint did not return a PEM public key')
    }
    this.attestationKeyPem = pem
    return pem
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
