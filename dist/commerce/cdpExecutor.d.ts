import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js';
import { BASE_NETWORK, BASE_USDC, type MinimalResumeClient } from './x402Executor.js';
export { BASE_NETWORK as CDP_BASE_NETWORK, BASE_USDC as CDP_BASE_USDC };
export interface CdpSendTransactionInput {
    /** The CDP server wallet EVM account address to send from. */
    address: string;
    to: string;
    /** Atomic (wei-equivalent) value as a decimal string. */
    value: string;
    network: 'base';
    /** Passed as X-Idempotency-Key. See this file's header on CDP's documented guarantee. */
    idempotencyKey: string;
}
export interface CdpSendTransactionResult {
    /** Populated for EOA accounts. Current CDP docs never populate this alongside userOpHash. */
    transactionHash?: string | null;
}
export declare class CdpSendError extends Error {
    readonly code: string | null;
    constructor(message: string, code: string | null);
}
/**
 * The minimal CDP public surface this executor depends on -- narrow enough
 * that the real `@coinbase/cdp-sdk`'s `account.sendTransaction()` via a
 * small transport adapter, or a test double, can both satisfy it
 * unmodified (same discipline as x402Executor.ts's ClientEvmSigner and
 * payboxExecutor.ts/turnkeyExecutor.ts/crossmintExecutor.ts's own client
 * interfaces). Must reject with a CdpSendError (or any Error) on a send
 * failure -- current CDP docs describe no other terminal-failure shape for
 * this call.
 */
export interface CdpClient {
    sendTransaction(input: CdpSendTransactionInput): Promise<CdpSendTransactionResult>;
}
export interface CdpRequestRecord {
    clientSubmissionKey: string;
    network: string;
    atomicAmount: string;
    recipient: string;
    from: string;
    /** null only in the narrow window between "we called sendTransaction" and "we recorded its result" -- see submit(). */
    transactionHash: string | null;
    /** Set once we know CDP definitively never broadcast this attempt (a CdpSendError) -- terminal, distinct from the null/unknown crash window. */
    failed: {
        code: string | null;
        message: string;
    } | null;
}
export interface CdpRequestStore {
    get(clientSubmissionKey: string): Promise<CdpRequestRecord | null>;
    set(record: CdpRequestRecord): Promise<void>;
    /**
     * Atomically claims the attempt slot for `clientSubmissionKey`: if no
     * record exists yet, stores `placeholder` (which MUST have
     * `transactionHash: null` and `failed: null`) and returns `{ claimed:
     * true, record: placeholder }` -- the caller, and ONLY the caller, may
     * now call `sendTransaction()`. If a record already exists, returns
     * `{ claimed: false, record: <the existing record, unmodified> }` and
     * the caller MUST NOT call `sendTransaction()` again. A real,
     * multi-process implementation MUST make this genuinely atomic (same
     * discipline as every other adapter's `claim()`).
     */
    claim(clientSubmissionKey: string, placeholder: CdpRequestRecord): Promise<{
        claimed: boolean;
        record: CdpRequestRecord;
    }>;
}
/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation. Does not survive a restart. */
export declare class InMemoryCdpRequestStore implements CdpRequestStore {
    private readonly records;
    get(clientSubmissionKey: string): Promise<CdpRequestRecord | null>;
    set(record: CdpRequestRecord): Promise<void>;
    claim(clientSubmissionKey: string, placeholder: CdpRequestRecord): Promise<{
        claimed: boolean;
        record: CdpRequestRecord;
    }>;
}
export declare class CdpStoreRequiredError extends Error {
    constructor();
}
export declare class CdpAmbiguousSubmitError extends Error {
    constructor(clientSubmissionKey: string, idempotencyKey: string);
}
export interface CdpExecutorOptions {
    /** The CDP client used to call sendTransaction(). Never logged, never persisted by this class. */
    cdp: CdpClient;
    /** Durable store for this adapter's own send record -- REQUIRED, no default (same discipline as every other adapter's `store` option). */
    store: CdpRequestStore;
    /** Base RPC used ONLY for read-only resume re-confirmation of an already-known transaction hash. Defaults to the public Base RPC. */
    rpcUrl?: string;
    /** Test seam: inject a fake read-only client instead of connecting to rpcUrl. */
    publicClient?: MinimalResumeClient;
}
export declare class CdpCommerceExecutor implements CommerceExecutor {
    readonly id = "cdp-base-usdc";
    readonly version = "v1";
    readonly recoveryMode: ExecutorRecoveryMode;
    private readonly cdp;
    private readonly store;
    private readonly rpcUrl;
    private readonly injectedPublicClient?;
    constructor(options: CdpExecutorOptions);
    /** Read-only: validates the frozen action against this executor's Base/USDC scope. No CDP call. */
    prepare(context: PrepareContext): Promise<PrepareResult>;
    submit(prepared: PrepareResult): Promise<ExecutionResult>;
    private finalOutcome;
    resume(prepared: PrepareResult, priorOutcome?: ExecutionResult): Promise<ExecutionResult>;
}
