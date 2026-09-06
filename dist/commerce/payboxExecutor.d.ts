import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js';
import { BASE_NETWORK, BASE_USDC, type MinimalResumeClient } from './x402Executor.js';
export { BASE_NETWORK as PAYBOX_BASE_NETWORK, BASE_USDC as PAYBOX_BASE_USDC };
export type PayBoxExecutionMode = 'gateway' | 'header';
export type PayBoxRequestStatus = 'pending_approval' | 'pending_signature' | 'success' | 'denied' | 'error';
export interface PayBoxGatewayPaymentInfo {
    gateway?: boolean;
    header_available?: boolean;
    header_name?: string | null;
    network?: string;
    ok?: boolean;
    proof_status?: string;
    scheme?: string;
    status?: string;
}
export interface PayBoxGatewayResourceResponse {
    status?: number;
    ok?: boolean;
    body?: unknown;
}
export interface PayBoxRequestEnvelope {
    request_id: string;
    status: PayBoxRequestStatus;
    /** Non-secret, safe-to-store provider metadata (D2.6 requirement 3). */
    output_id?: string | null;
    audit_id?: string | null;
    /** header mode: `{ x_payment: {header,value} }`. gateway mode: `{ payment, response }`. */
    output?: {
        value?: {
            x_payment?: {
                header: string;
                value: string;
            };
            payment?: PayBoxGatewayPaymentInfo;
            response?: PayBoxGatewayResourceResponse;
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
export interface PayBoxUseServiceInput {
    /** A wallet-kind credential id. */
    credential_id: string;
    /** The paid resource URL -- PayBox negotiates the 402 challenge itself. */
    url: string;
    method?: string;
    body?: unknown;
}
/**
 * The minimal PayBox public surface this executor depends on. `useService`
 * is OPTIONAL: a header-mode-only client (including every existing test
 * double) remains a valid implementation; the executor only calls it when
 * constructed with `mode: 'gateway'`, and throws a clear error if that mode
 * is selected against a client that doesn't implement it.
 */
export interface PayBoxClient {
    payX402(input: PayBoxPayX402Input): Promise<PayBoxRequestEnvelope>;
    useService?(input: PayBoxUseServiceInput): Promise<PayBoxRequestEnvelope>;
    getRequest(requestId: string): Promise<PayBoxRequestEnvelope>;
}
/** The subset of a Base read client discoverTransaction() needs -- narrowed so tests can inject a minimal fake instead of a real RPC connection, same discipline as x402Executor.ts's MinimalResumeClient. */
export interface MinimalBaseLogClient {
    getBlockNumber(): Promise<bigint>;
    getLogs(args: {
        address: `0x${string}`;
        event: unknown;
        args?: Record<string, unknown>;
        fromBlock: bigint;
        toBlock: bigint;
    }): Promise<Array<{
        transactionHash: `0x${string}`;
        blockHash: `0x${string}`;
        logIndex: number;
        args: {
            from?: string;
            to?: string;
            value?: bigint;
        };
    }>>;
}
export interface PayBoxRequestRecord {
    clientSubmissionKey: string;
    /** null only in the narrow window between "we called the provider action" and "we recorded its request_id" -- see prepare(). */
    payboxRequestId: string | null;
    resourceUrl: string;
    network: string;
    asset: string;
    atomicAmount: string;
    recipient: string;
    /** Set once a transaction is known to correspond to this request -- once set, this adapter never re-presents a payment or re-searches for a different one. */
    transactionHash: string | null;
    /**
     * Which provider action this SPECIFIC request used -- set once, at claim
     * time, from the executor's configuration, and NEVER changed afterward.
     * Absent/undefined on a record created before this field existed: always
     * treated as 'header' in that case (every request before D2.6's gateway
     * support was header-mode) -- see modeOf().
     */
    mode?: PayBoxExecutionMode;
    /** gateway mode only: the wallet address expected to appear as the on-chain sender, from context.action.sender. Required to search Transfer logs. */
    expectedPayer?: string | null;
    /** gateway mode only: the Base block number captured (read-only, BEFORE calling useService) as the lower bound of the on-chain transfer search window -- stored as a decimal string (JSON has no bigint). Fixed once so repeated resume() calls never miss a transfer that took a while to confirm. */
    searchFromBlock?: string | null;
    /**
     * gateway mode only (D2.6 correction): the FROZEN upper bound of the
     * search window -- `searchFromBlock + GATEWAY_SEARCH_WINDOW_BLOCKS`,
     * computed and persisted once, at the same moment as `searchFromBlock`.
     * Without this, discoverTransaction() searching "searchFromBlock ->
     * current chain head" on every resume would let the candidate window
     * expand indefinitely, so an unrelated FUTURE transfer between the same
     * two addresses for the same amount could eventually become the single
     * exact match for an old request. A restart/resume MUST use this exact
     * same value, never recompute a fresh one.
     */
    searchToBlock?: string | null;
    /** Non-secret provider metadata (D2.6 requirement 3) -- never anything sensitive (no signatures, no authorization payloads). */
    outputId?: string | null;
    auditId?: string | null;
    resourceStatus?: number | null;
    /** Exact matched on-chain event identity, once discovered (requirement 4). */
    transactionBlockHash?: string | null;
    transactionLogIndex?: number | null;
}
export interface PayBoxRequestStore {
    get(clientSubmissionKey: string): Promise<PayBoxRequestRecord | null>;
    set(record: PayBoxRequestRecord): Promise<void>;
    /**
     * Atomically claims the attempt slot for `clientSubmissionKey` (D2.6
     * review fix #3): if no record exists yet, stores `placeholder` (which
     * MUST have `payboxRequestId: null`) and returns `{ claimed: true, record:
     * placeholder }` -- the caller, and ONLY the caller, may now call the
     * provider action for this key. If a record already exists (whether still
     * in the ambiguous pre-request-id window, or already holding a
     * `payboxRequestId`), returns `{ claimed: false, record: <the existing
     * record, unmodified> }` and the caller MUST NOT call the provider action.
     *
     * This is the ONE operation in this interface that a real, multi-process
     * implementation MUST make genuinely atomic (e.g. a SQL `INSERT ... ON
     * CONFLICT DO NOTHING` followed by a `SELECT`, or an equivalent
     * conditional-put) -- the same discipline as `CommerceRecoveryStore.create()`
     * throwing `RecoveryRecordExistsError` rather than silently overwriting.
     * `InMemoryPayBoxRequestStore`'s implementation is atomic only because a
     * single JS `Map` access with no `await` in between can never interleave
     * with another call in the same process.
     */
    claim(clientSubmissionKey: string, placeholder: PayBoxRequestRecord): Promise<{
        claimed: boolean;
        record: PayBoxRequestRecord;
    }>;
}
/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation -- same discipline as recoveryStore.ts's InMemoryRecoveryStore. Does not survive a restart; a real deployment must implement this against durable storage. */
export declare class InMemoryPayBoxRequestStore implements PayBoxRequestStore {
    private readonly records;
    get(clientSubmissionKey: string): Promise<PayBoxRequestRecord | null>;
    set(record: PayBoxRequestRecord): Promise<void>;
    claim(clientSubmissionKey: string, placeholder: PayBoxRequestRecord): Promise<{
        claimed: boolean;
        record: PayBoxRequestRecord;
    }>;
}
/** Thrown by the PayBoxCommerceExecutor constructor when no durable store was supplied (D2.6 review fix #2). */
export declare class PayBoxStoreRequiredError extends Error {
    constructor();
}
/** Thrown by prepare() when a PRIOR attempt for this exact clientSubmissionKey called the provider action but this process never learned the outcome -- see this file's header for why this cannot be silently retried. */
export declare class PayBoxAmbiguousPrepareError extends Error {
    constructor(clientSubmissionKey: string);
}
export interface PayBoxExecutorOptions {
    /** The PayBox client used to call the provider action(s)/get_request. Never logged, never persisted by this class. */
    paybox: PayBoxClient;
    /** The single PayBox wallet-kind credential this executor pays from (Section 2: one credential, one operation at a time for the reference flow). */
    credentialId: string;
    /**
     * Durable store for this adapter's own request identity -- REQUIRED, no
     * default (D2.6 review fix #2). This class advertises
     * `recoveryMode: 'stable-payment-identity'`, which is only true if the
     * PayBox request_id genuinely survives a restart; silently defaulting to
     * `InMemoryPayBoxRequestStore` would make that claim false the moment the
     * process restarts. `InMemoryPayBoxRequestStore` remains available for
     * tests/examples but must be passed explicitly, exactly like
     * `CommerceRecoveryStore` has no safe default either.
     */
    store: PayBoxRequestStore;
    /**
     * Which provider action prepare() uses for a NEW request. Defaults to
     * 'header' (unchanged prior behavior). 'header' is proven live
     * incompatible with OneSource (x402 v2) -- see this file's header. Pass
     * 'gateway' for a real x402 v2 merchant.
     */
    mode?: PayBoxExecutionMode;
    fetch?: typeof globalThis.fetch;
    /** Base RPC used for read-only resume confirmation of an already-known transaction hash, and (gateway mode) transaction discovery. Defaults to the public Base RPC. */
    rpcUrl?: string;
    /** Test seam: inject a fake read-only client instead of connecting to rpcUrl, for the existing known-hash re-confirm path. */
    publicClient?: MinimalResumeClient;
    /** Test seam: inject a fake read-only log/block client instead of connecting to rpcUrl, for gateway mode's transaction discovery. */
    baseReadClient?: MinimalBaseLogClient;
}
export declare class PayBoxCommerceExecutor implements CommerceExecutor {
    readonly id = "paybox-x402-base-usdc";
    /**
     * D2.6 correction: gateway mode reports a DIFFERENT version string
     * ('v1-gateway') than header mode ('v1') -- this is the explicit,
     * already-durable signal (recorded on the execution binding as
     * `executor_version`, unchanged plumbing) that the server-side binding-
     * strength derivation uses to cap gateway-recovered transactions at
     * TRANSFER_MATCH_ONLY (see onchaindiligence-mcp's commerceLifecycle.ts,
     * isConservativeMatchOnlyEvidence()). Gateway mode's transaction is
     * recovered via a conservative exact-field-match search with no direct
     * request_id -> transaction_hash relationship PayBox exposes -- header
     * mode presents the actual signed authorization to the merchant itself,
     * which IS direct evidence, so its version is unchanged.
     */
    readonly version: string;
    readonly recoveryMode: ExecutorRecoveryMode;
    private readonly paybox;
    private readonly credentialId;
    private readonly store;
    private readonly mode;
    private readonly fetchImpl;
    private readonly rpcUrl;
    private readonly injectedPublicClient?;
    private readonly injectedBaseReadClient?;
    constructor(options: PayBoxExecutorOptions);
    private baseLogClient;
    /** A record's OWN mode is authoritative -- never the executor's current configuration (see this file's header). Records from before this field existed are always 'header'. */
    private modeOf;
    prepare(context: PrepareContext): Promise<PrepareResult>;
    private toPrepareResult;
    submit(prepared: PrepareResult): Promise<ExecutionResult>;
    /**
     * Gateway mode's ENTIRE state-changing action (D2.6 correction). Called by
     * the orchestrator only after the durable OCD execution binding already
     * exists (client.ts's executeLocked() registers it between prepare() and
     * submit()) -- so by the time useService() can possibly run, OCD already
     * has a durable row to resume from.
     *
     * Atomically claims the submission slot itself (the SAME
     * PayBoxRequestStore.claim() mechanism prepare() used to use): exactly one
     * concurrent `submit()` call (e.g. two racing processes that both reached
     * the "register a new binding" branch) may proceed to call useService().
     * The search window's bounds are frozen HERE, immediately before the one
     * useService() call -- tied to the actual provider submission attempt,
     * never to whenever prepare() happened to run (Section 6).
     */
    private submitGateway;
    private refFromRecord;
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
     * header mode: PayBox signed the payment but did NOT submit it to the
     * merchant -- presenting it is this adapter's job, exactly like
     * X402BaseUsdcExecutor.submit()'s own post-signing half.
     */
    private resolveHeaderSuccess;
    /**
     * Attaches the PayBox-signed x402 payment header and calls the merchant
     * resource exactly once per invocation. Safe to call again if a PRIOR
     * attempt never reached a response (the underlying x402 "exact" scheme
     * authorization is a single-use EIP-3009 `transferWithAuthorization` --
     * the merchant/facilitator re-broadcasting the SAME authorization a second
     * time reverts on-chain rather than double-charging; this adapter still
     * avoids that path whenever possible by checking `record.transactionHash`
     * first in resolve()).
     *
     * D2.6 correction: also detects the EXACT class of failure a real
     * historical request (dfbecdc0-368e-4607-bd5a-c9d52f1098d6) hit live --
     * PayBox's header-mode output is x402Version 1 while the merchant serves
     * x402Version 2 -- and reports it as a terminal, honest incompatibility
     * rather than an endlessly-retryable ambiguous state. No merchant
     * transaction occurs either way; this only changes what the caller is
     * told to do next.
     */
    private presentPaymentToMerchant;
    /**
     * gateway mode: PayBox itself called the merchant. Validate the provider's
     * success claim (requirement 3) before treating anything as paid, persist
     * non-secret metadata, then recover the transaction identity conservatively
     * (requirement 4) -- never from balance-delta, never by guessing.
     */
    private resolveGatewaySuccess;
    /**
     * Conservative transaction-identity recovery (requirement 4): PayBox's
     * gateway result carries no transaction hash, so this searches Base USDC
     * `Transfer` logs for the ONE exact match to the frozen preflight identity
     * (payer, recipient, amount) in a window BOTH of whose bounds are frozen
     * at prepare() time (`record.searchFromBlock`/`searchToBlock`, see their
     * own doc comments) -- NEVER "searchFromBlock -> current chain head",
     * which would let the candidate window expand indefinitely on every
     * resume (D2.6 correction). Balance delta alone is NEVER treated as
     * transaction identity -- only an exact, uniquely-matching event within
     * this frozen window.
     *
     * Outcomes:
     *   - exactly one exact match within the window -> transaction-known
     *   - zero matches, window still open (chain head < searchToBlock)
     *     -> submission-ambiguous (retryable -- may still be settling)
     *   - zero matches, window exhausted (chain head >= searchToBlock)
     *     -> manual-recovery-required (terminal -- this request will not
     *     resolve differently on further retry)
     *   - more than one exact match -> manual-recovery-required (never guessed)
     *   - a match outside the frozen window is never even queried, let alone matched
     *
     * This is ONLY for identifying the candidate payment transaction to hand
     * to OCD. It does not replace, weaken, or bypass OCD's own independent
     * server-side settlement observation (requirement 5) -- the recovered hash
     * is passed to finalize() exactly like any other executor's transaction
     * hash, and the server re-derives execution/settlement/binding-strength
     * from its own independent chain read, not from anything this method
     * concludes.
     */
    private discoverTransaction;
}
