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
import type { Account } from 'viem';
import { type AttestationKeyRecord, type AttestationVerificationResult, type Signed, type VerifyAttestationOptions } from './verification.js';
export * from './verification.js';
export interface OnchainDiligenceOptions {
    /** A viem account used to sign/settle payments (e.g. privateKeyToAccount). */
    account: Account;
    /** Base URL of the API. Defaults to production. */
    baseUrl?: string;
    /** Expected issuer for versioned attestations. Defaults to the production issuer. */
    expectedAttestationIssuer?: string;
}
/** @deprecated Use AttestationVerificationResult and inspect its state. */
export type VerifyResult = AttestationVerificationResult;
export interface OnlineAttestationVerificationOptions extends VerifyAttestationOptions {
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
    /**
     * Explicit policy decision to trust exact key records delivered by the
     * configured HTTPS issuer registry. Without this, valid bytes remain
     * UNVERIFIABLE for publisher identity.
     */
    trustRegistry?: boolean | ((record: AttestationKeyRecord, context: {
        baseUrl: string;
    }) => boolean | Promise<boolean>);
}
/** One address's outcome within a re-screen batch. */
export interface RescreenItem {
    address: string;
    /** True if the screen call succeeded; false if it errored. */
    ok: boolean;
    /** Present when ok: whether the address is currently sanctioned. */
    sanctioned?: boolean;
    /** Present when ok: the full signed result (verify with verifyAttestation). */
    result?: Signed<SanctionsResult>;
    /** Present when ok is false: why this address failed. */
    error?: string;
}
export interface RescreenOptions {
    /** Max concurrent screens (default 4). Kept modest to respect rate limits. */
    concurrency?: number;
    /** Fired as each address resolves — useful for progress UI. */
    onResult?: (item: RescreenItem) => void;
}
/** Summary of a re-screen batch: the "who is flagged now" answer. */
export interface RescreenReport {
    total: number;
    /** How many screens succeeded. */
    screened: number;
    /** How many came back sanctioned. */
    flagged: number;
    /** How many errored. */
    errors: number;
    /** The addresses that are currently sanctioned — act on these. */
    flaggedAddresses: string[];
    items: RescreenItem[];
}
export interface SanctionsResult {
    address: string;
    sanctioned: boolean;
    identifications: unknown[];
    source: string;
    checked_at: string;
}
export interface NameScreenMatch {
    ent_num: number;
    matched_name: string;
    matched_on: 'primary' | 'alias';
    sdn_type: string | null;
    program: string | null;
    score: number;
}
export interface NameScreenResult {
    query: string;
    normalized_query: string;
    hit: boolean;
    matches: NameScreenMatch[];
    list_date: string | null;
    threshold: number;
    source: string;
    note: string;
}
export interface CompanyResult {
    profile: {
        companyNumber: string;
        companyName: string;
        status: string;
        incorporatedOn?: string;
        registeredAddress?: string;
    };
    pscList: unknown[];
    source: string;
}
/** US public-company record from SEC EDGAR (public companies & funds only). */
export interface USCompanyResult {
    source: string;
    cik: string;
    name: string | null;
    former_names: string[];
    entity_type: string | null;
    sic: string | null;
    sic_description: string | null;
    state_of_incorporation: string | null;
    tickers: string[];
    exchanges: string[];
    business_address: {
        street1: string | null;
        street2: string | null;
        city: string | null;
        state_or_country: string | null;
        zip_code: string | null;
    } | null;
    latest_filing: {
        form: string | null;
        filing_date: string | null;
        primary_document: string | null;
    } | null;
    /** Explicit reminder that "not found" means "not an SEC filer", not "not real". */
    coverage_note: string;
    checked_at?: string;
}
export interface DiligenceResult {
    wallet_check?: unknown;
    company_check?: unknown;
    link_disclaimer: string;
    checked_at: string;
}
export interface AnchorResult {
    anchor_hash: string;
    tx_hash: string | null;
    already_anchored: boolean;
    chain: string;
    contract: string;
    note: string;
}
export interface AnchorStatus {
    anchor_hash: string;
    anchored: boolean;
    anchored_at: string | null;
    chain: string;
    contract: string;
}
export declare class OnchainDiligenceError extends Error {
    status: number;
    constructor(status: number, message: string);
}
export declare function resolveAttestationKeyOnline(keyId: string, options?: {
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
}): Promise<AttestationKeyRecord>;
/** Validate and return the complete signed envelope required by `/anchor`. */
export declare function buildAnchorRequest(envelope: Signed<unknown>): Signed<unknown>;
/** Explicit online-discovery wrapper around the zero-network verifier core. */
export declare function verifyAttestationOnline(signed: unknown, options?: OnlineAttestationVerificationOptions): Promise<AttestationVerificationResult>;
export declare class OnchainDiligence {
    private readonly baseUrl;
    private readonly expectedAttestationIssuer;
    private readonly fetch;
    constructor(opts: OnchainDiligenceOptions);
    private get;
    private post;
    private handle;
    /** Sanctions-screen a wallet address against the Chainalysis on-chain oracle. */
    screen(address: string): Promise<Signed<SanctionsResult>>;
    /** Screen a person/company name against the OFAC SDN list (fuzzy match). */
    screenName(name: string, opts?: {
        threshold?: number;
    }): Promise<Signed<NameScreenResult>>;
    /** Verify a UK company by its Companies House registration number. */
    verifyCompany(companyNumber: string): Promise<Signed<CompanyResult>>;
    /**
     * Verify a US public company via SEC EDGAR, by ticker, CIK, or name.
     * Covers SEC-registered public companies and funds only — a "not found"
     * (404) means "not an SEC filer", not "not a real company".
     */
    verifyUSCompany(query: string): Promise<Signed<USCompanyResult>>;
    /** Run wallet + company checks together (independent results). */
    diligence(params: {
        wallet?: string;
        company?: string;
    }): Promise<Signed<DiligenceResult>>;
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
    rescreen(addresses: string[], opts?: RescreenOptions): Promise<RescreenReport>;
    /** Anchor a complete authentic attestation envelope on Tempo (paid). */
    anchor(envelope: Signed<unknown>): Promise<Signed<AnchorResult>>;
    /** Check whether an attestation has been anchored on-chain (free). */
    anchored(signature: string): Promise<AnchorStatus>;
    /** Service health (free). */
    health(): Promise<{
        status: 'ok' | 'degraded';
        upstreams: Record<string, string>;
        attestation: string;
    }>;
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
    verifyAttestation(signed: Signed<unknown>): Promise<VerifyResult>;
    verifyAttestationOnline(signed: Signed<unknown>, options?: Omit<OnlineAttestationVerificationOptions, 'baseUrl' | 'fetch'>): Promise<AttestationVerificationResult>;
}
