/**
 * payboxExecutor.ts — the one narrow PayBoxCommerceExecutor adapter (D2.6).
 *
 * PROVES: OCD works alongside an INDEPENDENT execution-control system.
 * PayBox (https://paybox.sh, MoonPay's non-custodial agent payment vault)
 * independently evaluates its own grant/approval rules and signs the
 * payment; OCD independently evaluates policy beforehand and independently
 * observes settlement afterward. Neither system's decision overrides the
 * other -- see client.ts's execute()/preflight() split, which is what
 * actually enforces this (the developer checks `preflight.kind === 'ready'`
 * BEFORE ever calling execute(), and execute() never runs PayBox logic for
 * an operation that never reached execute()).
 *
 * TWO EXECUTION MODES (D2.6 correction, live-verified against the real
 * @paybox-sh/sdk@0.8.5 and OneSource, 2026-09-06/07):
 *
 *   - 'header' (pay_x402 + present the header ourselves): PROVEN LIVE
 *     INCOMPATIBLE with OneSource. pay_x402's header-mode output is a legacy
 *     x402Version 1 X-PAYMENT header; OneSource serves x402Version 2. A real
 *     attempt (PayBox request dfbecdc0-368e-4607-bd5a-c9d52f1098d6) reached
 *     PayBox `success` but the merchant never accepted the payment -- no
 *     merchant transaction, wallet balance unchanged. That request is
 *     PRESERVED AS HISTORY (never mutated, never retried, never turned into
 *     a gateway request by this code) -- see resolveHeaderSuccess()'s
 *     version-mismatch detection, which turns a repeat of exactly this
 *     failure into an honest, terminal manual-recovery-required instead of
 *     an endless retry loop. Kept in this file because existing tests
 *     exercise it and it may still suit a merchant that genuinely serves
 *     x402Version 1 -- NOT because it is claimed compatible with OneSource
 *     or any other v2 merchant.
 *
 *   - 'gateway' (useService: PayBox itself fetches the merchant, handles the
 *     challenge/signing/payment/retry): PROVEN LIVE COMPATIBLE. Verified
 *     live against OneSource (PayBox request
 *     7a998655-147e-4cfb-8269-01672dfc515d): gateway payment succeeded
 *     (`output.value.payment.{gateway:true, status:"succeeded", ok:true}`),
 *     resource responded 200, and the wallet balance moved 0.100 -> 0.099
 *     USDC. The one real gap: PayBox's gateway result carries NO transaction
 *     hash. This adapter recovers it conservatively by searching Base USDC
 *     `Transfer` logs for the ONE exact match to the frozen preflight
 *     identity (payer, recipient, amount) -- see discoverTransaction().
 *
 * `mode` defaults to 'header' (unchanged existing behavior/tests) --
 * callers integrating against a real x402 v2 merchant like OneSource MUST
 * pass `mode: 'gateway'` explicitly. This file never silently upgrades or
 * downgrades a REQUEST's own mode: a durable PayBoxRequestRecord's own
 * `mode` field (set once, at the moment its placeholder is claimed) is
 * always authoritative for how that SPECIFIC request is interpreted on
 * resume -- never the executor instance's current configuration -- which is
 * what keeps the historical header-mode request's interpretation stable
 * even if this same operation were (hypothetically) resumed by an executor
 * now configured for 'gateway' mode by default.
 *
 * BINDING STRENGTH HONESTY (requirement 6): this file never computes or
 * claims a binding strength -- that remains entirely server-side
 * (commerceLifecycle.ts's deriveBindingStrength), unchanged by this file.
 * What IS true, and worth being explicit about: PAYMENT_IDENTITY_LINKED
 * requires the SERVER to independently observe an EIP-3009
 * `TransferWithAuthorization` event whose `authorizer` matches
 * `policy.expected_payer` -- gateway mode's provider output gives no direct
 * evidence of how PayBox authorized the underlying transfer, so this
 * adapter makes no assumption about it either way. The transaction this
 * adapter recovers is deliberately the MINIMUM claim actually justified: an
 * exact-match plain ERC-20 `Transfer` from the expected payer to the
 * expected recipient for the exact expected amount, in a bounded window
 * tied to when this specific request was created -- nothing here manufactures
 * or asserts a stronger correlation than that.
 *
 * PUBLIC CONTRACT USED (docs.paybox.sh + node_modules/@paybox-sh/sdk's own
 * dist/index.d.ts and README, inspected directly -- not re-derived from
 * docs summaries a second time):
 *   - `pay_x402` / header mode: signs an x402 "exact" payment authorization.
 *     Returns a `request_id` immediately; on eventual `success`,
 *     `output.value.x_payment` carries the header to present to the paid
 *     resource. PayBox does NOT itself call the resource for this tool.
 *   - `use_service` / gateway mode: PayBox discovers the resource's own 402
 *     challenge, signs, pays, and retries the request FOR the caller. Takes
 *     `{ credentialId, url, method?, body? }` -- deliberately NO `accepts[]`
 *     (PayBox negotiates the challenge itself). On success,
 *     `output.value.payment` carries gateway payment metadata and
 *     `output.value.response` carries the resource's own response.
 *   - `get_request`: polls the CURRENT status of a request by `request_id`.
 *     Non-terminal `pending_approval` -> `pending_signature` -> terminal
 *     `success` | `denied` | `error`. The "critical rule" applies to BOTH
 *     `pay_x402` and `use_service` identically: "submit once, then poll --
 *     never re-issue the original tool call to 'finish' it." This adapter
 *     calls whichever provider action its mode selects AT MOST ONCE per
 *     clientSubmissionKey (from prepare()); every subsequent check, in
 *     submit() or resume(), calls `get_request` only.
 *
 * THIS FILE DEPENDS ON NO SPECIFIC PAYBOX SDK VERSION: `PayBoxClient` below
 * is a minimal structural interface mirroring the documented tool contracts
 * above (same discipline as x402Executor.ts's `ClientEvmSigner` -- narrow
 * enough that the real `@paybox-sh/sdk`'s `PayboxClient` via a small
 * transport adapter, a direct MCP tool-call wrapper, or a test double can
 * all satisfy it unmodified). `useService` is OPTIONAL on this interface so
 * an existing header-mode-only test double remains a valid implementation.
 *
 * WHY A SEPARATE PayBoxRequestStore (Section 11's "small adapter-specific
 * helper" exception): the orchestrator (client.ts's CommerceOperation)
 * persists only clientSubmissionKey/executorId/executionRequestId/
 * transactionHash across a restart -- on resume, it reconstructs a GENERIC
 * `PrepareResult.reference = { action }`, not whatever an individual
 * executor's own prepare() returned (see client.ts's executeLocked(),
 * both resume branches). PayBox's OWN durable request_id (keyed by
 * clientSubmissionKey, which the orchestrator DOES reliably pass to both
 * prepare() and resume()), plus this adapter's own mode/expected-payer/
 * search-anchor bookkeeping, is the only thing standing between a lost
 * response and a duplicate PayBox request or a lost transaction search.
 *
 * RECOVERY MODE: 'stable-payment-identity', not 'provider-idempotent' and
 * not 'manual'. Chosen by what PayBox's OWN public contract actually
 * guarantees, not for the strongest-sounding label (Section 5):
 *   - NOT 'provider-idempotent': that would claim calling the provider
 *     action twice with the same intent is safe (PayBox itself would
 *     dedupe). Docs say the opposite -- resubmitting creates a duplicate
 *     request, for BOTH pay_x402 and use_service. False if claimed.
 *   - IS 'stable-payment-identity': once a request_id exists, `get_request`
 *     can be polled/resumed against that SAME id indefinitely, deterministically,
 *     with no risk of creating a new operation -- exactly the definition
 *     Section 5 gives for this label. The identity is the PayBox request_id
 *     itself, established once in prepare() and never re-created.
 *   - The one honest gap: if the provider action is called but the process
 *     dies before learning whether PayBox ever created a request (no
 *     response at all), there is no stable identity to resume -- see
 *     prepare()'s PayBoxAmbiguousPrepareError, which surfaces this narrow
 *     window explicitly rather than silently retrying.
 */
