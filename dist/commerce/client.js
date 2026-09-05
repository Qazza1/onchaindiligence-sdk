import { VersionConflictError } from './recoveryStore.js';
import { pending } from './results.js';
import { buildEvidenceExport } from './evidenceExport.js';
const DEFAULT_ENDPOINT = 'https://mcp.onchaindiligence.com';
const OPERATION_HEADER = 'x-ocd-operation-id';
const RECOVERY_HEADER = 'x-ocd-recovery-credential';
export class RecoveryRequiredError extends Error {
    constructor(operationId) {
        super(`no local recovery record for operation ${operationId} -- call client.resume(operationId, recoveryCredential) with the credential you saved when this operation was opened. Never silently start a replacement purchase.`);
        this.name = 'RecoveryRequiredError';
    }
}
function mapExecutorIdToProvider(executorId) {
    if (executorId === 'x402-base-usdc-exact')
        return 'x402';
    return 'other';
}
export class OnchainDiligenceCommerceClient {
    endpoint;
    recovery;
    fetchImpl;
    trust;
    constructor(options) {
        this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
        this.recovery = options.recovery;
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        this.trust = options.trust ?? {};
    }
    /** @internal */
    async apiFetch(path, init = {}) {
        return this.fetchImpl(`${this.endpoint}${path}`, init);
    }
    /** @internal */
    async readError(res) {
        try {
            const body = (await res.json());
            return body.error || `HTTP ${res.status}`;
        }
        catch {
            return `HTTP ${res.status}`;
        }
    }
    /** @internal */
    recoveryStore() {
        return this.recovery;
    }
    /** @internal */
    trustOptions() {
        return this.trust;
    }
    /** Opens a new operation, or resumes one already known locally by operationId. Never silently creates a second operation for an id that exists locally with different intent. */
    async open(params) {
        if (params.operationId) {
            const existing = await this.recovery.load(params.operationId);
            if (existing) {
                const op = new CommerceOperation(this, existing);
                op.setPendingPreflightInput(params.action, params.policy, params.publication);
                return op;
            }
            throw new RecoveryRequiredError(params.operationId);
        }
        const res = await this.apiFetch('/operations', { method: 'POST' });
        if (!res.ok)
            throw new Error(`failed to create operation: ${await this.readError(res)}`);
        const created = (await res.json());
        // Persist BEFORE returning: the (operation_id, recovery_credential) pair
        // is otherwise unrecoverable if the process dies right after this call
        // -- the server has no way to hand the credential back without it.
        const record = await this.recovery.create({
            operationId: created.operation_id,
            recoveryCredential: created.recovery_credential,
            preflightReceiptId: null,
            finalizationCapability: null,
            finalizationCapabilityExpiresAt: null,
            executionRequestId: null,
            clientSubmissionKey: null,
            transactionHash: null,
            executorId: null,
            localPhase: 'opened',
        });
        const op = new CommerceOperation(this, record);
        op.setPendingPreflightInput(params.action, params.policy, params.publication);
        return op;
    }
    /** Explicit resume after restart/lost-response, per D2.5 Section 6. Returns recovery-failed rather than throwing, since "the credential turned out to be wrong" is an expected, handleable outcome, not a programming error. */
    async resume(operationId, recoveryCredential) {
        const res = await this.apiFetch(`/operations/${encodeURIComponent(operationId)}`, {
            headers: { [RECOVERY_HEADER]: recoveryCredential },
        });
        if (!res.ok) {
            return { kind: 'recovery-failed', reason: res.status === 401 ? 'unknown operation or invalid recovery credential' : await this.readError(res) };
        }
        const status = (await res.json());
        const existing = await this.recovery.load(operationId);
        if (!existing) {
            await this.recovery.create({
                operationId,
                recoveryCredential,
                preflightReceiptId: status.preflight_receipt_id,
                finalizationCapability: null,
                finalizationCapabilityExpiresAt: null,
                executionRequestId: null,
                clientSubmissionKey: null,
                transactionHash: null,
                executorId: null,
                localPhase: 'resumed',
            });
        }
        return { kind: 'resumed', operationId, status };
    }
    /** Returns a CommerceOperation for an operation already known to the recovery store, without any network call. Use after resume() or across a process restart. */
    async load(operationId) {
        const record = await this.recovery.load(operationId);
        return record ? new CommerceOperation(this, record) : null;
    }
    /** D2.5 Section 7: free, structured, reuses the server's converged verifier -- no local re-implementation. */
    async verifyReceipt(receiptIdOrEnvelope) {
        const res = await this.apiFetch('/verify-receipt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(typeof receiptIdOrEnvelope === 'string' ? { receipt_id: receiptIdOrEnvelope } : { envelope: receiptIdOrEnvelope }),
        });
        if (!res.ok)
            throw new Error(`verify-receipt failed: ${await this.readError(res)}`);
        return (await res.json());
    }
    /** D2.5 Section 7: free, structured lookup by exact receipt id. */
    async getReceipt(receiptId) {
        const res = await this.apiFetch(`/receipts/${encodeURIComponent(receiptId)}`);
        if (res.status === 404)
            return null;
        if (!res.ok)
            throw new Error(`get-receipt failed: ${await this.readError(res)}`);
        return (await res.json());
    }
}
export function createCommerceClient(options) {
    return new OnchainDiligenceCommerceClient(options);
}
export class CommerceOperation {
    operationId;
    client;
    record;
    pendingPreflightInput = null;
    lastCommerceReceiptId = null;
    lastLifecycleEvidence = null;
    /** Serializes execute() calls against THIS operation instance -- see execute()'s header comment for why. */
    executeQueue = Promise.resolve();
    constructor(client, record) {
        this.client = client;
        this.record = record;
        this.operationId = record.operationId;
    }
    /** @internal */
    setPendingPreflightInput(action, policy, publication) {
        this.pendingPreflightInput = { action, policy, publication };
    }
    /** @internal -- exposed for evidence export and tests. */
    currentRecord() {
        return this.record;
    }
    async reload() {
        const fresh = await this.client.recoveryStore().load(this.operationId);
        if (fresh)
            this.record = fresh;
    }
    async casUpdate(patch) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                this.record = await this.client.recoveryStore().update(this.operationId, patch, this.record.version);
                return;
            }
            catch (err) {
                if (err instanceof VersionConflictError && attempt < 2) {
                    await this.reload();
                    continue;
                }
                throw err;
            }
        }
    }
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
    async claimSubmissionSlot(executorId) {
        if (this.record.clientSubmissionKey)
            return this.record.clientSubmissionKey;
        const candidate = `${this.operationId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        for (let attempt = 0; attempt < 5; attempt++) {
            if (this.record.clientSubmissionKey)
                return this.record.clientSubmissionKey;
            try {
                this.record = await this.client
                    .recoveryStore()
                    .update(this.operationId, { clientSubmissionKey: candidate, executorId, localPhase: 'execution-preparing' }, this.record.version);
                return candidate;
            }
            catch (err) {
                if (err instanceof VersionConflictError) {
                    await this.reload();
                    continue;
                }
                throw err;
            }
        }
        throw new Error(`could not claim a submission slot for operation ${this.operationId} after repeated concurrent conflicts`);
    }
    async status() {
        const res = await this.client.apiFetch(`/operations/${encodeURIComponent(this.operationId)}`, {
            headers: { [RECOVERY_HEADER]: this.record.recoveryCredential },
        });
        if (!res.ok)
            throw new Error(`failed to fetch operation status: ${await this.client.readError(res)}`);
        return (await res.json());
    }
    // --- preflight -----------------------------------------------------------
    async preflight() {
        if (!this.pendingPreflightInput) {
            // Resumed from a restart with no in-memory action/policy -- if the
            // preflight step already completed server-side, its receipt id is on
            // the record and there is nothing left to evaluate.
            if (this.record.preflightReceiptId) {
                const receipt = await this.client.getReceipt(this.record.preflightReceiptId);
                if (receipt)
                    return this.evaluationFromReceipt(receipt, null);
            }
            throw new Error('no pending preflight input for this operation -- after a restart, call client.open({operationId, action, policy}) to re-supply it before calling preflight() again');
        }
        const { action, policy, publication } = this.pendingPreflightInput;
        const body = JSON.stringify({ action, policy, options: {}, references: {}, publication: publication ?? {} });
        let res;
        try {
            res = await this.client.apiFetch('/x402/lifecycle/preflight-payment', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    [OPERATION_HEADER]: this.operationId,
                    [RECOVERY_HEADER]: this.record.recoveryCredential,
                },
                body,
            });
        }
        catch {
            // No response at all -- per D2.4, retrying this EXACT call is safe
            // (same operation + same input digest never pays twice), so the safe
            // next action is genuinely "retry", not just "wait".
            return pending(this.operationId, {
                phase: 'preflight-in-progress',
                safeNextAction: 'retry op.preflight() with the identical action/policy -- the server deduplicates by operation and input, so this cannot pay twice',
                mayAlreadyHavePaid: true,
            });
        }
        if (res.status === 425 || res.status === 503) {
            const retryAfter = Number(res.headers.get('retry-after')) || undefined;
            return pending(this.operationId, {
                phase: 'preflight-in-progress',
                safeNextAction: 'retry op.preflight() shortly -- do not attempt payment through any other path',
                retryAfterSeconds: retryAfter,
                mayAlreadyHavePaid: true,
            });
        }
        if (!res.ok) {
            return { kind: 'terminal-error', operationId: this.operationId, error: await this.client.readError(res) };
        }
        const result = (await res.json());
        await this.casUpdate({
            preflightReceiptId: result.receipt.receipt.receipt_id,
            finalizationCapability: result.finalization.capability,
            finalizationCapabilityExpiresAt: result.finalization.expires_at,
            localPhase: 'preflight-complete',
        });
        return this.evaluationFromReceipt(result.receipt, { token: result.finalization.capability, expiresAt: result.finalization.expires_at });
    }
    async evaluationFromReceipt(receipt, capability) {
        if (this.client.trustOptions().verifyReceipts) {
            await this.client.verifyReceipt(receipt).catch(() => { }); // best-effort -- never blocks surfacing the decision itself
        }
        const status = receipt.receipt.decision.status;
        if (status === 'BLOCK')
            return { kind: 'blocked', operationId: this.operationId, receipt, reasons: receipt.receipt.decision.reasons };
        if (status === 'REQUIRE_APPROVAL' || status === 'UNKNOWN') {
            return { kind: 'approval-required', operationId: this.operationId, receipt, reasons: receipt.receipt.decision.reasons };
        }
        if (!capability) {
            // ALLOW, but this evaluation came from a re-fetched historical
            // receipt (post-restart) with no live capability to hand back --
            // report approval-required rather than a false 'ready'.
            return {
                kind: 'approval-required',
                operationId: this.operationId,
                receipt,
                reasons: ['this decision was ALLOW, but no live finalization capability is available in this process -- re-run preflight to obtain one'],
            };
        }
        return { kind: 'ready', operationId: this.operationId, receipt, capabilityExpiresAt: capability.expiresAt };
    }
    // --- execute ---------------------------------------------------------------
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
    async execute(params) {
        const run = this.executeQueue.then(() => this.executeLocked(params), () => this.executeLocked(params));
        this.executeQueue = run.catch(() => { });
        return run;
    }
    async executeLocked(params) {
        if (!this.record.preflightReceiptId) {
            throw new Error('cannot execute before a READY preflight -- call op.preflight() first and confirm evaluation.kind === "ready"');
        }
        if (!this.pendingPreflightInput) {
            throw new Error('execute() needs the original action -- re-supply it via client.open({operationId, action, policy}) after a restart before calling execute()');
        }
        const { action } = this.pendingPreflightInput;
        const { executor } = params;
        // Re-read the durable record before deciding anything -- a DIFFERENT
        // CommerceOperation instance (another process, or another instance in
        // this one sharing the same durable store) may have already claimed or
        // advanced this operation since we last loaded it.
        await this.reload();
        // Resuming an in-flight submission: never re-prepare/re-submit.
        if (this.record.clientSubmissionKey && this.record.executionRequestId) {
            if (this.record.transactionHash) {
                return { kind: 'execution-recorded', operationId: this.operationId, executionRequestId: this.record.executionRequestId, transactionHash: this.record.transactionHash };
            }
            const prepared = { clientSubmissionKey: this.record.clientSubmissionKey, reference: { action }, preparedAt: this.record.updatedAt };
            const resumed = await executor.resume(prepared);
            return this.applyExecutionOutcome(resumed);
        }
        // Persist the identity seed BEFORE calling prepare() -- Section 3: "MUST
        // NOT broadcast payment" during prepare(), but the durable identity must
        // exist before ANY executor call, prepare included. claimSubmissionSlot
        // never lets a concurrent claimant's key be overwritten by ours -- see
        // its own comment.
        const clientSubmissionKey = await this.claimSubmissionSlot(executor.id);
        // The winning slot (ours or a concurrent claimant's) may have already
        // advanced further than "just claimed" by the time we get here.
        if (this.record.executionRequestId) {
            if (this.record.transactionHash) {
                return { kind: 'execution-recorded', operationId: this.operationId, executionRequestId: this.record.executionRequestId, transactionHash: this.record.transactionHash };
            }
            const prepared = { clientSubmissionKey, reference: { action }, preparedAt: this.record.updatedAt };
            const resumed = await executor.resume(prepared);
            return this.applyExecutionOutcome(resumed);
        }
        const prepared = await executor.prepare({ clientSubmissionKey, action });
        const bindingRes = await this.client.apiFetch(`/operations/${encodeURIComponent(this.operationId)}/execution-bindings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [RECOVERY_HEADER]: this.record.recoveryCredential },
            body: JSON.stringify({
                client_submission_key: clientSubmissionKey,
                executor_identity: executor.id,
                executor_version: executor.version,
                recovery_capability_class: executor.recoveryMode,
                expected_payer: null,
            }),
        });
        if (!bindingRes.ok) {
            return { kind: 'terminal-error', operationId: this.operationId, error: `failed to register execution binding: ${await this.client.readError(bindingRes)}` };
        }
        const binding = (await bindingRes.json());
        await this.casUpdate({ executionRequestId: binding.execution_request_id, localPhase: 'execution-submitting' });
        const outcome = await executor.submit(prepared);
        return this.applyExecutionOutcome(outcome);
    }
    async applyExecutionOutcome(outcome) {
        const executionRequestId = this.record.executionRequestId;
        if (outcome.status === 'transaction-known') {
            await this.casUpdate({ transactionHash: outcome.transactionHash, localPhase: 'execution-complete' });
            await this.updateBindingState(executionRequestId, 'transaction_known');
            return { kind: 'execution-recorded', operationId: this.operationId, executionRequestId, transactionHash: outcome.transactionHash, providerReference: outcome.providerReference };
        }
        if (outcome.status === 'manual-recovery-required') {
            await this.casUpdate({ localPhase: 'manual-recovery-required' });
            await this.updateBindingState(executionRequestId, 'manual_recovery_required');
            return { kind: 'manual-recovery-required', operationId: this.operationId, executionRequestId, reason: outcome.reason };
        }
        // submission-ambiguous
        await this.casUpdate({ localPhase: 'execution-ambiguous' });
        await this.updateBindingState(executionRequestId, 'submission_ambiguous');
        return pending(this.operationId, {
            phase: 'execution-ambiguous',
            safeNextAction: 'call op.execute() again -- it will call executor.resume(), never submit() a second time, for this execution',
            retryAfterSeconds: outcome.retryAfterSeconds,
            mayAlreadyHavePaid: true,
            executionRequestId,
        });
    }
    async updateBindingState(executionRequestId, state) {
        await this.client
            .apiFetch(`/operations/${encodeURIComponent(this.operationId)}/execution-bindings/${encodeURIComponent(executionRequestId)}/state`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [RECOVERY_HEADER]: this.record.recoveryCredential },
            body: JSON.stringify({ state }),
        })
            .catch(() => { }); // best-effort mirror; the LOCAL record + the binding's OWN prior state remain authoritative for resume logic
    }
    // --- observe / finalize ------------------------------------------------
    async observeAndFinalize() {
        if (!this.record.transactionHash) {
            return pending(this.operationId, {
                phase: 'awaiting-execution',
                safeNextAction: 'call op.execute() first and reach execution-recorded before finalizing',
                mayAlreadyHavePaid: false,
            });
        }
        if (!this.record.finalizationCapability) {
            throw new Error('no finalization capability on record -- this operation did not complete preflight in this recovery store');
        }
        const res = await this.client.apiFetch(`/operations/${encodeURIComponent(this.operationId)}/finalize`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.record.finalizationCapability}` },
            body: JSON.stringify({
                transaction_hash: this.record.transactionHash,
                execution_provider: mapExecutorIdToProvider(this.record.executorId),
                execution_request_id: this.record.executionRequestId,
            }),
        });
        if (res.status === 425 || res.status === 503) {
            const retryAfter = Number(res.headers.get('retry-after')) || undefined;
            return pending(this.operationId, {
                phase: 'observation-pending',
                safeNextAction: 'retry op.observeAndFinalize() shortly -- the transaction was submitted but is not yet definitively observed',
                retryAfterSeconds: retryAfter,
                mayAlreadyHavePaid: true,
                executionRequestId: this.record.executionRequestId ?? undefined,
            });
        }
        if (!res.ok) {
            return { kind: 'terminal-error', operationId: this.operationId, error: await this.client.readError(res) };
        }
        const body = (await res.json());
        await this.casUpdate({ localPhase: 'finalized' });
        if (this.client.trustOptions().verifyReceipts) {
            await this.client.verifyReceipt(body).catch(() => { });
        }
        this.lastCommerceReceiptId = body.receipt.receipt_id;
        this.lastLifecycleEvidence = body.ocd_lifecycle_evidence;
        return { kind: 'receipt-produced', operationId: this.operationId, receipt: body, evidence: body.ocd_lifecycle_evidence };
    }
    // --- evidence export (D2.5 Section 10) ----------------------------------
    /**
     * Builds a minimal, deterministic evidence manifest from PUBLIC artifacts
     * only (fetched fresh via the client's public receipt/status calls) —
     * never touches this.record's secret fields (recoveryCredential,
     * finalizationCapability), so there is no field here to forget to redact.
     */
    async exportEvidence() {
        const [preflightReceipt, commerceReceipt, status] = await Promise.all([
            this.record.preflightReceiptId ? this.client.getReceipt(this.record.preflightReceiptId) : Promise.resolve(null),
            this.lastCommerceReceiptId ? this.client.getReceipt(this.lastCommerceReceiptId) : Promise.resolve(null),
            this.status().catch(() => null),
        ]);
        return buildEvidenceExport({
            operationId: this.operationId,
            preflightReceipt,
            commerceReceipt,
            operationStatus: status,
            lifecycleEvidence: this.lastLifecycleEvidence,
        });
    }
}
