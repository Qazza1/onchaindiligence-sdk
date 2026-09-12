import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js';
import { BASE_NETWORK, BASE_USDC, type MinimalResumeClient } from './x402Executor.js';
export { BASE_NETWORK as CIRCLE_BASE_NETWORK, BASE_USDC as CIRCLE_BASE_USDC };
export type CircleTransactionState = 'INITIATED' | 'QUEUED' | 'SENT' | 'CONFIRMED' | 'COMPLETE' | 'FAILED' | 'CANCELLED' | 'DENIED';
export interface CircleTransactionResult {
    id: string;
    state: CircleTransactionState;
    /** Populated once mined; absent for FAILED/CANCELLED/DENIED and for pre-inclusion states. */
    txHash?: string | null;
}
export interface CircleTransferInput {
    /** The Circle-managed wallet id to send from. */
    walletId: string;
    /** Token identifier (Circle's own tokenId, e.g. for Base USDC), per current Circle docs. */
    tokenId: string;
    destinationAddress: string;
    /** Human-readable decimal amount, per current Circle docs -- NOT atomic units. */
    amount: string;
    /** UUID v4, per Circle's documented format requirement. See deriveIdempotencyKey(). */
    idempotencyKey: string;
}
/**
 * The minimal Circle public surface this executor depends on -- narrow
 * enough that a real Circle SDK/HTTP client via a small transport
 * adapter, or a test double, can both satisfy it unmodified (same
 * discipline as this project's other adapters).
 */
export interface CircleClient {
    /** Calls Circle's create-transfer-transaction endpoint. Never called more than once per prepared identity by this adapter. */
    createTransfer(input: CircleTransferInput): Promise<CircleTransactionResult>;
    /** Polls the current state of a transaction by its id (Get Transaction). Read-only. */
    getTransaction(id: string): Promise<CircleTransactionResult>;
}
/**
 * Deterministically derives a UUID-v4-SHAPED string from an arbitrary
 * input string: same input always produces the same output, satisfying
 * Circle's documented idempotencyKey format requirement without asking
 * the caller to manage UUIDs themselves. This is NOT a random UUID (it
 * has no unpredictability, which idempotency keys don't need) -- it only
 * needs to be format-valid and stable per clientSubmissionKey.
 */
export declare function deriveIdempotencyKey(clientSubmissionKey: string): string;
export interface CircleRequestRecord {
    clientSubmissionKey: string;
    /** null only in the narrow window between "we called createTransfer" and "we recorded its id" -- see submit(). */
    transactionId: string | null;
    tokenId: string;
    amount: string;
    destinationAddress: string;
    walletId: string;
    /** Set once COMPLETE is observed for this record -- once set, this adapter never re-polls or re-sends. */
    transactionHash: string | null;
}
export interface CircleRequestStore {
    get(clientSubmissionKey: string): Promise<CircleRequestRecord | null>;
    set(record: CircleRequestRecord): Promise<void>;
    /**
     * Atomically claims the attempt slot for `clientSubmissionKey`: if no
     * record exists yet, stores `placeholder` (which MUST have
     * `transactionId: null`) and returns `{ claimed: true, record:
     * placeholder }` -- the caller, and ONLY the caller, may now call
     * `createTransfer()`. If a record already exists, returns `{ claimed:
     * false, record: <the existing record, unmodified> }` and the caller
     * MUST NOT call `createTransfer()` again. A real, multi-process
     * implementation MUST make this genuinely atomic (same discipline as
     * every other adapter's `claim()`).
     */
    claim(clientSubmissionKey: string, placeholder: CircleRequestRecord): Promise<{
        claimed: boolean;
        record: CircleRequestRecord;
    }>;
}
/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation. Does not survive a restart. */
export declare class InMemoryCircleRequestStore implements CircleRequestStore {
    private readonly records;
    get(clientSubmissionKey: string): Promise<CircleRequestRecord | null>;
    set(record: CircleRequestRecord): Promise<void>;
    claim(clientSubmissionKey: string, placeholder: CircleRequestRecord): Promise<{
        claimed: boolean;
        record: CircleRequestRecord;
    }>;
}
export declare class CircleStoreRequiredError extends Error {
    constructor();
}
export declare class CircleAmbiguousSubmitError extends Error {
    constructor(clientSubmissionKey: string, idempotencyKey: string);
}
export interface CircleExecutorOptions {
    /** The Circle client used to call createTransfer()/getTransaction(). Never logged, never persisted by this class. */
    circle: CircleClient;
    /** Circle's own wallet id sending funds -- distinct from the onchain address, per Circle's own wallet model. */
    walletId: string;
    /** Circle's own tokenId for the asset being sent (e.g. Base USDC's Circle-assigned token identifier). */
    tokenId: string;
    /** Durable store for this adapter's own transaction record -- REQUIRED, no default (same discipline as every other adapter's `store` option). */
    store: CircleRequestStore;
    /** Base RPC used ONLY for read-only resume re-confirmation of an already-known transaction hash. Defaults to the public Base RPC. */
    rpcUrl?: string;
    /** Test seam: inject a fake read-only client instead of connecting to rpcUrl. */
    publicClient?: MinimalResumeClient;
}
export declare class CircleCommerceExecutor implements CommerceExecutor {
    readonly id = "circle-base-usdc";
    readonly version = "v2";
    readonly recoveryMode: ExecutorRecoveryMode;
    private readonly circle;
    private readonly walletId;
    private readonly tokenId;
    private readonly store;
    private readonly rpcUrl;
    private readonly injectedPublicClient?;
    constructor(options: CircleExecutorOptions);
    /** Read-only: validates the frozen action against this executor's Base/USDC scope. No Circle call. */
    prepare(context: PrepareContext): Promise<PrepareResult>;
    submit(prepared: PrepareResult): Promise<ExecutionResult>;
    /**
     * Shared by submit() (first check, right after the send) and resume()
     * (every later check) -- ONE getTransaction() poll, then an honest
     * mapping of Circle's current state. Neither caller loops internally; a
     * still-pending transaction returns submission-ambiguous with a retry
     * hint, and the orchestrator's own retry pattern (calling resume(),
     * never submit(), for an already-claimed identity) drives the next poll.
     */
    private resolve;
    private resolveFromResult;
    resume(prepared: PrepareResult, priorOutcome?: ExecutionResult): Promise<ExecutionResult>;
}
