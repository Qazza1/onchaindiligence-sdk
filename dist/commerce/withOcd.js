import { createCommerceClient } from './client.js';
import { InMemoryRecoveryStore } from './recoveryStore.js';
const DEFAULT_BASE_URL = 'https://mcp.onchaindiligence.com';
const DEFAULT_FINALIZATION_RETRY_SECONDS = 5;
export class OcdPaymentPolicyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OcdPaymentPolicyError';
    }
}
/**
 * x402 v2 §9 `settlement_pending`: the settlement transaction was broadcast
 * but its confirmation could not be established. Non-terminal -- funds may
 * still move. @x402/core carries it only as a `SettleResponse.errorReason`
 * string (its own SETTLEMENT_PENDING_REASON constant is not exported).
 */
const X402_SETTLEMENT_PENDING = 'settlement_pending';
/** Emitted when a pending settlement carries no reference OCD could observe. */
const SETTLEMENT_PENDING_UNOBSERVABLE = 'settlement-pending-payment-may-have-occurred';
/** A one-shot promise that lets the x402 hook wait only until the binding exists. */
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
/**
 * The x402 client owns signing/submission. This executor only supplies the
 * existing CommerceOperation with a prepared identity, then waits for the
 * post-payment hook to report an actual settlement response.
 */
class DeferredX402Executor {
    id = 'x402-v2-deferred-client';
    version = 'v1';
    recoveryMode = 'manual';
    bindingRegistered = deferred();
    settlement = deferred();
    settled = false;
    async prepare(context) {
        return {
            clientSubmissionKey: context.clientSubmissionKey,
            reference: { action: context.action },
            preparedAt: new Date().toISOString(),
        };
    }
    async submit(prepared) {
        // executeLocked() calls submit only after the durable execution binding
        // response has been persisted locally.
        this.bindingRegistered.resolve();
        const settlement = await this.settlement.promise;
        if (settlement.kind === 'transaction-known') {
            // Also used for a pending settlement: the broadcast reference is known,
            // settlement is not. OCD's finalization observes it independently.
            return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'transaction-known', transactionHash: settlement.transactionHash };
        }
        if (settlement.kind === 'settlement-pending-unobservable') {
            return {
                clientSubmissionKey: prepared.clientSubmissionKey,
                status: 'submission-ambiguous',
                reason: 'x402 settlement is pending without an observable reference; the payment may already have occurred -- inspect the payer or merchant, never pay again',
            };
        }
        return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'manual-recovery-required', reason: settlement.reason };
    }
    async resume(prepared) {
        return {
            clientSubmissionKey: prepared.clientSubmissionKey,
            status: 'manual-recovery-required',
            reason: 'x402 v2 payment submission cannot be reconstructed from a missing settlement response; inspect the payer or merchant before retrying',
        };
    }
    waitForBinding() {
        return this.bindingRegistered.promise;
    }
    failBeforeBinding(error) {
        this.bindingRegistered.reject(error);
    }
    resolveSettlement(result) {
        if (this.settled)
            return;
        this.settled = true;
        this.settlement.resolve(result);
    }
}
/** Keyed by the network identifier OCD's settlement observers expect. */
const CANONICAL_ASSETS = {
    'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    'eip155:1': '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'eip155:4217': '0x20c0000000000000000000000000000000000000',
    'solana:mainnet': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};
/**
 * x402 network identifier -> OCD observer network identifier. x402 v2 uses
 * the CAIP-2 genesis-hash reference for Solana mainnet (spec §11.1); OCD's
 * Solana observer is keyed `solana:mainnet`. Every other identifier passes
 * through unchanged.
 */
const X402_TO_OCD_NETWORK = {
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana:mainnet',
};
function ocdNetwork(x402Network) {
    return X402_TO_OCD_NETWORK[x402Network] ?? x402Network;
}
/** null when in OCD observation scope; otherwise the precise reason it is not. */
function outOfScopeReason(requirements) {
    const network = ocdNetwork(requirements.network);
    const expected = CANONICAL_ASSETS[network];
    if (expected === undefined)
        return `network ${requirements.network} is not a supported OCD settlement-observation network`;
    // EVM addresses are case-insensitive. Solana base58 mint identifiers are
    // not: lowercasing one can silently identify a different asset.
    const matches = network.startsWith('eip155:') ? requirements.asset.toLowerCase() === expected : requirements.asset === expected;
    return matches ? null : `asset ${requirements.asset} is not the canonical observed asset on ${requirements.network}`;
}
function decimalAmount(atomic) {
    if (!/^\d+$/.test(atomic))
        throw new OcdPaymentPolicyError('x402 selected requirement amount must be an unsigned atomic integer');
    const normalized = atomic.replace(/^0+(?=\d)/, '');
    const padded = normalized.padStart(7, '0');
    const whole = padded.slice(0, -6);
    const fraction = padded.slice(-6).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}
