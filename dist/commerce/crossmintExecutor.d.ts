import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js';
import { BASE_NETWORK, BASE_USDC, type MinimalResumeClient } from './x402Executor.js';
export { BASE_NETWORK as CROSSMINT_BASE_NETWORK, BASE_USDC as CROSSMINT_BASE_USDC };
export type CrossmintTransactionStatus = 'awaiting-approval' | 'pending' | 'success' | 'failed';
export interface CrossmintTransactionResult {
    id: string;
    status: CrossmintTransactionStatus;
    /** Present once a final on-chain transaction exists. Current Crossmint docs expose no separate UserOperation hash on this shape. */
    onChain?: {
        txId: string;
    } | null;
    error?: {
        reason?: string;
        message?: string;
    } | null;
}
export interface CrossmintTransferInput {
    /** The sending wallet's locator (e.g. an address or Crossmint wallet identifier). */
    walletLocator: string;
    /** Token locator, e.g. `base:<contractAddress>` per current Crossmint docs. */
    tokenLocator: string;
    recipient: string;
    /** Decimal string amount, per current Crossmint docs (e.g. "42.69"), NOT atomic units. */
    amount: string;
    /** Passed as the x-idempotency-key header. See this file's header on why this is defense-in-depth, not relied on alone. */
    idempotencyKey: string;
}
/**
 * The minimal Crossmint public surface this executor depends on -- narrow
 * enough that a real Crossmint SDK/HTTP client via a small transport
 * adapter, or a test double, can both satisfy it unmodified (same
 * discipline as x402Executor.ts's ClientEvmSigner and
 * payboxExecutor.ts/turnkeyExecutor.ts's own client interfaces).
 */
export interface CrossmintClient {
    /** Calls Crossmint's transfer/send endpoint. Never called more than once per prepared identity by this adapter. */
    transfer(input: CrossmintTransferInput): Promise<CrossmintTransactionResult>;
    /** Polls the current status of a transfer by its id (Get Transaction). Read-only. */
    getTransaction(id: string): Promise<CrossmintTransactionResult>;
}
export interface CrossmintRequestRecord {
    clientSubmissionKey: string;
    /** null only in the narrow window between "we called transfer" and "we recorded its id" -- see submit(). */
    transferId: string | null;
    tokenLocator: string;
    amount: string;
    recipient: string;
    walletLocator: string;
    /** Set once success is observed for this record -- once set, this adapter never re-polls or re-sends. */
    transactionHash: string | null;
}
export interface CrossmintRequestStore {
    get(clientSubmissionKey: string): Promise<CrossmintRequestRecord | null>;
    set(record: CrossmintRequestRecord): Promise<void>;
    /**
     * Atomically claims the attempt slot for `clientSubmissionKey`: if no
     * record exists yet, stores `placeholder` (which MUST have
     * `transferId: null`) and returns `{ claimed: true, record: placeholder
     * }` -- the caller, and ONLY the caller, may now call `transfer()`. If a
     * record already exists, returns `{ claimed: false, record: <the
     * existing record, unmodified> }` and the caller MUST NOT call
     * `transfer()` again. A real, multi-process implementation MUST make
     * this genuinely atomic (same discipline as
     * `TurnkeyRequestStore.claim()`/`PayBoxRequestStore.claim()`).
     */
    claim(clientSubmissionKey: string, placeholder: CrossmintRequestRecord): Promise<{
        claimed: boolean;
        record: CrossmintRequestRecord;
    }>;
}
/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation -- same discipline as InMemoryTurnkeyRequestStore/InMemoryPayBoxRequestStore. Does not survive a restart. */
export declare class InMemoryCrossmintRequestStore implements CrossmintRequestStore {
    private readonly records;
    get(clientSubmissionKey: string): Promise<CrossmintRequestRecord | null>;
    set(record: CrossmintRequestRecord): Promise<void>;
    claim(clientSubmissionKey: string, placeholder: CrossmintRequestRecord): Promise<{
        claimed: boolean;
        record: CrossmintRequestRecord;
    }>;
}
export declare class CrossmintStoreRequiredError extends Error {
    constructor();
}
export declare class CrossmintAmbiguousSubmitError extends Error {
    constructor(clientSubmissionKey: string);
}
export interface CrossmintExecutorOptions {
    /** The Crossmint client used to call transfer()/getTransaction(). Never logged, never persisted by this class. */
    crossmint: CrossmintClient;
    /** Durable store for this adapter's own transfer identity -- REQUIRED, no default (same discipline as PayBoxExecutorOptions.store/TurnkeyExecutorOptions.store). */
    store: CrossmintRequestStore;
    /** Base RPC used ONLY for read-only resume re-confirmation of an already-known transaction hash. Defaults to the public Base RPC. */
    rpcUrl?: string;
    /** Test seam: inject a fake read-only client instead of connecting to rpcUrl. */
    publicClient?: MinimalResumeClient;
}
export declare class CrossmintCommerceExecutor implements CommerceExecutor {
    readonly id = "crossmint-base-usdc";
    readonly version = "v1";
    readonly recoveryMode: ExecutorRecoveryMode;
    private readonly crossmint;
    private readonly store;
    private readonly rpcUrl;
    private readonly injectedPublicClient?;
    constructor(options: CrossmintExecutorOptions);
    /**
     * Read-only from end to end: validates the frozen action against this
     * executor's Base/USDC scope and establishes the durable submission
     * identity's INPUT (not yet a Crossmint call) -- no store write, no
     * transfer() call. Mirrors TurnkeyCommerceExecutor/PayBoxCommerceExecutor
     * gateway-mode prepare(): the actual state-changing action moves entirely
     * to submit(), called only after the orchestrator has already registered
     * the durable OCD execution binding.
     */
    prepare(context: PrepareContext): Promise<PrepareResult>;
    submit(prepared: PrepareResult): Promise<ExecutionResult>;
    /**
     * Shared by submit() (first check, right after the send) and resume()
     * (every later check) -- ONE getTransaction() poll, then an honest
     * mapping of Crossmint's current status. Neither caller loops internally;
     * a still-pending transfer returns submission-ambiguous with a retry
     * hint, and the orchestrator's own retry pattern (calling resume(), never
     * submit(), for an already-claimed identity) drives the next poll.
     */
    private resolve;
    private resolveFromResult;
    resume(prepared: PrepareResult, priorOutcome?: ExecutionResult): Promise<ExecutionResult>;
}
