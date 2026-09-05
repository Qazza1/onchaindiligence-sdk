export const EVIDENCE_EXPORT_VERSION = 'onchaindiligence.evidence-export.v1';
function canonicalizeJson(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalizeJson).join(',')}]`;
    if (typeof value === 'object') {
        const record = value;
        return `{${Object.keys(record)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonicalizeJson(record[k])}`)
            .join(',')}}`;
    }
    throw new TypeError(`value of type ${typeof value} is not valid JSON`);
}
async function sha256Digest(canonicalJson) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle)
        throw new Error('WebCrypto (crypto.subtle) is unavailable in this runtime');
    const bytes = new TextEncoder().encode(canonicalJson);
    const digestBuffer = await subtle.digest('SHA-256', bytes);
    const base64url = btoa(String.fromCharCode(...new Uint8Array(digestBuffer)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return `sha256:${base64url}`;
}
/** Builds the manifest and computes its digest. Pure aside from the digest computation itself; never makes a network call. */
export async function buildEvidenceExport(input) {
    const withoutDigest = {
        manifest_version: EVIDENCE_EXPORT_VERSION,
        operation_id: input.operationId,
        exported_at: new Date().toISOString(),
        artifacts: {
            preflight_receipt: input.preflightReceipt ?? null,
            commerce_receipt: input.commerceReceipt ?? null,
            operation_status: input.operationStatus ?? null,
            lifecycle_evidence: input.lifecycleEvidence ?? null,
        },
        notes: input.notes ?? {},
    };
    const manifest_digest = await sha256Digest(canonicalizeJson(withoutDigest));
    return { ...withoutDigest, manifest_digest };
}
