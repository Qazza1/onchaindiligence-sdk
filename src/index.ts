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
}