import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import { BASE_NETWORK, BASE_USDC } from './x402Executor.js';
import { X402ChallengeError, decodeChallenge, validateChallenge, decodeSettlementResponse, decimalToAtomic6 } from './x402Challenge.js';
export { BASE_NETWORK as PAYBOX_BASE_NETWORK, BASE_USDC as PAYBOX_BASE_USDC };
const USDC_TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
/**
 * D2.6 correction: the FIXED size (in blocks) of the gateway-mode
 * transaction-search window, frozen at prepare() time as
 * `searchFromBlock + GATEWAY_SEARCH_WINDOW_BLOCKS` -- never recomputed on
 * resume, and never allowed to expand past this bound. ~1 hour at Base's
 * ~2s block time: generous enough for approval delay + PayBox processing +
 * on-chain confirmation lag, small enough that an unrelated future transfer
 * between the same two addresses for the same amount cannot eventually
 * become a false match for an old, abandoned request.
 */
const GATEWAY_SEARCH_WINDOW_BLOCKS = 1800n;
/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation -- same discipline as recoveryStore.ts's InMemoryRecoveryStore. Does not survive a restart; a real deployment must implement this against durable storage. */
export class InMemoryPayBoxRequestStore {
    records = new Map();
    async get(clientSubmissionKey) {
        return this.records.get(clientSubmissionKey) ?? null;
    }
    async set(record) {
        this.records.set(record.clientSubmissionKey, { ...record });
    }
    async claim(clientSubmissionKey, placeholder) {
        // No `await` between the check and the write -- this is what makes this
        // specific implementation race-free for concurrent callers IN THIS PROCESS.
        const existing = this.records.get(clientSubmissionKey);
        if (existing)
            return { claimed: false, record: { ...existing } };
        const stored = { ...placeholder };
        this.records.set(clientSubmissionKey, stored);
        return { claimed: true, record: { ...stored } };
    }
}
/** Thrown by the PayBoxCommerceExecutor constructor when no durable store was supplied (D2.6 review fix #2). */
export class PayBoxStoreRequiredError extends Error {
    constructor() {
        super("PayBoxCommerceExecutor requires an explicit, durable `store` (PayBoxRequestStore) -- InMemoryPayBoxRequestStore is test/example-only and does not survive a restart, which would silently make this executor's advertised recoveryMode ('stable-payment-identity') false. Pass a durable implementation in production; InMemoryPayBoxRequestStore only in tests/examples.");
        this.name = 'PayBoxStoreRequiredError';
    }
}
/** Thrown by prepare() when a PRIOR attempt for this exact clientSubmissionKey called the provider action but this process never learned the outcome -- see this file's header for why this cannot be silently retried. */
export class PayBoxAmbiguousPrepareError extends Error {
    constructor(clientSubmissionKey) {
        super(`a prior prepare() for clientSubmissionKey "${clientSubmissionKey}" called PayBox but this process never learned whether PayBox created a request -- neither pay_x402 nor use_service has an idempotency key, so calling it again here could create a SECOND PayBox request for the same intended payment. Check PayBox directly (dashboard or "paybox request --list") for an orphaned request tied to this payment before retrying.`);
        this.name = 'PayBoxAmbiguousPrepareError';
    }
}
export class PayBoxCommerceExecutor {
    id = 'paybox-x402-base-usdc';
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
    version;
    recoveryMode = 'stable-payment-identity';
    paybox;
    credentialId;
    store;
    mode;
    fetchImpl;
    rpcUrl;
    injectedPublicClient;
    injectedBaseReadClient;
    constructor(options) {
        if (!options.store)
            throw new PayBoxStoreRequiredError();
        this.paybox = options.paybox;
        this.credentialId = options.credentialId;
        this.store = options.store;
        this.mode = options.mode ?? 'header';
        this.version = this.mode === 'gateway' ? 'v1-gateway' : 'v1';
        // See client.ts's constructor comment: binding here is what keeps a bare
        // `globalThis.fetch` reference safe to call as `this.fetchImpl(...)` in
        // a real browser.
        this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.rpcUrl = options.rpcUrl ?? 'https://mainnet.base.org';
        this.injectedPublicClient = options.publicClient;
        this.injectedBaseReadClient = options.baseReadClient;
    }
    baseLogClient() {
        if (this.injectedBaseReadClient)
            return this.injectedBaseReadClient;
        const client = createPublicClient({ chain: base, transport: http(this.rpcUrl) });
        return client;
    }
    /** A record's OWN mode is authoritative -- never the executor's current configuration (see this file's header). Records from before this field existed are always 'header'. */
    modeOf(record) {
        return record?.mode ?? 'header';
    }
    async prepare(context) {
        if (context.action.network !== BASE_NETWORK)
            throw new X402ChallengeError(`this executor only supports ${BASE_NETWORK}, got "${context.action.network}"`);
        if (context.action.asset.toLowerCase() !== BASE_USDC.toLowerCase()) {
            throw new X402ChallengeError(`this executor only supports USDC (${BASE_USDC}), got "${context.action.asset}"`);
        }
        if (!context.action.resource)
            throw new X402ChallengeError('action.resource (the x402 resource URL) is required to prepare a submission');
        if (this.mode === 'gateway') {
            if (!this.paybox.useService)
                throw new Error('mode is "gateway" but the supplied PayBoxClient does not implement useService()');
            if (!context.action.sender) {
                throw new X402ChallengeError('gateway mode requires action.sender to be set to the PayBox wallet address (the expected on-chain payer) -- required to search for the settlement transfer, since PayBox\'s gateway result carries no transaction hash directly');
            }
        }
        // Read-only probe -- no PayBox call, no signing, no payment. Establishes
        // exactly what would be agreed to pay BEFORE any authorization exists,
        // identical in spirit to X402BaseUsdcExecutor.prepare(). Safe to run
        // more than once even under a concurrent race (it has no side effects).
        // Kept for BOTH modes as an independent check that the merchant's actual
        // current challenge matches the frozen preflighted action -- gateway
        // mode does not need `accepts` from this (useService negotiates its own
        // challenge), but validating it here is free defense-in-depth against a
        // stale/wrong resource.
        const probe = await this.fetchImpl(context.action.resource);
        if (probe.status !== 402)
            throw new X402ChallengeError(`expected HTTP 402 from ${context.action.resource}, got ${probe.status}`);
        const challenge = decodeChallenge(probe);
        const atomicAmount = decimalToAtomic6(context.action.amount);
        validateChallenge(challenge, { network: context.action.network, asset: context.action.asset, amount: atomicAmount, recipient: context.action.recipient });
        // Gateway mode: capture the search-window anchor BEFORE the atomic claim
        // (read-only, no side effect, safe to redo on a retry) -- so a transient
        // RPC hiccup here never leaves an ambiguous placeholder for a PayBox
        // request that was never actually created.
        let searchFromBlock = null;
        if (this.mode === 'gateway') {
            searchFromBlock = await this.baseLogClient().getBlockNumber();
        }
        // D2.6 review fix #3: atomically claim the attempt slot for this
        // clientSubmissionKey -- exactly one concurrent caller may proceed to
        // call the provider action. A loser either reuses the winner's already-
        // established request (if it finished first) or, if the winner is still
        // in the ambiguous pre-request-id window, stops safely rather than
        // racing to call the provider action itself.
        const placeholder = {
            clientSubmissionKey: context.clientSubmissionKey,
            payboxRequestId: null,
            resourceUrl: context.action.resource,
            network: context.action.network,
            asset: context.action.asset,
            atomicAmount,
            recipient: context.action.recipient,
            transactionHash: null,
            mode: this.mode,
            expectedPayer: context.action.sender ?? null,
            searchFromBlock: searchFromBlock !== null ? searchFromBlock.toString() : null,
            // D2.6 correction: frozen NOW, alongside searchFromBlock -- never
            // recomputed on resume, so the window can never expand indefinitely.
            searchToBlock: searchFromBlock !== null ? (searchFromBlock + GATEWAY_SEARCH_WINDOW_BLOCKS).toString() : null,
        };
        const { claimed, record: claimedRecord } = await this.store.claim(context.clientSubmissionKey, placeholder);
        if (!claimed) {
            if (claimedRecord.payboxRequestId) {
                // Another attempt already established (or is finishing establishing)
                // a PayBox request for this exact key -- never call the provider
                // action again.
                return this.toPrepareResult(context.clientSubmissionKey, claimedRecord);
            }
            // The winner called the provider action but this process never
            // learned the outcome (crash, or the winner is still in flight).
            // Known, unavoidable crash window (see this file's header) -- surface
            // it honestly rather than racing to call the provider ourselves.
            throw new PayBoxAmbiguousPrepareError(context.clientSubmissionKey);
        }
        // We won the claim -- exactly this call may proceed to PayBox. This is
        // PayBox's OWN independent grant/authorization check -- the provider
        // action internally applies the credential's approval mode ("iframe" /
        // "always_approve" / "autonomous" per docs.paybox.sh/concepts/model)
        // before ever producing a signature.
        let requestId;
        if (this.mode === 'gateway') {
            const envelope = await this.paybox.useService({
                credential_id: this.credentialId,
                url: context.action.resource,
                method: 'GET',
            });
            requestId = envelope.request_id;
        }
        else {
            const envelope = await this.paybox.payX402({
                credential_id: this.credentialId,
                accepts: challenge.accepts,
                resource_url: context.action.resource,
                x402_version: challenge.x402Version,
            });
            requestId = envelope.request_id;
        }
        const record = { ...claimedRecord, payboxRequestId: requestId };
        await this.store.set(record);
        return this.toPrepareResult(context.clientSubmissionKey, record);
    }
    toPrepareResult(clientSubmissionKey, record) {
        const reference = {
            payboxRequestId: record.payboxRequestId,
            resourceUrl: record.resourceUrl,
            network: record.network,
            asset: record.asset,
            atomicAmount: record.atomicAmount,
            recipient: record.recipient,
        };
        return {
            clientSubmissionKey,
            reference,
            preparedAt: new Date().toISOString(),
            // Section 7: correlated into the D2.4 execution binding, and from
            // there the lifecycle evidence bundle, by client.ts.
            providerReference: record.payboxRequestId ? `paybox:${record.payboxRequestId}` : null,
        };
    }
    async submit(prepared) {
        const ref = prepared.reference;
        return this.resolve(prepared.clientSubmissionKey, ref);
    }
    async resume(prepared, priorOutcome) {
        // Mirrors X402BaseUsdcExecutor's own resume(): if a transaction hash is
        // ALREADY known from a prior call, independently re-confirm it read-only
        // on-chain -- never guess a new one, never re-present/re-search.
        if (priorOutcome?.status === 'transaction-known') {
            const client = this.injectedPublicClient ?? createPublicClient({ chain: base, transport: http(this.rpcUrl) });
            try {
                await client.getTransactionReceipt({ hash: priorOutcome.transactionHash });
                return priorOutcome;
            }
            catch {
                return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'submission-ambiguous', reason: 'previously reported transaction hash was not found on Base mainnet (may still be propagating)' };
            }
        }
        // The orchestrator reconstructs a GENERIC `prepared.reference = { action }`
        // on resume (see this file's header) -- the PayBox request_id (and mode,
        // expectedPayer, searchFromBlock) can only be found via this adapter's
        // OWN durable store, keyed by the one field the orchestrator DOES
        // reliably pass through: clientSubmissionKey.
        const record = await this.store.get(prepared.clientSubmissionKey);
        if (!record || !record.payboxRequestId) {
            return {
                clientSubmissionKey: prepared.clientSubmissionKey,
                status: 'manual-recovery-required',
                reason: 'no PayBox request is on record for this submission attempt -- check PayBox directly (dashboard or CLI) before retrying',
            };
        }
        return this.resolve(prepared.clientSubmissionKey, {
            payboxRequestId: record.payboxRequestId,
            resourceUrl: record.resourceUrl,
            network: record.network,
            asset: record.asset,
            atomicAmount: record.atomicAmount,
            recipient: record.recipient,
        });
    }
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
    async resolve(clientSubmissionKey, ref) {
        const record = await this.store.get(clientSubmissionKey);
        if (record?.transactionHash) {
            // Already resolved in a prior call -- never re-present/re-search.
            return { clientSubmissionKey, status: 'transaction-known', transactionHash: record.transactionHash, providerReference: `paybox:${ref.payboxRequestId}` };
        }
        if (!ref.payboxRequestId) {
            return { clientSubmissionKey, status: 'manual-recovery-required', reason: 'no PayBox request_id is available for this submission attempt' };
        }
        let envelope;
        try {
            envelope = await this.paybox.getRequest(ref.payboxRequestId);
        }
        catch (err) {
            // get_request is a read-only status check -- a failure here is
            // ambiguous about PayBox's OWN reachability, never about whether the
            // request itself changed state. Safe to just try again later.
            return { clientSubmissionKey, status: 'submission-ambiguous', reason: `could not reach PayBox to check request ${ref.payboxRequestId}: ${err?.message || 'no response'}`, retryAfterSeconds: 5 };
        }
        if (envelope.status === 'pending_approval' || envelope.status === 'pending_signature') {
            return {
                clientSubmissionKey,
                status: 'submission-ambiguous',
                reason: `PayBox request ${ref.payboxRequestId} is ${envelope.status} -- poll again, do not resubmit`,
                retryAfterSeconds: envelope.status === 'pending_approval' ? 15 : 5,
            };
        }
        if (envelope.status === 'denied') {
            // Terminal and definitive: PayBox's OWN grant/approval rules rejected
            // this payment. This is NOT an OCD outcome and NOT ambiguous -- no
            // merchant payment occurred and none will for this request. Mapped to
            // manual-recovery-required (the closest of the three ExecutionOutcome
            // states to "no execution, a human should see why and decide next
            // steps") rather than submission-ambiguous, so the developer is NOT
            // told to just keep retrying a denial that will never change.
            return {
                clientSubmissionKey,
                status: 'manual-recovery-required',
                reason: `PayBox denied request ${ref.payboxRequestId}${envelope.reason ? `: ${envelope.reason}` : ''} -- no merchant payment was made`,
            };
        }
        if (envelope.status === 'error') {
            // docs.paybox.sh/concepts/requests lists `error` under "Terminal
            // (polling stops)" -- treating it as retryable submission-ambiguous
            // would poll the SAME terminal envelope forever and, worse, invites a
            // caller to eventually give up and start a NEW PayBox request for the
            // same intent. Terminal and definitive, exactly like `denied`.
            return {
                clientSubmissionKey,
                status: 'manual-recovery-required',
                reason: `PayBox reported a terminal error for request ${ref.payboxRequestId}${envelope.message ? `: ${envelope.message}` : ''} -- no merchant payment was made; this request will not resolve differently on retry`,
            };
        }
        // status === 'success': dispatch on the RECORD's own mode -- see modeOf().
        if (this.modeOf(record) === 'gateway') {
            return this.resolveGatewaySuccess(clientSubmissionKey, ref, envelope, record);
        }
        return this.resolveHeaderSuccess(clientSubmissionKey, ref, envelope);
    }
    /**
     * header mode: PayBox signed the payment but did NOT submit it to the
     * merchant -- presenting it is this adapter's job, exactly like
     * X402BaseUsdcExecutor.submit()'s own post-signing half.
     */
    async resolveHeaderSuccess(clientSubmissionKey, ref, envelope) {
        const xPayment = envelope.output?.value?.x_payment;
        if (!xPayment?.header || !xPayment?.value) {
            // `success` is ALSO terminal (per docs) -- polling get_request again
            // would return this exact same envelope forever, so this must stop
            // safely rather than being reported as retryable.
            return {
                clientSubmissionKey,
                status: 'manual-recovery-required',
                reason: `PayBox request ${ref.payboxRequestId} reached terminal status "success" but no x_payment header could be read from its output -- check PayBox directly before retrying`,
            };
        }
        return this.presentPaymentToMerchant(clientSubmissionKey, ref, xPayment);
    }
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
    async presentPaymentToMerchant(clientSubmissionKey, ref, xPayment) {
        let res;
        try {
            res = await this.fetchImpl(ref.resourceUrl, { headers: { [xPayment.header]: xPayment.value } });
        }
        catch (err) {
            return { clientSubmissionKey, status: 'submission-ambiguous', reason: err?.message || 'no response from the resource after presenting the PayBox-signed payment', retryAfterSeconds: 5 };
        }
        if (res.status === 402) {
            let versionMismatch;
            try {
                const retryChallenge = decodeChallenge(res);
                versionMismatch = retryChallenge?.x402Version;
            }
            catch {
                // Could not decode a retry challenge -- fall through to the generic ambiguous case below.
            }
            if (versionMismatch === 2) {
                return {
                    clientSubmissionKey,
                    status: 'manual-recovery-required',
                    reason: `PayBox request ${ref.payboxRequestId}'s header-mode payment was rejected (still 402) and the merchant's challenge advertises x402Version 2 -- PayBox's header-mode output is not compatible with an x402 v2 merchant for this resource. No merchant transaction occurred. Use mode: 'gateway' (useService) for this merchant instead; this request will not resolve differently on retry.`,
                };
            }
            return { clientSubmissionKey, status: 'submission-ambiguous', reason: `resource still returned 402 after presenting the PayBox-signed payment (status ${res.status})` };
        }
        if (!res.ok) {
            return { clientSubmissionKey, status: 'submission-ambiguous', reason: `resource returned HTTP ${res.status} after presenting the PayBox-signed payment -- outcome unknown` };
        }
        const { transactionHash } = decodeSettlementResponse(res);
        if (!transactionHash) {
            return { clientSubmissionKey, status: 'submission-ambiguous', reason: 'resource responded successfully but no transaction hash could be parsed from the settlement response' };
        }
        // Durable BEFORE returning -- resolve() must never re-present this
        // payment header to the merchant again once a hash is known.
        const record = await this.store.get(clientSubmissionKey);
        if (record)
            await this.store.set({ ...record, transactionHash });
        return { clientSubmissionKey, status: 'transaction-known', transactionHash, providerReference: `paybox:${ref.payboxRequestId}` };
    }
    /**
     * gateway mode: PayBox itself called the merchant. Validate the provider's
     * success claim (requirement 3) before treating anything as paid, persist
     * non-secret metadata, then recover the transaction identity conservatively
     * (requirement 4) -- never from balance-delta, never by guessing.
     */
    async resolveGatewaySuccess(clientSubmissionKey, ref, envelope, record) {
        const payment = envelope.output?.value?.payment;
        const resourceResponse = envelope.output?.value?.response;
        const valid = payment?.gateway === true &&
            payment?.status === 'succeeded' &&
            payment?.ok === true &&
            payment?.network === ref.network &&
            payment?.scheme === 'exact' &&
            resourceResponse != null &&
            resourceResponse.ok === true &&
            typeof resourceResponse.status === 'number' &&
            resourceResponse.status >= 200 &&
            resourceResponse.status < 300;
        if (!valid) {
            return {
                clientSubmissionKey,
                status: 'manual-recovery-required',
                reason: `PayBox gateway request ${ref.payboxRequestId} reported "success" but its payment/resource result failed validation (gateway=${payment?.gateway}, payment.status=${payment?.status}, payment.ok=${payment?.ok}, payment.network=${payment?.network}, payment.scheme=${payment?.scheme}, resource.status=${resourceResponse?.status}, resource.ok=${resourceResponse?.ok}) -- treating a malformed/inconsistent success as unpaid rather than guessing`,
            };
        }
        // Persist non-secret provider metadata -- never a signature/authorization value.
        await this.store.set({
            ...record,
            outputId: envelope.output_id ?? null,
            auditId: envelope.audit_id ?? null,
            resourceStatus: resourceResponse.status ?? null,
        });
        return this.discoverTransaction(clientSubmissionKey, ref, { ...record, outputId: envelope.output_id ?? null, auditId: envelope.audit_id ?? null, resourceStatus: resourceResponse.status ?? null });
    }
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
    async discoverTransaction(clientSubmissionKey, ref, record) {
        if (!record.expectedPayer) {
            return {
                clientSubmissionKey,
                status: 'manual-recovery-required',
                reason: `PayBox gateway request ${ref.payboxRequestId} succeeded but no expectedPayer is on record to search for the settlement transfer -- this should not happen for a request created by this version of the adapter; check PayBox and Base directly`,
            };
        }
        const fromBlock = record.searchFromBlock ? BigInt(record.searchFromBlock) : 0n;
        // Frozen once, at prepare() time. A record from before this field
        // existed gets a fallback computed HERE and persisted immediately below
        // -- so it converges to one stable value from this point on, rather than
        // silently recomputing (and therefore drifting) on every call.
        const frozenToBlock = record.searchToBlock ? BigInt(record.searchToBlock) : fromBlock + GATEWAY_SEARCH_WINDOW_BLOCKS;
        if (!record.searchToBlock) {
            await this.store.set({ ...record, searchToBlock: frozenToBlock.toString() });
        }
        const client = this.baseLogClient();
        let chainHead;
        try {
            chainHead = await client.getBlockNumber();
        }
        catch (err) {
            return { clientSubmissionKey, status: 'submission-ambiguous', reason: `could not reach Base to search for the settlement transfer: ${err?.message || 'no response'}`, retryAfterSeconds: 10 };
        }
        // Never query past the frozen upper bound, even if the chain has moved
        // further -- a transfer beyond it must be ignored, not matched.
        const effectiveToBlock = chainHead < frozenToBlock ? chainHead : frozenToBlock;
        const windowExhausted = chainHead >= frozenToBlock;
        let logs;
        try {
            logs = await client.getLogs({
                address: ref.asset,
                event: USDC_TRANSFER_EVENT,
                args: { from: record.expectedPayer, to: ref.recipient },
                fromBlock,
                toBlock: effectiveToBlock,
            });
        }
        catch (err) {
            return { clientSubmissionKey, status: 'submission-ambiguous', reason: `Base log search failed: ${err?.message || 'no response'}`, retryAfterSeconds: 10 };
        }
        const expectedAmount = BigInt(ref.atomicAmount);
        const exact = logs.filter((log) => log.args?.value === expectedAmount);
        if (exact.length === 0) {
            if (windowExhausted) {
                // The frozen window (fromBlock..searchToBlock) has been fully
                // searched with no match -- this will not resolve differently on
                // further retry. Terminal, not endlessly ambiguous.
                return {
                    clientSubmissionKey,
                    status: 'manual-recovery-required',
                    reason: `PayBox gateway request ${ref.payboxRequestId} succeeded but no matching on-chain USDC transfer (payer ${record.expectedPayer} -> recipient ${ref.recipient}, ${ref.atomicAmount} atomic) was found in the full search window (blocks ${fromBlock}-${frozenToBlock}) -- the window is now exhausted; this will not resolve differently on retry`,
                };
            }
            return {
                clientSubmissionKey,
                status: 'submission-ambiguous',
                reason: `PayBox gateway execution succeeded but no matching on-chain USDC transfer (payer ${record.expectedPayer} -> recipient ${ref.recipient}, ${ref.atomicAmount} atomic) has been observed yet in blocks ${fromBlock}-${effectiveToBlock} (window open through ${frozenToBlock}) -- may still be settling`,
                retryAfterSeconds: 10,
            };
        }
        if (exact.length > 1) {
            // Never guess between multiple exact matches -- terminal, human review required.
            return {
                clientSubmissionKey,
                status: 'manual-recovery-required',
                reason: `found ${exact.length} exactly-matching USDC transfers (payer ${record.expectedPayer} -> recipient ${ref.recipient}, ${ref.atomicAmount} atomic) in blocks ${fromBlock}-${effectiveToBlock} for PayBox gateway request ${ref.payboxRequestId} -- cannot uniquely identify the settlement transaction`,
            };
        }
        const match = exact[0];
        await this.store.set({ ...record, transactionHash: match.transactionHash, transactionBlockHash: match.blockHash, transactionLogIndex: Number(match.logIndex) });
        return { clientSubmissionKey, status: 'transaction-known', transactionHash: match.transactionHash, providerReference: `paybox:${ref.payboxRequestId}` };
    }
}
