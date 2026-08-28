/**
 * Zero-network verification for existing OnChainDiligence attestations.
 *
 * This module deliberately has no HTTP client and never discovers keys. The
 * caller supplies the exact key records it has independently chosen to trust.
 * Online discovery is implemented separately in index.ts as a convenience
 * wrapper around this core.
 */
export declare const ATTESTATION_V2_SCHEMA = "onchaindiligence.attestation.v2";
export declare const DEFAULT_ATTESTATION_ISSUER = "https://api.onchaindiligence.com";
export declare const COMPLIANCE_ATTESTATION_PURPOSE = "compliance-screening-result";
export declare const FIXTURE_ATTESTATION_PURPOSE = "verification-fixture";
export type VerificationState = 'VALID' | 'INVALID' | 'UNVERIFIABLE';
export type ComponentState = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_CHECKED';
export type AttestationKeyStatus = 'active' | 'retired' | 'revoked' | 'compromised';
export interface Attestation {
    signed: boolean;
    schema_version?: string;
    issuer?: string;
    purpose?: string;
    key_id?: string;
    algorithm?: string;
    canonicalization?: string;
    signature?: string;
    issued_at?: string;
    [key: string]: unknown;
}
export interface Signed<T> {
    data: T;
    attestation: Attestation;
}
export interface AttestationKeyRecord {
    key_id: string;
    algorithm: 'ed25519';
    public_key_pem: string;
    status: AttestationKeyStatus;
    valid_from: string | null;
    valid_until: string | null;
    status_changed_at?: string | null;
    status_reason?: string;
    replacement_key_id?: string | null;
    compromised_at?: string | null;
}
/**
 * Passing this object is an explicit caller trust decision. A key embedded in
 * an attestation or downloaded from an arbitrary URL MUST NOT be copied here
 * automatically.
 */
export interface TrustedAttestationKeySet {
    keys: readonly AttestationKeyRecord[];
    /** Optional identity namespace represented by these trusted records. */
    issuer?: string;
    /** Human/machine-readable description of the out-of-band trust source. */
    trust_source?: string;
    /** Reserved for future signed registry snapshot/root policy. */
    registry_version?: number;
}
export interface VerificationComponent {
    state: ComponentState;
    code: string;
    message: string;
}
export interface AttestationVerificationComponents {
    structure: VerificationComponent;
    signature: VerificationComponent;
    identity: VerificationComponent;
    lifecycle: VerificationComponent;
    timestamp: VerificationComponent;
    key_window: VerificationComponent;
    freshness: VerificationComponent;
    anchor: VerificationComponent;
}
export interface AttestationVerificationResult {
    state: VerificationState;
    /** Compatibility convenience. Security-sensitive callers should use state. */
    valid: boolean;
    code: string;
    reason: string;
    schemaVersion?: string;
    keyId?: string;
    keyStatus?: AttestationKeyStatus;
    cryptographicallyValid?: boolean;
    trusted?: boolean;
    components: AttestationVerificationComponents;
    warnings: string[];
}
export interface VerifyAttestationOptions {
    expectedIssuer?: string;
    allowedPurposes?: readonly string[];
    /** Default true. A missing active valid_from is UNVERIFIABLE. */
    requireValidFrom?: boolean;
    /** Evaluate business freshness separately from signature/key validity. */
    maxAgeMs?: number;
    /** Injected for deterministic verification/tests. */
    now?: Date | number | string;
    /** Default five minutes. */
    maxFutureSkewMs?: number;
}
/** RFC 8785 canonical JSON for values in the I-JSON data model. */
export declare function canonicalizeJson(value: unknown): string;
/**
 * Parse JSON while rejecting duplicate object member names. JSON.parse keeps
 * the last duplicate, which is unsafe for signed formats because another
 * implementation may keep the first.
 */
export declare function parseJsonNoDuplicateKeys(text: string, maxDepth?: number): unknown;
export declare function deriveAttestationKeyId(publicKeyPem: string): Promise<string>;
/** Verify using only the supplied envelope and caller-trusted key records. */
export declare function verifyAttestationOffline(input: unknown, trustMaterial: TrustedAttestationKeySet, options?: VerifyAttestationOptions): Promise<AttestationVerificationResult>;