function sameOrigin(url, baseUrl) {
    try {
        return new URL(url).origin === new URL(baseUrl).origin;
    }
    catch {
        return false;
    }
}
function settlementTransaction(context) {
    if (context.error)
        return { kind: 'no-receipt', reason: 'payment-response-error' };
    if (!context.settleResponse)
        return { kind: 'no-receipt', reason: 'settlement-response-missing' };
    if (!context.settleResponse.success) {
        // Pending is not failure: keep any broadcast reference for independent
        // observation, and never report it as payment-failed.
        if (context.settleResponse.errorReason === X402_SETTLEMENT_PENDING) {
            return context.settleResponse.transaction
                ? { kind: 'transaction-known', transactionHash: context.settleResponse.transaction, pending: true }
                : { kind: 'settlement-pending-unobservable' };
        }
        return { kind: 'no-receipt', reason: 'payment-failed' };
    }
    if (!context.settleResponse.transaction)
        return { kind: 'no-receipt', reason: 'settlement-response-missing' };
    return { kind: 'transaction-known', transactionHash: context.settleResponse.transaction, pending: false };
}
function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
/**
 * Registers OCD lifecycle hooks on an existing x402 v2 client and returns the
 * same client. The caller retains all wallet/signer ownership.
 *
 * v1 is intentionally untouched: v1 does not provide the required v2 hook
 * correlation, so this wrapper never fabricates OCD evidence for it.
 */
