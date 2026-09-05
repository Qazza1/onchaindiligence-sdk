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

export interface CommerceRecoveryRecord {
  operationId: string
  /** The OCD-issued recovery credential — required to call GET /operations/:id, POST .../execution-bindings, POST .../finalize. Never log this. */
  recoveryCredential: string
  /** Optimistic-concurrency version. Starts at 1; every update() must supply the version it read and gets back the new one. */
  version: number
  createdAt: string
  updatedAt: string
  preflightReceiptId: string | null
  /** The one-time finalization capability token, when known. Never log this. */
  finalizationCapability: string | null
  finalizationCapabilityExpiresAt: string | null
  executionRequestId: string | null
  /** Caller-chosen idempotency key for the executor's submission attempt — see executor.ts. */
  clientSubmissionKey: string | null
  /** The `id` of the CommerceExecutor used for the current/last execution attempt — used only to label the finalize call's execution_provider field. */
  executorId: string | null
  transactionHash: string | null
  /** Free-form local phase label for the developer's own UI/logging — never trusted as the source of truth (the server's /operations/:id status is). */
  localPhase: string
}

export class RecoveryRecordExistsError extends Error {
  constructor(operationId: string) {
    super(`a recovery record for operation ${operationId} already exists`)
    this.name = 'RecoveryRecordExistsError'
  }
}

export class RecoveryRecordNotFoundError extends Error {
  constructor(operationId: string) {
    super(`no recovery record found for operation ${operationId}`)
    this.name = 'RecoveryRecordNotFoundError'
  }
}

export class VersionConflictError extends Error {
  constructor(operationId: string, expected: number, actual: number) {
    super(`recovery record for ${operationId} was updated concurrently (expected version ${expected}, found ${actual}) -- reload and retry`)
    this.name = 'VersionConflictError'
  }
}

export interface CommerceRecoveryStore {
  /** Atomic create. Throws RecoveryRecordExistsError if the operationId is already present. */
  create(record: Omit<CommerceRecoveryRecord, 'version' | 'createdAt' | 'updatedAt'>): Promise<CommerceRecoveryRecord>
  load(operationId: string): Promise<CommerceRecoveryRecord | null>
  /** Compare-and-swap update: `expectedVersion` must match the currently-stored version, or this throws VersionConflictError without applying the patch. */
  update(operationId: string, patch: Partial<Omit<CommerceRecoveryRecord, 'operationId' | 'version'>>, expectedVersion: number): Promise<CommerceRecoveryRecord>
  /** Convenience lookup used by resume-after-restart flows that only know the executor's own idempotency key, not the operation id. Optional: stores that can't index this may return null always. */
  findByClientSubmissionKey(clientSubmissionKey: string): Promise<CommerceRecoveryRecord | null>
}

/**
 * Volatile, single-process, TEST/EXAMPLE-ONLY implementation. Does not
 * survive a restart -- using this in production silently defeats every
 * "resume after crash/restart" guarantee this interface exists to provide.
 */
export class InMemoryRecoveryStore implements CommerceRecoveryStore {
  private readonly records = new Map<string, CommerceRecoveryRecord>()

  async create(record: Omit<CommerceRecoveryRecord, 'version' | 'createdAt' | 'updatedAt'>): Promise<CommerceRecoveryRecord> {
    if (this.records.has(record.operationId)) throw new RecoveryRecordExistsError(record.operationId)
    const now = new Date().toISOString()
    const full: CommerceRecoveryRecord = { ...record, version: 1, createdAt: now, updatedAt: now }
    this.records.set(record.operationId, full)
    return { ...full }
  }

  async load(operationId: string): Promise<CommerceRecoveryRecord | null> {
    const found = this.records.get(operationId)
    return found ? { ...found } : null
  }

  async update(
    operationId: string,
    patch: Partial<Omit<CommerceRecoveryRecord, 'operationId' | 'version'>>,
    expectedVersion: number
  ): Promise<CommerceRecoveryRecord> {
    const existing = this.records.get(operationId)
    if (!existing) throw new RecoveryRecordNotFoundError(operationId)
    if (existing.version !== expectedVersion) throw new VersionConflictError(operationId, expectedVersion, existing.version)
    const updated: CommerceRecoveryRecord = { ...existing, ...patch, version: existing.version + 1, updatedAt: new Date().toISOString() }
    this.records.set(operationId, updated)
    return { ...updated }
  }

  async findByClientSubmissionKey(clientSubmissionKey: string): Promise<CommerceRecoveryRecord | null> {
    for (const record of this.records.values()) {
      if (record.clientSubmissionKey === clientSubmissionKey) return { ...record }
    }
    return null
  }
}
