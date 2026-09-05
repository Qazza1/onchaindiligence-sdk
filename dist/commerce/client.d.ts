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
export declare class RecoveryRequiredError extends Error {
    constructor(operationId: string);
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
    private applyExecutionOutcome;
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