export function withOcd(client, options) {
    if (typeof window !== 'undefined') {
        throw new OcdPaymentPolicyError('withOcd is Node.js-only in v1; do not persist OCD recovery credentials in browser storage');
    }
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const store = options.store ?? new InMemoryRecoveryStore();
    const unavailable = options.onOcdUnavailable ?? 'abort';
    const accountApiKey = options.accountApiKey?.trim() || undefined;
    const ocd = createCommerceClient({ endpoint: baseUrl, recovery: store, fetch: options.ocdFetch, accountApiKey });
    const flows = new WeakMap();
    const emit = (flow, result) => {
        if (flow.terminalEmitted)
            return;
        flow.terminalEmitted = true;
        // Delivery is observational for the caller. It must not turn a settled
        // merchant request into a rejection because their callback failed.
        void Promise.resolve()
            .then(() => options.onReceipt(result))
            .catch(() => { });
    };
    const observeFallback = async (flow, context) => {
        const settlement = settlementTransaction(context);
        if (settlement.kind === 'settlement-pending-unobservable') {
            emit(flow, { kind: 'no-receipt', reason: SETTLEMENT_PENDING_UNOBSERVABLE });
            return;
        }
        if (settlement.kind !== 'transaction-known') {
            emit(flow, { kind: 'no-receipt', reason: settlement.reason });
            return;
        }
        // A pending settlement that is not yet observable must not read as a
        // failed observation: the payment may already have occurred.
        const unobserved = settlement.pending ? SETTLEMENT_PENDING_UNOBSERVABLE : 'observation-only-failed';
        try {
            const res = await ocd.apiFetch('/observe-payment', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // Do not add caller assertions here: selected x402 requirement data is
                // not an independently established payment fact.
                body: JSON.stringify({ network: ocdNetwork(context.requirements.network), transaction_hash: settlement.transactionHash }),
            });
            if (!res.ok) {
                emit(flow, { kind: 'no-receipt', reason: unobserved });
                return;
            }
            emit(flow, { kind: 'post-payment-evidence', receipt: (await res.json()) });
        }
        catch {
            emit(flow, { kind: 'no-receipt', reason: unobserved });
        }
    };
    /** Free read-only check that the new operation is visible to the configured workspace. */
    const workspaceOwnership = async (operationId) => {
        try {
            const res = await ocd.apiFetch(`/me/operations/${encodeURIComponent(operationId)}`, {
                headers: { authorization: `Bearer ${accountApiKey}` },
                redirect: 'error',
            });
            return res.ok ? 'owned' : 'not-owned';
        }
        catch {
            return 'unreachable';
        }
    };
    const finalizationCapabilityExpired = async (operationId) => {
        const record = await store.load(operationId).catch(() => null);
        if (!record?.finalizationCapabilityExpiresAt)
            return false;
        const expiry = Date.parse(record.finalizationCapabilityExpiresAt);
        return Number.isFinite(expiry) && expiry <= Date.now();
    };
    const finalizeInBackground = async (flow) => {
        while (true) {
            if (await finalizationCapabilityExpired(flow.operation.operationId)) {
                emit(flow, { kind: 'no-receipt', reason: 'finalization-capability-expired', operationId: flow.operation.operationId });
                return;
            }
            try {
                const finalized = await flow.operation.observeAndFinalize();
                if (finalized.kind === 'receipt-produced') {
                    emit(flow, { kind: 'full-lifecycle', receipt: finalized.receipt, operationId: flow.operation.operationId });
                    return;
                }
                if (finalized.kind === 'terminal-error') {
                    emit(flow, { kind: 'no-receipt', reason: 'finalization-terminal-error', operationId: flow.operation.operationId });
                    return;
                }
                // `pending` is an observation delay, not a reason to create another
                // operation or submit a second payment. Retry this exact operation
                // while this process remains alive; a crash is recovered by the
                // caller's durable CommerceRecoveryStore.
                if (await finalizationCapabilityExpired(flow.operation.operationId)) {
                    emit(flow, { kind: 'no-receipt', reason: 'finalization-capability-expired', operationId: flow.operation.operationId });
                    return;
                }
                await wait((finalized.retryAfterSeconds ?? DEFAULT_FINALIZATION_RETRY_SECONDS) * 1000);
            }
            catch {
                emit(flow, { kind: 'no-receipt', reason: 'finalization-terminal-error', operationId: flow.operation.operationId });
                return;
            }
        }
    };
    client.onBeforePaymentCreation(async (context) => {
        // Only x402 v2 exact is safely correlated by this wrapper. v1 remains
        // native-client behavior, with no OCD receipt fabricated.
        if (context.paymentRequired.x402Version !== 2 || context.selectedRequirements.scheme !== 'exact')
            return;
        if (sameOrigin(context.paymentRequired.resource.url, baseUrl))
            return;
        const requirements = context.selectedRequirements;
        const outOfScope = outOfScopeReason(requirements);
        if (outOfScope) {
            const flow = { kind: 'fallback', terminalEmitted: false };
            flows.set(requirements, flow);
            emit(flow, { kind: 'no-receipt', reason: 'unsupported-canonical-asset' });
            return { abort: true, reason: `OCD policy enforcement aborted payment creation: selected x402 requirement is outside OCD independent-observation scope (${outOfScope})` };
        }
        let operation;
        try {
            operation = await ocd.open({
                action: {
                    kind: 'PAYMENT',
                    resource: context.paymentRequired.resource.url,
                    network: ocdNetwork(requirements.network),
                    asset: requirements.asset,
                    amount: decimalAmount(requirements.amount),
                    sender: null,
                    recipient: requirements.payTo,
                },
                policy: options.policy,
            });
        }
        catch (error) {
            if (unavailable === 'proceed') {
                flows.set(requirements, { kind: 'fallback', terminalEmitted: false });
                return;
            }
            return { abort: true, reason: `OCD policy enforcement aborted payment creation: unable to open an OCD operation (${error instanceof Error ? error.message : 'unknown error'})` };
        }
        // A workspace key that is not honoured must not silently produce an
        // anonymous operation: stop before the paid preflight, so no fee is spent
        // on evidence the workspace Ledger would never show.
        if (accountApiKey) {
            const ownership = await workspaceOwnership(operation.operationId);
            if (ownership === 'unreachable' && unavailable === 'proceed') {
                flows.set(requirements, { kind: 'fallback', terminalEmitted: false });
                return;
            }
            if (ownership !== 'owned') {
                const flow = { kind: 'fallback', terminalEmitted: false };
                emit(flow, { kind: 'no-receipt', reason: 'workspace-ownership-not-confirmed', operationId: operation.operationId });
                return { abort: true, reason: 'OCD policy enforcement aborted payment creation: the configured workspace API key did not confirm ownership of the new operation (invalid, revoked or unreachable); no preflight fee was spent' };
            }
        }
        // From here forward, observation-only fallback is forbidden: an OCD
        // preflight has been attempted or an operation state must be preserved.
        let evaluation;
        try {
            evaluation = await operation.preflight();
        }
        catch (error) {
            const flow = { kind: 'fallback', terminalEmitted: false };
            emit(flow, { kind: 'no-receipt', reason: 'preflight-failed', operationId: operation.operationId });
            return { abort: true, reason: `OCD policy enforcement aborted payment creation: preflight failed after operation open (${error instanceof Error ? error.message : 'unknown error'})` };
        }
        if (evaluation.kind === 'blocked' || evaluation.kind === 'approval-required') {
            const flow = { kind: 'fallback', terminalEmitted: false };
            emit(flow, { kind: 'blocked', decision: evaluation.receipt.receipt.decision });
            return { abort: true, reason: `OCD policy enforcement aborted payment creation: policy decision is ${evaluation.receipt.receipt.decision.status}` };
        }
        if (evaluation.kind !== 'ready') {
            const flow = { kind: 'fallback', terminalEmitted: false };
            emit(flow, { kind: 'no-receipt', reason: 'preflight-not-ready', operationId: operation.operationId });
            return { abort: true, reason: 'OCD policy enforcement aborted payment creation: preflight did not produce an executable ALLOW decision' };
        }
        const executor = new DeferredX402Executor();
        const flow = {
            kind: 'lifecycle',
            operation,
            executor,
            execution: Promise.resolve(),
            terminalEmitted: false,
            paymentResponseHandled: false,
        };
        flows.set(requirements, flow);
        flow.execution = operation.execute({ executor });
        void flow.execution.catch((error) => executor.failBeforeBinding(error));
        try {
            await executor.waitForBinding();
        }
        catch (error) {
            emit(flow, { kind: 'no-receipt', reason: 'execution-binding-failed', operationId: operation.operationId });
            return { abort: true, reason: `OCD policy enforcement aborted payment creation: execution binding failed (${error instanceof Error ? error.message : 'unknown error'})` };
        }
    });
    client.onPaymentResponse(async (context) => {
        const flow = flows.get(context.requirements);
        if (!flow)
            return;
        if (flow.kind === 'fallback') {
            // Receipt delivery is never on the merchant response path, including
            // the narrow observation-only fallback.
            void observeFallback(flow, context).catch(() => { });
            return;
        }
        // A transport/adapter may defensively surface the same result twice. It
        // must not initiate a second finalize call for one selected requirement.
        if (flow.paymentResponseHandled)
            return;
        flow.paymentResponseHandled = true;
        const settlement = settlementTransaction(context);
        flow.executor.resolveSettlement(settlement);
        if (settlement.kind === 'settlement-pending-unobservable') {
            // The operation stays recorded as submission-ambiguous; nothing here
            // retries or re-submits the payment.
            emit(flow, { kind: 'no-receipt', reason: SETTLEMENT_PENDING_UNOBSERVABLE, operationId: flow.operation.operationId });
            return;
        }
        if (settlement.kind !== 'transaction-known') {
            emit(flow, { kind: 'no-receipt', reason: settlement.reason, operationId: flow.operation.operationId });
            return;
        }
        // A pending settlement with a broadcast reference continues exactly like a
        // settled one: the same operation is finalized only once OCD independently
        // observes the transaction (finalization stays `pending` until then).
        // Do not hold the merchant HTTP response open for independently observed
        // chain finality. The recovery store holds the operation for later retry.
        void flow.execution
            .then(async (execution) => {
            if (!execution || typeof execution !== 'object' || execution.kind !== 'execution-recorded')
                return;
            await finalizeInBackground(flow);
        })
            .catch(() => {
            // The durable operation remains in the supplied recovery store. Do
            // not turn a late lifecycle failure into false post-payment evidence.
        });
    });
    return client;
}
