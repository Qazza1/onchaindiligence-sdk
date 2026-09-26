import { createCommerceClient } from './client.js';
import { InMemoryRecoveryStore } from './recoveryStore.js';
const DEFAULT_BASE_URL = 'https://mcp.onchaindiligence.com';
export class OcdPaymentPolicyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OcdPaymentPolicyError';
    }
}
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
            return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'transaction-known', transactionHash: settlement.transactionHash };
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
const CANONICAL_ASSETS = {
    'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    'eip155:1': '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'eip155:4217': '0x20c0000000000000000000000000000000000000',
    'solana:mainnet': 'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwyt1vt',
};
function isCanonicalRequirement(requirements) {
    const expected = CANONICAL_ASSETS[requirements.network];
    return expected !== undefined && requirements.asset.toLowerCase() === expected;
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
    if (!context.settleResponse.success)
        return { kind: 'no-receipt', reason: 'payment-failed' };
    if (!context.settleResponse.transaction)
        return { kind: 'no-receipt', reason: 'settlement-response-missing' };
    return { kind: 'transaction-known', transactionHash: context.settleResponse.transaction };
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
    const ocd = createCommerceClient({ endpoint: baseUrl, recovery: store });
    const flows = new WeakMap();
    const emit = (flow, result) => {
        if (flow.terminalEmitted)
            return;
        flow.terminalEmitted = true;
        // Delivery is observational for the caller. It must not turn a settled
        // merchant request into a rejection because their callback failed.
        Promise.resolve(options.onReceipt(result)).catch(() => { });
    };
    const observeFallback = async (flow, context) => {
        const settlement = settlementTransaction(context);
        if (settlement.kind !== 'transaction-known') {
            emit(flow, { kind: 'no-receipt', reason: settlement.reason });
            return;
        }
        try {
            const res = await ocd.apiFetch('/observe-payment', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // Do not add caller assertions here: selected x402 requirement data is
                // not an independently established payment fact.
                body: JSON.stringify({ network: context.requirements.network, transaction_hash: settlement.transactionHash }),
            });
            if (!res.ok) {
                emit(flow, { kind: 'no-receipt', reason: 'observation-only-failed' });
                return;
            }
            emit(flow, { kind: 'post-payment-evidence', receipt: (await res.json()) });
        }
        catch {
            emit(flow, { kind: 'no-receipt', reason: 'observation-only-failed' });
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
        if (!isCanonicalRequirement(requirements)) {
            const flow = { kind: 'fallback', terminalEmitted: false };
            flows.set(requirements, flow);
            emit(flow, { kind: 'no-receipt', reason: 'unsupported-canonical-asset' });
            return { abort: true, reason: 'OCD policy enforcement aborted payment creation: selected x402 asset/network is outside OCD independent-observation scope' };
        }
        let operation;
        try {
            operation = await ocd.open({
                action: {
                    kind: 'PAYMENT',
                    resource: context.paymentRequired.resource.url,
                    network: requirements.network,
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
            // This is deliberately awaited only for the fallback: there is no
            // existing lifecycle operation to advance and no merchant Response is
            // mutated. The regular finalization branch below stays detached.
            await observeFallback(flow, context);
            return;
        }
        // A transport/adapter may defensively surface the same result twice. It
        // must not initiate a second finalize call for one selected requirement.
        if (flow.paymentResponseHandled)
            return;
        flow.paymentResponseHandled = true;
        const settlement = settlementTransaction(context);
        flow.executor.resolveSettlement(settlement);
        if (settlement.kind !== 'transaction-known') {
            emit(flow, { kind: 'no-receipt', reason: settlement.reason, operationId: flow.operation.operationId });
            return;
        }
        // Do not hold the merchant HTTP response open for independently observed
        // chain finality. The recovery store holds the operation for later retry.
        void flow.execution
            .then(async (execution) => {
            if (!execution || typeof execution !== 'object' || execution.kind !== 'execution-recorded')
                return;
            const finalized = await flow.operation.observeAndFinalize();
            if (finalized.kind === 'receipt-produced')
                emit(flow, { kind: 'full-lifecycle', receipt: finalized.receipt, operationId: flow.operation.operationId });
        })
            .catch(() => {
            // The durable operation remains in the supplied recovery store. Do
            // not turn a late lifecycle failure into false post-payment evidence.
        });
    });
    return client;
}
