/**
 * client.ts — createCommerceClient (D2.5, Section 1).
 *
 * Orchestrates: open/resume -> preflight -> execute -> observe/finalize,
 * calling onchaindiligence-mcp's D2.4 HTTP surface (POST /operations,
 * POST /x402/lifecycle/preflight-payment, POST /operations/:id/execution-bindings(+/state),
 * POST /operations/:id/finalize) while persisting every durable identity to
 * the caller-supplied CommerceRecoveryStore BEFORE the network call that
 * could make it ambiguous — never after.
 *
 * This class does NOT reimplement any D2.4 guarantee (idempotency, binding
 * strength, finality) — it is a thin, honest orchestrator over the service
 * primitives that already provide them. See each method for exactly which
 * server endpoint it calls and why the local persistence is ordered the way
 * it is.
 */
import type { CommerceAction, CommercePolicy, CommercePublication, OperationStatus, ReceiptEnvelope } from './types.js';
import type { CommerceExecutor } from './executor.js';
import type { CommerceRecoveryStore, CommerceRecoveryRecord } from './recoveryStore.js';
import { type PreflightEvaluation, type ExecutionRecord, type FinalizeResult, type ResumeResult } from './results.js';
import { type EvidenceExportManifest } from './evidenceExport.js';
/**
 * D2.6 review fix #1: thrown by execute() whenever the operation's
 * authoritative stored PREFLIGHT decision is not ALLOW (BLOCK,
 * REQUIRE_APPROVAL, UNKNOWN, or — defensively — undeterminable). This is the
 * generic, executor-independent enforcement point: no executor (PayBox,
 * X402BaseUsdcExecutor, a custom one) is ever reachable from execute() for
 * an operation that didn't authoritatively reach ALLOW.
 */
export declare class PreflightNotAllowedError extends Error {
    constructor(operationId: string, status: string | null);
}
export declare class RecoveryRequiredError extends Error {
    constructor(operationId: string);
}
/**
 * D2.6 correction: thrown by attachProviderReferenceStrict() when the
 * server's execution binding already has a DIFFERENT provider_reference
 * than the one this call tried to attach (HTTP 409 -- see
 * onchaindiligence-mcp's ProviderReferenceConflictError, the authoritative
 * source of this decision; this class only carries the server's message
 * through, never re-derives the conflict itself). Distinguished from
 * ProviderReferenceAttachTransientError so a caller can tell "this will
 * never resolve on retry, a human must look" from "try again later."
 */
export declare class ProviderReferenceAttachConflictError extends Error {
    constructor(message: string);
}
/**
 * D2.6 correction: thrown by attachProviderReferenceStrict() for a network
 * failure or a non-409 non-2xx HTTP response -- recoverable by retrying the
 * SAME attach call later (the durable request identity this reference
 * refers to is untouched either way).
 */
