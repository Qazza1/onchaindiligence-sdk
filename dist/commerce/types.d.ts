/**
 * types.ts — the commerce-lifecycle wire contract, ported by hand from
 * onchaindiligence-mcp's src/preflight.ts / src/receipts.ts / src/lifecycleRoute.ts
 * / src/lifecycleFinalizeRoute.ts (D2.1/D2.4).
 *
 * SOURCE OF TRUTH: the deployed mcp.onchaindiligence.com API. This file does
 * not implement or re-verify anything — it exists so the commerce client has
 * exact types for what it sends and receives, mirroring the same
 * "ported minimal copy, kept in sync by hand" discipline
 * onchaindiligence-mcp's own receipts.ts already documents for its
 * relationship to the canonical packages/agent-evidence source.
 */
export interface CommerceAction {
    kind: 'PAYMENT';
    /** URL of the resource/service the payment is for, if any. */
    resource: string | null;
    /** CAIP-2 network identifier, e.g. "eip155:8453" for Base mainnet. */
    network: string;
    /** Canonical ERC-20 token contract address — never a bare ticker. */
    asset: string;
    /** Canonical decimal string, e.g. "1.00". Never a float. */
    amount: string;
    sender: string | null;
    recipient: string;
}
export interface CommercePolicy {
    max_amount?: string | null;
    allowed_networks?: string[] | null;
    allowed_assets?: string[] | null;
    expected_recipient?: string | null;
    allowed_resource_origins?: string[] | null;
    /** Structural confirmation that every field above being null/omitted is intentional, not an accident. */
    acknowledge_unconstrained?: boolean;
    /** A frozen commitment to the wallet expected to AUTHORIZE the eventual on-chain payment (D2.4) — decision-neutral. */
    expected_payer?: string | null;
}
export interface CommercePublication {
    preflight?: boolean;
    commerce?: boolean;
}
export type DecisionStatus = 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK' | 'UNKNOWN';
export interface ReceiptDecision {
    status: DecisionStatus;
    authorized: boolean | null;
    reasons: string[];
}
export interface ReceiptCheck {
    id: string;
    result: 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_CHECKED';
    summary: string;
    evidence_digest: string | null;
}
export type ExecutionStatus = 'NOT_SUBMITTED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';
export type SettlementStatus = 'CONFIRMED' | 'NOT_CONFIRMED' | 'UNVERIFIED' | 'NOT_APPLICABLE';
export interface Receipt {
    receipt_id: string;
    receipt_digest: string;
    receipt_type: 'ACTION' | 'PREFLIGHT' | 'COMMERCE';
    issued_at: string;
    action: CommerceAction & {
        resource: string | null;
    };
    decision: ReceiptDecision;
    execution: {
        provider: string | null;
        status: ExecutionStatus;
        transaction_hash: string | null;
        submitted_at: string | null;
        confirmed_at: string | null;
    };
    settlement: {
        status: SettlementStatus;
        detail: string | null;
    };
    checks: ReceiptCheck[];
    links: {
        agent_evidence_bundle_digest: string | null;
        preflight_receipt_id: string | null;
    };
    limitations: string[];
}
export interface ReceiptEnvelope {
    schema: string;
    receipt: Receipt;
    proof: {
        signed: boolean;
        schema_version?: string;
        issuer?: string;
        purpose?: string;
        issued_at?: string;
        key_id?: string;
        algorithm?: string;
        canonicalization?: string;
        signature?: string;
        signing_input_hint?: string;
    };
}
export interface PreflightFinalization {
    capability: string;
    expires_at: string;
    endpoint: string;
}
export interface PreflightResponseBody {
    decision: ReceiptDecision;
    checks: ReceiptCheck[];
    receipt: ReceiptEnvelope;
    finalization: PreflightFinalization;
}
export interface CreatedOperation {
    operation_id: string;
    recovery_credential: string;
}
export type PreflightState = 'not_started' | 'in_progress' | 'completed';
export type ExecutionState = 'not_submitted' | 'prepared' | 'submission_ambiguous' | 'submitted' | 'outcome_unknown' | 'transaction_known' | 'manual_recovery_required';
export type ObservationState = 'none' | 'pending' | 'confirmed' | 'contradicted';
export type ReceiptState = 'none' | 'preflight_only' | 'commerce_issued';
export interface OperationStatus {
    operation_id: string;
    preflight_state: PreflightState;
    execution_state: ExecutionState;
    observation_state: ObservationState;
    receipt_state: ReceiptState;
    preflight_receipt_id: string | null;
}
export interface ExecutionBindingResponse {
    execution_request_id: string;
    submission_state: ExecutionState;
    idempotent_replay: boolean;
}
export interface FinalizeExecutionInput {
    transaction_hash: string;
    execution_provider: 'x402' | 'paybox' | 'wallet' | 'other';
    provider_reference?: string | null;
    result_digest?: string | null;
    execution_request_id?: string | null;
}
export interface OperationFinalizeResponseBody extends ReceiptEnvelope {
    ocd_lifecycle_evidence: {
        bundle_digest: string;
        binding_strength: 'TRANSFER_MATCH_ONLY' | 'EXECUTOR_CORRELATED' | 'PAYMENT_IDENTITY_LINKED';
    } | null;
}
/** The shape of an API error body across every endpoint used here. */
export interface ApiErrorBody {
    error: string;
    reason?: string;
}
