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
import { Mppx, tempo } from 'mppx/client';
import { DEFAULT_ATTESTATION_ISSUER, verifyAttestationOffline, } from './verification.js';
export * from './verification.js';
export class OnchainDiligenceError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'OnchainDiligenceError';
    }
}
const DEFAULT_BASE_URL = 'https://api.onchaindiligence.com';
export async function resolveAttestationKeyOnline(keyId, options = {}) {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl)
        throw new Error('fetch is unavailable in this runtime');
    const exact = await fetchImpl(`${baseUrl}/.well-known/attestation-keys/${encodeURIComponent(keyId)}`);
    if (exact.ok) {
        const payload = (await exact.json());
        if (!payload.key || payload.key.key_id !== keyId) {
            throw new Error('attestation key registry returned an invalid or mismatched key');
        }
        return payload.key;
    }
    if (exact.status !== 404) {
        throw new OnchainDiligenceError(exact.status, 'could not fetch attestation public key');
    }
    const legacy = await fetchImpl(`${baseUrl}/.well-known/attestation-key`);
    if (!legacy.ok) {
        throw new OnchainDiligenceError(legacy.status, 'could not fetch attestation public key');
    }
    const text = await legacy.text();
    let reportedKeyId = '';
    let pem = text.trim();
    let algorithm = 'ed25519';
    let status = 'active';
    if (!pem.includes('BEGIN PUBLIC KEY')) {
        const payload = JSON.parse(text);
        reportedKeyId = payload.key_id || '';
        pem = (payload.public_key_pem || payload.publicKey || payload.pem || payload.key || '').trim();
        algorithm = payload.algorithm || algorithm;
        status = payload.status || status;
    }
    if (reportedKeyId !== keyId || !pem.includes('BEGIN PUBLIC KEY') || algorithm !== 'ed25519') {
        throw new Error('legacy attestation-key endpoint did not return the requested key_id');
    }
    return {
        key_id: keyId,
        algorithm: 'ed25519',
        public_key_pem: pem,
        status,
        valid_from: null,
        valid_until: null,
        status_changed_at: null,
    };
}
/** Validate and return the complete signed envelope required by `/anchor`. */
export function buildAnchorRequest(envelope) {
    if (!envelope ||
        typeof envelope !== 'object' ||
        !Object.hasOwn(envelope, 'data') ||
        !envelope.attestation ||
        typeof envelope.attestation !== 'object' ||
        envelope.attestation.signed !== true) {
        throw new TypeError('anchor requires the complete signed attestation envelope');
    }
    return envelope;
}
/** Explicit online-discovery wrapper around the zero-network verifier core. */
export async function verifyAttestationOnline(signed, options = {}) {
    let parsed = signed;
    if (typeof signed === 'string') {
        try {
            parsed = JSON.parse(signed);
        }
        catch {
            return verifyAttestationOffline(signed, { keys: [] }, options);
        }
    }
    const keyId = parsed?.attestation?.key_id;
    if (typeof keyId !== 'string') {
        return verifyAttestationOffline(signed, { keys: [] }, options);
    }
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    let record;
    try {
        record = await resolveAttestationKeyOnline(keyId, { baseUrl, fetch: options.fetch });
    }
    catch (error) {
        const offline = await verifyAttestationOffline(signed, { keys: [] }, options);
        if (offline.state === 'INVALID')
            return offline;
        return {
            ...offline,
            state: 'UNVERIFIABLE',
            valid: false,
            code: 'online_key_resolution_failed',
            reason: error instanceof Error ? error.message : 'Online key resolution failed.',
        };
    }
    const material = {
        keys: [record],
        issuer: options.expectedIssuer ?? DEFAULT_ATTESTATION_ISSUER,
        trust_source: `online-registry:${baseUrl}`,
    };
    const offline = await verifyAttestationOffline(signed, material, options);
    const trustDecision = typeof options.trustRegistry === 'function'
        ? await options.trustRegistry(record, { baseUrl })
        : options.trustRegistry === true;
    if (trustDecision || offline.state === 'INVALID')
        return offline;
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
    };
}
export class OnchainDiligence {
    baseUrl;
    expectedAttestationIssuer;
    fetch;
    constructor(opts) {
        this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
        this.expectedAttestationIssuer = opts.expectedAttestationIssuer ?? DEFAULT_ATTESTATION_ISSUER;
        // Payment-aware fetch: transparently answers 402 challenges and retries.
        const client = Mppx.create({ methods: [tempo({ account: opts.account })] });
        this.fetch = client.fetch;
    }
    async get(path) {
        const res = await this.fetch(`${this.baseUrl}${path}`);
        return this.handle(res);
    }
    async post(path, body) {
        const res = await this.fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return this.handle(res);
    }
    async handle(res) {
        if (!res.ok) {
            let detail = res.statusText;
            try {
                const j = (await res.json());
                detail = j.detail || j.error || detail;
            }
            catch {
                /* non-JSON error body */
            }
            throw new OnchainDiligenceError(res.status, detail);
        }
        return (await res.json());
    }
    // --- Checks (paid) -------------------------------------------------------
    /** Sanctions-screen a wallet address against the Chainalysis on-chain oracle. */
    screen(address) {
        return this.get(`/screen/${encodeURIComponent(address)}`);
    }
    /** Screen a person/company name against the OFAC SDN list (fuzzy match). */
    screenName(name, opts) {
        const q = new URLSearchParams({ name });
        if (opts?.threshold != null)
            q.set('threshold', String(opts.threshold));
        return this.get(`/screen-name?${q.toString()}`);
    }
    /** Verify a UK company by its Companies House registration number. */
    verifyCompany(companyNumber) {
        return this.get(`/company/${encodeURIComponent(companyNumber)}`);
    }
    /**
     * Verify a US public company via SEC EDGAR, by ticker, CIK, or name.
     * Covers SEC-registered public companies and funds only — a "not found"
     * (404) means "not an SEC filer", not "not a real company".
     */
    verifyUSCompany(query) {
        const qs = new URLSearchParams({ q: query });
        return this.get(`/us-company?${qs.toString()}`);
    }
    /** Run wallet + company checks together (independent results). */
    diligence(params) {
        const q = new URLSearchParams();
        if (params.wallet)
            q.set('wallet', params.wallet);
        if (params.company)
            q.set('company', params.company);
        return this.get(`/diligence?${q.toString()}`);
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
    async rescreen(addresses, opts) {
        const concurrency = Math.max(1, opts?.concurrency ?? 4);
        const unique = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))];
        const items = new Array(unique.length);
        let next = 0;
        const worker = async () => {
            for (let i = next++; i < unique.length; i = next++) {
                const address = unique[i];
                let item;
                try {
                    const result = await this.screen(address);
                    item = { address, ok: true, sanctioned: result.data.sanctioned, result };
                }
                catch (err) {
                    item = { address, ok: false, error: err instanceof Error ? err.message : String(err) };
                }
                items[i] = item;
                opts?.onResult?.(item);
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
        const flaggedAddresses = items.filter((it) => it.sanctioned).map((it) => it.address);
        return {
            total: unique.length,
            screened: items.filter((it) => it.ok).length,
            flagged: flaggedAddresses.length,
            errors: items.filter((it) => !it.ok).length,
            flaggedAddresses,
            items,
        };
    }
    /** Anchor a complete authentic attestation envelope on Tempo (paid). */
    anchor(envelope) {
        return this.post(`/anchor`, buildAnchorRequest(envelope));
    }
    // --- Free endpoints ------------------------------------------------------
    /** Check whether an attestation has been anchored on-chain (free). */
    anchored(signature) {
        return this.get(`/anchored?signature=${encodeURIComponent(signature)}`);
    }
    /** Service health (free). */
    health() {
        return this.get(`/health`);
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
    verifyAttestation(signed) {
        return verifyAttestationOnline(signed, {
            baseUrl: this.baseUrl,
            expectedIssuer: this.expectedAttestationIssuer,
            fetch: this.fetch,
            // This preserves the historical SDK behavior: constructing this client
            // explicitly chooses its configured HTTPS issuer registry as authority.
            trustRegistry: true,
            // Compatibility until production publishes a real activation boundary.
            requireValidFrom: false,
        });
    }
    verifyAttestationOnline(signed, options = {}) {
        return verifyAttestationOnline(signed, {
            ...options,
            baseUrl: this.baseUrl,
            expectedIssuer: options.expectedIssuer ?? this.expectedAttestationIssuer,
            fetch: this.fetch,
        });
    }
}