export declare class ProviderReferenceAttachTransientError extends Error {
    constructor(message: string);
}
export interface CreateCommerceClientOptions {
    /** Base URL of the OCD MCP/x402 server. Defaults to production. */
    endpoint?: string;
    /** Durable recovery store. Required -- see recoveryStore.ts. There is no safe default. */
    recovery: CommerceRecoveryStore;
    /** When verifyReceipts is true, receipts returned by preflight/finalize are additionally checked via the free /verify-receipt endpoint (D2.5 Section 7) before being surfaced. Off by default: verification is a distinct concern a caller can invoke on its own via client.verifyReceipt(). */
    trust?: {
        verifyReceipts?: boolean;
    };
    fetch?: typeof globalThis.fetch;
}
export interface OpenParams {
    /** If set and a local recovery record already exists for it, resumes that operation instead of creating a new one -- see this file's header. */
    operationId?: string;
    /** Developer-facing label for logs/UI only; never sent to OCD. */
    intent?: string;
    action: CommerceAction;
    policy: CommercePolicy;
    publication?: CommercePublication;
}
export declare class OnchainDiligenceCommerceClient {
    private readonly endpoint;
    private readonly recovery;
    private readonly fetchImpl;
    private readonly trust;
    constructor(options: CreateCommerceClientOptions);
    /** @internal */
    apiFetch(path: string, init?: RequestInit): Promise<Response>;
    /** @internal */
    readError(res: Response): Promise<string>;
    /** @internal */
    recoveryStore(): CommerceRecoveryStore;
    /** @internal */
    trustOptions(): {
        verifyReceipts?: boolean;
    };
    /** Opens a new operation, or resumes one already known locally by operationId. Never silently creates a second operation for an id that exists locally with different intent. */
    open(params: OpenParams): Promise<CommerceOperation>;
    /** Explicit resume after restart/lost-response, per D2.5 Section 6. Returns recovery-failed rather than throwing, since "the credential turned out to be wrong" is an expected, handleable outcome, not a programming error. */
    resume(operationId: string, recoveryCredential: string): Promise<ResumeResult>;
    /** Returns a CommerceOperation for an operation already known to the recovery store, without any network call. Use after resume() or across a process restart. */
    load(operationId: string): Promise<CommerceOperation | null>;
    /** D2.5 Section 7: free, structured, reuses the server's converged verifier -- no local re-implementation. */
    verifyReceipt(receiptIdOrEnvelope: string | ReceiptEnvelope): Promise<{
        state: 'VALID' | 'INVALID' | 'UNVERIFIABLE';
        code: string;
        message: string;
    }>;
    /** D2.5 Section 7: free, structured lookup by exact receipt id. */
    getReceipt(receiptId: string): Promise<ReceiptEnvelope | null>;
}
export declare function createCommerceClient(options: CreateCommerceClientOptions): OnchainDiligenceCommerceClient;
export declare class CommerceOperation {
    readonly operationId: string;
    private readonly client;
    private record;
    private pendingPreflightInput;
    private lastCommerceReceiptId;
    private lastLifecycleEvidence;
    /** Serializes execute() calls against THIS operation instance -- see execute()'s header comment for why. */
    private executeQueue;
    constructor(client: OnchainDiligenceCommerceClient, record: CommerceRecoveryRecord);
    /** @internal */
    setPendingPreflightInput(action: CommerceAction, policy: CommercePolicy, publication?: CommercePublication): void;
    /** @internal -- exposed for evidence export and tests. */
    currentRecord(): CommerceRecoveryRecord;
    private reload;
    /**
     * Fail-closed gate (D2.6 review fix #1): execute() calls this before ANY
     * executor method is reachable. Prefers the locally cached
     * `preflightDecisionStatus` (set the moment preflight() itself received an
     * authoritative decision) — falls back to re-fetching the signed receipt
     * itself for a record that predates this field, or whose cache write
     * never landed, rather than ever assuming ALLOW.
     */
    private assertPreflightAllowed;
    private casUpdate;
    /**
     * Claims `clientSubmissionKey` for a fresh submission attempt -- but
     * NEVER by blindly overwriting a value a concurrent claimant already won.
     * Unlike casUpdate (which re-applies the SAME patch after a conflict,
     * correct for "set this field to this exact value regardless"), a claim
     * is "set this field to MY value ONLY IF NO ONE ELSE HAS ALREADY SET IT"
     * -- so a conflict here means re-reading and checking on which value
     * actually won, not retrying with a new one. This is what closes the race
     * two concurrent execute() calls (in-process, via a shared store across
     * processes, or across a restart) would otherwise have on this field.
     */
    private claimSubmissionSlot;
    status(): Promise<OperationStatus>;
    preflight(): Promise<PreflightEvaluation>;
    private evaluationFromReceipt;
    /**
     * Serialized per operation instance (Section 15 test #9: "concurrent
     * calls cannot cause duplicate submit"). Two overlapping execute() calls
     * against the SAME CommerceOperation object run one after the other, so
     * the second always observes the first's already-persisted
     * clientSubmissionKey/executionRequestId/transactionHash and resumes
     * instead of racing to claim a fresh identity. Cross-PROCESS concurrency
     * is a different, already-covered case: the server's execution-bindings
     * endpoint is idempotent by client_submission_key (D2.4), and a correctly
     * implemented executor (see MockCommerceExecutor, X402BaseUsdcExecutor)
     * refuses to submit twice for the same key on its own.
     */
    execute(params: {
        executor: CommerceExecutor;
    }): Promise<ExecutionRecord>;
    private executeLocked;
    /**
     * D2.6 correction: a known providerReference must be durably attached to
     * the server-side execution binding BEFORE this method persists any LOCAL
     * terminal state that would prevent a future retry of that attachment.
     * Concretely: once `transactionHash` lands in the recovery record,
     * executeLocked()'s own short-circuit (`if (this.record.transactionHash)
     * return execution-recorded`) means executor.resume() — and therefore any
     * further attempt to attach the provider reference — is NEVER called
     * again. So for `transaction-known`, the attach is a hard gate: on
     * success, proceed exactly as before; on a genuine conflict, stop and
     * report manual-recovery-required (never overwrite the server's existing
     * reference, never create a second PayBox request); on a transient
     * failure, return `pending` WITHOUT touching `transactionHash` at all --
     * the executor's OWN store already has the transaction hash durably
     * (PayBoxCommerceExecutor persists it before ever returning
     * transaction-known), so calling executor.resume() again on the next
     * op.execute() reproduces the SAME outcome and retries the SAME
     * attachment, deterministically, with no new provider call.
     *
     * For `submission-ambiguous` and `manual-recovery-required`, neither of
     * which persists any local terminal state that could block a retry, the
     * attach is attempted best-effort (Section 5: "attach durably as soon as
     * practical" / "attempt to preserve the correlation too") without gating
     * the returned result on it — a subsequent op.execute() naturally retries
     * both the PayBox poll and this attachment together.
     */
    private applyExecutionOutcome;
    /**
     * Provider evidence is an append-only, best-effort audit claim. It must not
     * change execution, finalization, or settlement behavior if OCD is
     * temporarily unavailable. The provider-evidence endpoint verifies the
     * durable execution binding before accepting it; retries of the same
     * terminal provider snapshot are content-idempotent server-side.
     *
     * The body key must match exactly what onchaindiligence-mcp's
     * parseProviderEvidenceInput() dispatches on for each provider (D3.4C2's
     * `paybox_response`, D3.4C5's `cdp_response`) -- Turnkey/Crossmint are
     * webhook-driven and never reach this method (see their own executors'
     * header notes on why they don't attach a ProviderEvidenceSubmission).
     */
    private recordProviderEvidenceBestEffort;
    /**
     * D2.6 correction: strictly attaches `providerReference` to the ALREADY-
     * EXISTING execution binding via the SAME state endpoint the submission-
     * state mirror uses -- makes NO new execution binding, performs NO
     * payment, sends ONLY `provider_reference` (no `state`). Checks the actual
     * HTTP response: 2xx (including the idempotent "already exactly this
     * value" case, which the server itself treats as success) resolves
     * normally; HTTP 409 throws ProviderReferenceAttachConflictError; any
     * other non-2xx or a network failure throws
     * ProviderReferenceAttachTransientError. Never silently swallows a
     * failure -- that is the caller's job to decide, per outcome kind (see
     * applyExecutionOutcome()). The server (onchaindiligence-mcp's
     * attachProviderReference()/updateExecutionBindingProviderReference())
     * remains the sole authority for the null -> value / same-value-idempotent
     * / different-value-conflict decision -- this method never re-derives or
     * duplicates that logic client-side.
     */
    private attachProviderReferenceStrict;
    /** Same call as attachProviderReferenceStrict(), but for outcomes that never persist a local terminal state a failed attach could block -- see applyExecutionOutcome()'s header for why these two paths differ. */
    private attachProviderReferenceBestEffort;
    /** Best-effort mirror of the binding's submission_state only (D2.6 correction: provider_reference now goes exclusively through attachProviderReferenceStrict()/BestEffort() above, never through this call) -- the LOCAL record + the binding's OWN prior state remain authoritative for resume logic either way. */
    private updateBindingState;
    observeAndFinalize(): Promise<FinalizeResult>;
    /**
     * Builds a minimal, deterministic evidence manifest from PUBLIC artifacts
     * only (fetched fresh via the client's public receipt/status calls) —
     * never touches this.record's secret fields (recoveryCredential,
     * finalizationCapability), so there is no field here to forget to redact.
     */
    exportEvidence(): Promise<EvidenceExportManifest>;
}
