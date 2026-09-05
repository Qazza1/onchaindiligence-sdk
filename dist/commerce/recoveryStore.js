/**
 * recoveryStore.ts — durable recovery abstraction for the commerce client.
 *
 * This is the ONE thing standing between "lost my HTTP response" and "paid
 * twice" or "sent a duplicate merchant payment" on the CLIENT side — the
 * mirror image of what onchaindiligence-mcp's own lifecycle_steps /
 * execution_bindings tables do server-side (D2.4). A developer's application
 * MUST persist a record here BEFORE calling anything that could move money
 * (preflight, executor.prepare, executor.submit) so a crash between "we
 * asked" and "we got an answer" has something durable to resume from.
 *
 * `create`/`update` use explicit optimistic concurrency (a version counter)
 * rather than silent last-write-wins, so two concurrent processes touching
 * the same operation can never silently clobber each other's state — one of
 * them gets a VersionConflictError and must reload and retry.
 *
 * The in-memory implementation exists ONLY for tests and throwaway scripts.
 * It is explicitly NOT advertised as production-safe (it does not survive a
 * process restart, which defeats the entire point of this interface) — see
 * NodeFileRecoveryStore for a real, restart-surviving option, and implement
 * this interface against your own database for a multi-instance deployment.
 */
export class RecoveryRecordExistsError extends Error {
    constructor(operationId) {
        super(`a recovery record for operation ${operationId} already exists`);
        this.name = 'RecoveryRecordExistsError';
    }
}
export class RecoveryRecordNotFoundError extends Error {
    constructor(operationId) {
        super(`no recovery record found for operation ${operationId}`);
        this.name = 'RecoveryRecordNotFoundError';
    }
}
export class VersionConflictError extends Error {
    constructor(operationId, expected, actual) {
        super(`recovery record for ${operationId} was updated concurrently (expected version ${expected}, found ${actual}) -- reload and retry`);
        this.name = 'VersionConflictError';
    }
}
/**
 * Volatile, single-process, TEST/EXAMPLE-ONLY implementation. Does not
 * survive a restart -- using this in production silently defeats every
 * "resume after crash/restart" guarantee this interface exists to provide.
 */
export class InMemoryRecoveryStore {
    records = new Map();
    async create(record) {
        if (this.records.has(record.operationId))
            throw new RecoveryRecordExistsError(record.operationId);
        const now = new Date().toISOString();
        const full = { ...record, version: 1, createdAt: now, updatedAt: now };
        this.records.set(record.operationId, full);
        return { ...full };
    }
    async load(operationId) {
        const found = this.records.get(operationId);
        return found ? { ...found } : null;
    }
    async update(operationId, patch, expectedVersion) {
        const existing = this.records.get(operationId);
        if (!existing)
            throw new RecoveryRecordNotFoundError(operationId);
        if (existing.version !== expectedVersion)
            throw new VersionConflictError(operationId, expectedVersion, existing.version);
        const updated = { ...existing, ...patch, version: existing.version + 1, updatedAt: new Date().toISOString() };
        this.records.set(operationId, updated);
        return { ...updated };
    }
    async findByClientSubmissionKey(clientSubmissionKey) {
        for (const record of this.records.values()) {
            if (record.clientSubmissionKey === clientSubmissionKey)
                return { ...record };
        }
        return null;
    }
}
