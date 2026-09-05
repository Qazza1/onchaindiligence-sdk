/**
 * nodeFileRecoveryStore.ts — a real, restart-surviving CommerceRecoveryStore
 * for Node (single-process apps, the operator UI, examples, tests).
 *
 * Storage: one JSON file per operation under `directory`, named
 * `<operationId>.json`. Writes are atomic (write to a temp file, then
 * rename) so a crash mid-write can never leave a half-written, corrupt
 * record — the rename either lands or it doesn't.
 *
 * Concurrency: compare-and-swap is enforced at the application level (the
 * version field is checked before every write) and writes within one
 * process are serialized per-operation by an in-memory lock queue, so two
 * concurrent calls in the SAME process can't race past each other between
 * the read and the write. This is NOT a multi-process/multi-machine lock —
 * if your deployment runs more than one instance against the same
 * directory, implement CommerceRecoveryStore against a real database with
 * native CAS (e.g. a WHERE version = $n UPDATE) instead.
 *
 * Secrets (recoveryCredential, finalizationCapability) are stored in this
 * file in plaintext. This is appropriate for local, single-user, file-
 * system-permission-protected use (examples, the local operator) — a real
 * multi-user production deployment should encrypt at rest or use a secrets
 * manager, which is exactly why this is one INTERCHANGEABLE implementation
 * of the interface, not the interface itself.
 */
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  type CommerceRecoveryStore,
  type CommerceRecoveryRecord,
  RecoveryRecordExistsError,
  RecoveryRecordNotFoundError,
  VersionConflictError,
} from './recoveryStore.js'

function isValidOperationId(operationId: string): boolean {
  // Matches the shape onchaindiligence-mcp's operation.ts generates
  // (OCD-OP- + base64url); rejected characters could otherwise be used to
  // escape `directory` via a crafted operationId.
  return /^[A-Za-z0-9_-]{1,128}$/.test(operationId)
}

export class NodeFileRecoveryStore implements CommerceRecoveryStore {
  private readonly directory: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(directory: string) {
    this.directory = directory
  }

  private pathFor(operationId: string): string {
    if (!isValidOperationId(operationId)) throw new TypeError(`invalid operationId for file storage: ${operationId}`)
    return join(this.directory, `${operationId}.json`)
  }

  /** Serializes all reads+writes for this store instance so create/update's read-then-write is never interleaved with another call in the same process. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private async readRaw(operationId: string): Promise<CommerceRecoveryRecord | null> {
    try {
      const text = await readFile(this.pathFor(operationId), 'utf8')
      return JSON.parse(text) as CommerceRecoveryRecord
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null
      throw err
    }
  }

  private async writeRaw(operationId: string, record: CommerceRecoveryRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const finalPath = this.pathFor(operationId)
    const tempPath = join(this.directory, `.${operationId}.${randomBytes(4).toString('hex')}.tmp`)
    await writeFile(tempPath, JSON.stringify(record, null, 2), 'utf8')
    await rename(tempPath, finalPath) // atomic on the same filesystem
  }

  async create(record: Omit<CommerceRecoveryRecord, 'version' | 'createdAt' | 'updatedAt'>): Promise<CommerceRecoveryRecord> {
    return this.locked(async () => {
      const existing = await this.readRaw(record.operationId)
      if (existing) throw new RecoveryRecordExistsError(record.operationId)
      const now = new Date().toISOString()
      const full: CommerceRecoveryRecord = { ...record, version: 1, createdAt: now, updatedAt: now }
      await this.writeRaw(record.operationId, full)
      return full
    })
  }

  async load(operationId: string): Promise<CommerceRecoveryRecord | null> {
    return this.locked(() => this.readRaw(operationId))
  }

  async update(
    operationId: string,
    patch: Partial<Omit<CommerceRecoveryRecord, 'operationId' | 'version'>>,
    expectedVersion: number
  ): Promise<CommerceRecoveryRecord> {
    return this.locked(async () => {
      const existing = await this.readRaw(operationId)
      if (!existing) throw new RecoveryRecordNotFoundError(operationId)
      if (existing.version !== expectedVersion) throw new VersionConflictError(operationId, expectedVersion, existing.version)
      const updated: CommerceRecoveryRecord = { ...existing, ...patch, version: existing.version + 1, updatedAt: new Date().toISOString() }
      await this.writeRaw(operationId, updated)
      return updated
    })
  }

  async findByClientSubmissionKey(clientSubmissionKey: string): Promise<CommerceRecoveryRecord | null> {
    // No index -- a real production store backed by a database should add
    // one. Scoped to Node's readdir, acceptable for the small, local,
    // single-operator-at-a-time use this implementation targets.
    return this.locked(async () => {
      const { readdir } = await import('node:fs/promises')
      let files: string[]
      try {
        files = await readdir(this.directory)
      } catch (err: any) {
        if (err?.code === 'ENOENT') return null
        throw err
      }
      for (const file of files) {
        if (!file.endsWith('.json') || file.startsWith('.')) continue
        const record = await this.readRaw(file.slice(0, -'.json'.length))
        if (record?.clientSubmissionKey === clientSubmissionKey) return record
      }
      return null
    })
  }

  /** Test/example convenience: not part of the interface. */
  async _deleteForTests(operationId: string): Promise<void> {
    await unlink(this.pathFor(operationId)).catch(() => {})
  }
}
