import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js';
import { BASE_NETWORK, BASE_USDC, type MinimalResumeClient } from './x402Executor.js';
export { BASE_NETWORK as PAYBOX_BASE_NETWORK, BASE_USDC as PAYBOX_BASE_USDC };
export type PayBoxRequestStatus = 'pending_approval' | 'pending_signature' | 'success' | 'denied' | 'error';
export interface PayBoxRequestEnvelope {
    request_id: string;
    status: PayBoxRequestStatus;
    /** Present on `success`. For pay_x402, carries `{ x_payment: { header, value } }` -- the signed payment header to present to the paid resource. PayBox does not itself call the resource. */
    output?: {
        value?: {
            x_payment?: {
                header: string;
                value: string;
            };
        };
    } & Record<string, unknown>;
    /** Present on `denied`. */
    reason?: string;
    /** Present on `error`. */
    message?: string;
}
export interface PayBoxPayX402Input {
    /** A wallet-kind credential id. */
    credential_id: string;
    /** The 402's `accepts` PaymentRequirements array, verbatim. */
    accepts: unknown[];
    /** The paid resource URL, for audit/display. */
    resource_url: string;
    /** 1 for JSON-body requirements, 2 for header requirements. */
    x402_version?: 1 | 2;
}
/**
 * The minimal PayBox public surface this executor depends on -- exactly
 * `pay_x402` and `get_request`, structurally typed so any transport (the
 * real `@paybox-sh/sdk` PayboxClient, an MCP tool-call wrapper, or a test
 * double) can satisfy it without this package taking a hard dependency on
 * a specific vendor SDK version.
 */
export interface PayBoxClient {
    payX402(input: PayBoxPayX402Input): Promise<PayBoxRequestEnvelope>;
    getRequest(requestId: string): Promise<PayBoxRequestEnvelope>;
}
export interface PayBoxRequestRecord {
    clientSubmissionKey: string;
    /** null only in the narrow window between "we called pay_x402" and "we recorded its request_id" -- see prepare(). */
    payboxRequestId: string | null;
    resourceUrl: string;
    network: string;
    asset: string;
    atomicAmount: string;
    recipient: string;
    /** Set once the merchant resource confirms the payment and returns a hash -- once set, this adapter never re-presents the PayBox-signed header to the merchant again. */
    transactionHash: string | null;
}
export interface PayBoxRequestStore {
    get(clientSubmissionKey: string): Promise<PayBoxRequestRecord | null>;
    set(record: PayBoxRequestRecord): Promise<void>;
}
/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation -- same discipline as recoveryStore.ts's InMemoryRecoveryStore. Does not survive a restart; a real deployment must implement this against durable storage. */
export declare class InMemoryPayBoxRequestStore implements PayBoxRequestStore {
    private readonly records;
    get(clientSubmissionKey: string): Promise<PayBoxRequestRecord | null>;
    set(record: PayBoxRequestRecord): Promise<void>;
}
/** Thrown by prepare() when a PRIOR attempt for this exact clientSubmissionKey called pay_x402 but this process never learned the outcome -- see this file's header for why this cannot be silently retried. */
export declare class PayBoxAmbiguousPrepareError extends Error {
    constructor(clientSubmissionKey: string);
}
export interface PayBoxExecutorOptions {
    /** The PayBox client used to call pay_x402/get_request. Never logged, never persisted by this class. */
    paybox: PayBoxClient;
    /** The single PayBox wallet-kind credential this executor pays from (Section 2: one credential, one operation at a time for the reference flow). */
    credentialId: string;
    /** Durable store for this adapter's own request identity. Defaults to an in-memory store -- REQUIRED to be durable (e.g. backed by the same storage as your CommerceRecoveryStore) for real crash/restart recovery, exactly like recoveryStore.ts's own default. */
    store?: PayBoxRequestStore;
    fetch?: typeof globalThis.fetch;
    /** Base RPC used ONLY for read-only resume confirmation of an already-known transaction hash. Defaults to the public Base RPC. */
    rpcUrl?: string;
    /** Test seam: inject a fake read-only client instead of connecting to rpcUrl. */
    publicClient?: MinimalResumeClient;
}
export declare class PayBoxCommerceExecutor implements CommerceExecutor {
    readonly id = "paybox-x402-base-usdc";
    readonly version = "v1";
    readonly recoveryMode: ExecutorRecoveryMode;
    private readonly paybox;
    private readonly credentialId;
    private readonly store;
    private readonly fetchImpl;
    private readonly rpcUrl;
    private readonly injectedPublicClient?;
    constructor(options: PayBoxExecutorOptions);
    prepare(context: PrepareContext): Promise<PrepareResult>;
    private toPrepareResult;
    submit(prepared: PrepareResult): Promise<ExecutionResult>;
    resume(prepared: PrepareResult, priorOutcome?: ExecutionResult): Promise<ExecutionResult>;
    /**
     * Shared by submit() (first check, right after prepare()) and resume()
     * (every later check) -- ONE `get_request` poll, then an honest mapping of
     * PayBox's current status. This is the entire "polling" mechanism: neither
     * method loops internally. A still-pending request returns
     * 'submission-ambiguous' with a retry hint, and the EXISTING orchestrator
     * retry pattern (the developer calling op.execute() again, which calls
     * resume(), never submit(), for an already-claimed identity) is what
     * drives the next poll -- see Section 11: no parallel polling API.
     */
    private resolve;
    /**
     * Attaches the PayBox-signed x402 payment header and calls the merchant
     * resource exactly once per invocation. Safe to call again if a PRIOR
     * attempt never reached a response (the underlying x402 "exact" scheme
     * authorization is a single-use EIP-3009 `transferWithAuthorization` --
     * the merchant/facilitator re-broadcasting the SAME authorization a second
     * time reverts on-chain rather than double-charging; this adapter still
     * avoids that path whenever possible by checking `record.transactionHash`
     * first in resolve()).
     */
    private presentPaymentToMerchant;
}
