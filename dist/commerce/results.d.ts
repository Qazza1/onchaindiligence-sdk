/**
 * results.ts — discriminated unions for every lifecycle outcome (D2.5,
 * Section 2). Ordinary lifecycle states are never thrown as exceptions —
 * only genuinely exceptional conditions (bad input, a network the caller
 * cannot reasonably plan around) do. `receipt-produced` deliberately does
 * NOT mean "payment succeeded": the receipt may describe a confirmed
 * payment, a failed execution, a mismatch, or an uncertain observation —
 * read `receipt.receipt.execution.status` / `.settlement.status` /
 * `.decision.status`, never infer success from a receipt merely existing.
 */
import type { ReceiptEnvelope, OperationStatus } from './types.js';
/** Shared shape for every non-terminal "come back later" outcome. */
export interface PendingInfo {
    /** Where in the lifecycle this operation currently sits. */
    phase: 'preflight-in-progress' | 'awaiting-execution' | 'execution-ambiguous' | 'awaiting-observation' | 'observation-pending';
    /** What the caller should do next, in plain language a UI can show directly. */
    safeNextAction: string;
    /** Seconds to wait before retrying, when known. */
    retryAfterSeconds?: number;
    /** True whenever OCD's fee (or, for execution, the merchant payment) may already have been taken — the caller must NEVER treat this as "safe to pay again". */
    mayAlreadyHavePaid: boolean;
    operationId: string;
    executionRequestId?: string | null;
}
export type PreflightEvaluation = {
    kind: 'ready';
    operationId: string;
    receipt: ReceiptEnvelope;
    capabilityExpiresAt: string;
} | {
    kind: 'blocked';
    operationId: string;
    receipt: ReceiptEnvelope;
    reasons: string[];
} | {
    kind: 'approval-required';
    operationId: string;
    receipt: ReceiptEnvelope;
    reasons: string[];
} | ({
    kind: 'pending';
} & PendingInfo) | {
    kind: 'terminal-error';
    operationId: string;
    error: string;
};
export type ExecutionRecord = {
    kind: 'execution-recorded';
    operationId: string;
    executionRequestId: string;
    transactionHash: string;
    providerReference?: string | null;
} | {
    kind: 'manual-recovery-required';
    operationId: string;
    executionRequestId: string;
    reason: string;
} | ({
    kind: 'pending';
} & PendingInfo) | {
    kind: 'terminal-error';
    operationId: string;
    error: string;
};
export type FinalizeResult = {
    kind: 'receipt-produced';
    operationId: string;
    receipt: ReceiptEnvelope;
    evidence: {
        bundle_digest: string;
        binding_strength: 'TRANSFER_MATCH_ONLY' | 'EXECUTOR_CORRELATED' | 'PAYMENT_IDENTITY_LINKED';
    } | null;
} | ({
    kind: 'pending';
} & PendingInfo) | {
    kind: 'terminal-error';
    operationId: string;
    error: string;
};
export type ResumeResult = {
    kind: 'resumed';
    operationId: string;
    status: OperationStatus;
} | {
    kind: 'recovery-failed';
    reason: string;
};
export declare function pending(operationId: string, info: Omit<PendingInfo, 'operationId'>): {
    kind: 'pending';
} & PendingInfo;
