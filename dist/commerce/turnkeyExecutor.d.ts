import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js';
import { BASE_NETWORK, BASE_USDC, type MinimalResumeClient } from './x402Executor.js';
export { BASE_NETWORK as TURNKEY_BASE_NETWORK, BASE_USDC as TURNKEY_BASE_USDC };
export type TurnkeyTransactionStatus = 'BROADCASTING' | 'INCLUDED' | 'FAILED';
export interface TurnkeyTransactionStatusResult {
    status: TurnkeyTransactionStatus;
    /** Present only on INCLUDED. */
    txHash?: string | null;
    /** Present on FAILED, and on INCLUDED when the transaction reverted onchain (per current Turnkey docs). */
    error?: {
        message?: string;
    } | null;
}
export interface TurnkeySendTransactionInput {
    from: string;
    to: string;
    value: string;
    data?: string;
    caip2: string;
}
/**
 * The minimal Turnkey public surface this executor depends on -- narrow
 * enough that the real Turnkey SDK's `ethSendTransaction`/
 * `pollTransactionStatus` via a small transport adapter, or a test double,
 * can both satisfy it unmodified (same discipline as x402Executor.ts's
 * `ClientEvmSigner` and payboxExecutor.ts's `PayBoxClient`).
 */
export interface TurnkeyClient {
    /** Signs AND broadcasts in one call (ethSendTransaction). Returns the durable send/track identity. Never called more than once per prepared identity by this adapter. */
    sendTransaction(input: TurnkeySendTransactionInput): Promise<{
        sendTransactionStatusId: string;
    }>;
    /** Polls the current status of a send by its sendTransactionStatusId (pollTransactionStatus). Read-only. */
    getTransactionStatus(sendTransactionStatusId: string): Promise<TurnkeyTransactionStatusResult>;
}
export interface TurnkeyRequestRecord {
    clientSubmissionKey: string;
    /** null only in the narrow window between "we called sendTransaction" and "we recorded its sendTransactionStatusId" -- see submit(). */
    sendTransactionStatusId: string | null;
    network: string;
    asset: string;
    atomicAmount: string;
    recipient: string;
    from: string;
    /** Set once INCLUDED is observed for this record -- once set, this adapter never re-polls or re-sends. */
    transactionHash: string | null;
}
export interface TurnkeyRequestStore {
    get(clientSubmissionKey: string): Promise<TurnkeyRequestRecord | null>;
    set(record: TurnkeyRequestRecord): Promise<void>;
    /**
     * Atomically claims the attempt slot for `clientSubmissionKey`: if no
     * record exists yet, stores `placeholder` (which MUST have
     * `sendTransactionStatusId: null`) and returns `{ claimed: true, record:
     * placeholder }` -- the caller, and ONLY the caller, may now call
     * `sendTransaction()`. If a record already exists, returns `{ claimed:
     * false, record: <the existing record, unmodified> }` and the caller MUST
     * NOT call `sendTransaction()` again. A real, multi-process
     * implementation MUST make this genuinely atomic (same discipline as
     * `PayBoxRequestStore.claim()`/`CommerceRecoveryStore.create()`).
     */
    claim(clientSubmissionKey: string, placeholder: TurnkeyRequestRecord): Promise<{
        claimed: boolean;
        record: TurnkeyRequestRecord;
    }>;
}
/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation -- same discipline as InMemoryPayBoxRequestStore. Does not survive a restart. */
export declare class InMemoryTurnkeyRequestStore implements TurnkeyRequestStore {
    private readonly records;
    get(clientSubmissionKey: string): Promise<TurnkeyRequestRecord | null>;
    set(record: TurnkeyRequestRecord): Promise<void>;
    claim(clientSubmissionKey: string, placeholder: TurnkeyRequestRecord): Promise<{
        claimed: boolean;
        record: TurnkeyRequestRecord;
    }>;
}
export declare class TurnkeyStoreRequiredError extends Error {
    constructor();
}
export declare class TurnkeyAmbiguousSubmitError extends Error {
    constructor(clientSubmissionKey: string);
}
export interface TurnkeyExecutorOptions {
    /** The Turnkey client used to call sendTransaction()/getTransactionStatus(). Never logged, never persisted by this class. */
    turnkey: TurnkeyClient;
    /** Durable store for this adapter's own send identity -- REQUIRED, no default (same discipline as PayBoxExecutorOptions.store). */
    store: TurnkeyRequestStore;
    /** Base RPC used ONLY for read-only resume re-confirmation of an already-known transaction hash. Defaults to the public Base RPC. */
    rpcUrl?: string;
    /** Test seam: inject a fake read-only client instead of connecting to rpcUrl. */
    publicClient?: MinimalResumeClient;
}
export declare class TurnkeyCommerceExecutor implements CommerceExecutor {
    readonly id = "turnkey-base-usdc";
    readonly version = "v1";
    readonly recoveryMode: ExecutorRecoveryMode;
    private readonly turnkey;
    private readonly store;
    private readonly rpcUrl;
    private readonly injectedPublicClient?;
    constructor(options: TurnkeyExecutorOptions);
    /**
     * Read-only from end to end: validates the frozen action against this
     * executor's Base/USDC scope and establishes the durable submission
     * identity's INPUT (not yet a Turnkey call) -- no store write, no
     * sendTransaction() call. Mirrors PayBoxCommerceExecutor's gateway-mode
     * prepare(): the actual state-changing action moves entirely to submit(),
     * called only after the orchestrator has already registered the durable
     * OCD execution binding.
     */
    prepare(context: PrepareContext): Promise<PrepareResult>;
    submit(prepared: PrepareResult): Promise<ExecutionResult>;
    /**
     * Shared by submit() (first check, right after the send) and resume()
     * (every later check) -- ONE getTransactionStatus() poll, then an honest
     * mapping of Turnkey's current status. Neither caller loops internally; a
     * still-BROADCASTING send returns submission-ambiguous with a retry hint,
     * and the orchestrator's own retry pattern (calling resume(), never
     * submit(), for an already-claimed identity) drives the next poll.
     */
    private resolve;
    resume(prepared: PrepareResult, priorOutcome?: ExecutionResult): Promise<ExecutionResult>;
}
