/**
 * evidenceExport.ts — a MINIMAL developer-facing evidence export (D2.5,
 * Section 10). Deliberately not the full investigation package: a
 * deterministic JSON manifest bundling the PUBLIC artifacts for one
 * operation, suitable for handing to a counterparty, auditor, or support
 * ticket.
 *
 * Preserves signed/original artifacts unchanged (receipts are embedded
 * verbatim — never re-serialized field-by-field, which could silently drop
 * or reorder something material). Computes one digest over the manifest
 * contents (excluding the digest field itself) using the same
 * canonicalize-then-SHA-256 approach already used elsewhere in this
 * ecosystem (RFC 8785-style sorted-key JSON).
 *
 * NEVER accepts a CommerceRecoveryRecord or any executor/authorization
 * secret as input — only public receipts and status. This is enforced by
 * the function's own parameter types, not by a runtime filter, so there is
 * no field to "forget" to redact.
 */
import type { ReceiptEnvelope, OperationStatus } from './types.js';
export declare const EVIDENCE_EXPORT_VERSION = "onchaindiligence.evidence-export.v1";
export interface EvidenceExportInput {
    operationId: string;
    preflightReceipt?: ReceiptEnvelope | null;
    commerceReceipt?: ReceiptEnvelope | null;
    operationStatus?: OperationStatus | null;
    lifecycleEvidence?: {
        bundle_digest: string;
        binding_strength: string;
    } | null;
    /** Free-form, non-secret developer notes (e.g. an order reference). Never put a credential or token here — this whole object is written to disk/handed to a third party. */
    notes?: Record<string, string | number | boolean | null>;
}
export interface EvidenceExportManifest {
    manifest_version: typeof EVIDENCE_EXPORT_VERSION;
    operation_id: string;
    exported_at: string;
    artifacts: {
        preflight_receipt: ReceiptEnvelope | null;
        commerce_receipt: ReceiptEnvelope | null;
        operation_status: OperationStatus | null;
        lifecycle_evidence: {
            bundle_digest: string;
            binding_strength: string;
        } | null;
    };
    notes: Record<string, string | number | boolean | null>;
    manifest_digest: string;
}
/** Builds the manifest and computes its digest. Pure aside from the digest computation itself; never makes a network call. */
export declare function buildEvidenceExport(input: EvidenceExportInput): Promise<EvidenceExportManifest>;
