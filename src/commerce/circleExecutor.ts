/**
 * circleExecutor.ts — the one narrow CircleCommerceExecutor adapter (D3.4C6).
 *
 * PROVES: OCD can sit alongside a Circle Developer-Controlled Wallet
 * exactly the way it already sits alongside Turnkey/Crossmint/CDP/PayBox —
 * Circle independently custodies keys and signs/broadcasts; OCD
 * independently evaluates policy beforehand and independently observes
 * Base settlement afterward. This file never sees a Circle wallet's
 * signing material, only the narrow `CircleClient` interface below.
 *
 * PRODUCT SURFACE, CONFIRMED (not assumed): current official Circle
 * documentation shows NO distinct "Agent Wallet" product -- agent/
 * programmatic use goes through the same Developer-Controlled Wallets API
 * used for any server-side wallet. This adapter targets exactly that:
 * `POST /v1/w3s/developer/transactions/transfer`.
 *
 * IDENTITY DISCIPLINE: Circle's transaction response carries `id` (its own
 * durable transaction identity, returned immediately) and `txHash` (the
 * eventual on-chain hash, populated once mined) as two clearly distinct,
 * separately-documented fields -- confirmed via Circle's own Create/Get
 * Transaction response schema. `providerExecutionId` is always the
 * transaction `id`, never `txHash`.
 *
 * STATE LIFECYCLE (unusually well-documented among this project's
 * providers): `INITIATED` -> `QUEUED` -> `SENT` -> `CONFIRMED` -> `COMPLETE`,
 * or a terminal `FAILED`/`CANCELLED`/`DENIED`. Circle's own docs explicitly
 * separate `CONFIRMED` ("included in a block, awaiting finality") from
 * `COMPLETE` ("finalized on-chain, irreversible") -- this adapter treats
 * only `COMPLETE` as a success terminal state, matching
 * onchaindiligence-mcp's providerEvidence.ts Circle section exactly.
 *
 * IDEMPOTENCY: Circle documents `idempotencyKey` (a UUID v4) as ensuring
 * "exactly-once execution" -- reusing the same key "will be treated as the
 * same request and the original response will be returned." This is a
 * genuine, explicit crash-recovery guarantee. Since Circle requires the
 * UUID v4 *format* specifically (unlike Turnkey/Crossmint/CDP, which
 * accept an arbitrary string), this adapter deterministically derives a
 * valid UUID v4 from `clientSubmissionKey` (same key in -> same UUID out,
 * every time) rather than requiring the caller to supply one -- see
 * `deriveIdempotencyKey()`. This still keeps the same atomic-claim-before-
 * provider-call discipline as every other executor (never rely on a
 * single provider guarantee alone), but a lost response before Circle's
 * transaction `id` is durably recorded can honestly be described as safe
 * to retry with the same derived key, per Circle's own documented
 * contract -- mirroring CDP's honest error-message treatment.
 *
 * NO CALLER-REPORTED PROVIDER EVIDENCE FROM THIS EXECUTOR: Circle's own
 * v2 webhook notification (verified server-side by OCD,
 * onchaindiligence-mcp's circleWebhookRoute.ts) is signature-authenticated
 * provider evidence and is the primary evidence path here -- mirroring
 * Turnkey's and Crossmint's architecture (not CDP's/PayBox's, which have
 * no webhook and so submit a caller-reported claim themselves).
 *
 * BINDING STRENGTH HONESTY (same discipline as every other adapter here):
 * this file never computes or claims a binding strength -- that remains
 * entirely server-side (onchaindiligence-mcp's commerceLifecycle.ts,
 * unmodified by D3.4C6).
 *
 * RECOVERY MODE: 'stable-payment-identity' -- once Circle's transaction
 * `id` is known, `getTransaction(id)` can be polled indefinitely and
 * deterministically, with no risk of creating a new operation.
 */
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { createHash } from 'node:crypto'
import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js'
import { BASE_NETWORK, BASE_USDC, type MinimalResumeClient } from './x402Executor.js'
import { decimalToAtomic6 } from './x402Challenge.js'

export { BASE_NETWORK as CIRCLE_BASE_NETWORK, BASE_USDC as CIRCLE_BASE_USDC }

// --- Circle's documented public contract (Developer-Controlled Wallets transfer only) ---

export type CircleTransactionState = 'INITIATED' | 'QUEUED' | 'SENT' | 'CONFIRMED' | 'COMPLETE' | 'FAILED' | 'CANCELLED' | 'DENIED'

export interface CircleTransactionResult {
  id: string
  state: CircleTransactionState
  /** Populated once mined; absent for FAILED/CANCELLED/DENIED and for pre-inclusion states. */
  txHash?: string | null
}

export interface CircleTransferInput {
  /** The Circle-managed wallet id to send from. */
  walletId: string
  /** Token identifier (Circle's own tokenId, e.g. for Base USDC), per current Circle docs. */
  tokenId: string
  destinationAddress: string
  /** Human-readable decimal amount, per current Circle docs -- NOT atomic units. */
  amount: string
  /** UUID v4, per Circle's documented format requirement. See deriveIdempotencyKey(). */
  idempotencyKey: string
}

/**
 * The minimal Circle public surface this executor depends on -- narrow
 * enough that a real Circle SDK/HTTP client via a small transport
 * adapter, or a test double, can both satisfy it unmodified (same
 * discipline as this project's other adapters).
 */
export interface CircleClient {
  /** Calls Circle's create-transfer-transaction endpoint. Never called more than once per prepared identity by this adapter. */
  createTransfer(input: CircleTransferInput): Promise<CircleTransactionResult>
  /** Polls the current state of a transaction by its id (Get Transaction). Read-only. */
  getTransaction(id: string): Promise<CircleTransactionResult>
}

/**
 * Deterministically derives a UUID-v4-SHAPED string from an arbitrary
 * input string: same input always produces the same output, satisfying
 * Circle's documented idempotencyKey format requirement without asking
 * the caller to manage UUIDs themselves. This is NOT a random UUID (it
 * has no unpredictability, which idempotency keys don't need) -- it only
 * needs to be format-valid and stable per clientSubmissionKey.
 */
export function deriveIdempotencyKey(clientSubmissionKey: string): string {
  const hash = createHash('sha256').update(clientSubmissionKey).digest('hex')
  const bytes = hash.slice(0, 32).split('')
  bytes[12] = '4' // version 4
  const variantNibble = ((parseInt(bytes[16], 16) & 0x3) | 0x8).toString(16)
  bytes[16] = variantNibble
  const hex = bytes.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// --- the adapter-specific durable request store (same "small adapter-specific helper" exception the other adapters document) ---

export interface CircleRequestRecord {
  clientSubmissionKey: string
  /** null only in the narrow window between "we called createTransfer" and "we recorded its id" -- see submit(). */
  transactionId: string | null
  tokenId: string
  amount: string
  destinationAddress: string
  walletId: string
  /** Set once COMPLETE is observed for this record -- once set, this adapter never re-polls or re-sends. */
  transactionHash: string | null
}

export interface CircleRequestStore {
  get(clientSubmissionKey: string): Promise<CircleRequestRecord | null>
  set(record: CircleRequestRecord): Promise<void>
  /**
   * Atomically claims the attempt slot for `clientSubmissionKey`: if no
   * record exists yet, stores `placeholder` (which MUST have
   * `transactionId: null`) and returns `{ claimed: true, record:
   * placeholder }` -- the caller, and ONLY the caller, may now call
   * `createTransfer()`. If a record already exists, returns `{ claimed:
   * false, record: <the existing record, unmodified> }` and the caller
   * MUST NOT call `createTransfer()` again. A real, multi-process
   * implementation MUST make this genuinely atomic (same discipline as
   * every other adapter's `claim()`).
   */
  claim(clientSubmissionKey: string, placeholder: CircleRequestRecord): Promise<{ claimed: boolean; record: CircleRequestRecord }>
}

/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation. Does not survive a restart. */
export class InMemoryCircleRequestStore implements CircleRequestStore {
  private readonly records = new Map<string, CircleRequestRecord>()
  async get(clientSubmissionKey: string): Promise<CircleRequestRecord | null> {
    return this.records.get(clientSubmissionKey) ?? null
  }
  async set(record: CircleRequestRecord): Promise<void> {
    this.records.set(record.clientSubmissionKey, { ...record })
  }
  async claim(clientSubmissionKey: string, placeholder: CircleRequestRecord): Promise<{ claimed: boolean; record: CircleRequestRecord }> {
    const existing = this.records.get(clientSubmissionKey)
    if (existing) return { claimed: false, record: { ...existing } }
    const stored = { ...placeholder }
    this.records.set(clientSubmissionKey, stored)
    return { claimed: true, record: { ...stored } }
  }
}

export class CircleStoreRequiredError extends Error {
  constructor() {
    super(
      "CircleCommerceExecutor requires an explicit, durable `store` (CircleRequestStore) -- InMemoryCircleRequestStore is test/example-only and does not survive a restart, which would silently make this executor's advertised recoveryMode ('stable-payment-identity') false. Pass a durable implementation in production; InMemoryCircleRequestStore only in tests/examples."
    )
    this.name = 'CircleStoreRequiredError'
  }
}

export class CircleAmbiguousSubmitError extends Error {
  constructor(clientSubmissionKey: string, idempotencyKey: string) {
    super(
      `a prior submit() for clientSubmissionKey "${clientSubmissionKey}" called Circle's createTransfer() but this process never learned the resulting transaction id -- check Circle directly (dashboard or Get Transaction) for an orphaned transfer tied to this payment before retrying. Circle's own documentation states that retrying with the SAME idempotencyKey ("${idempotencyKey}") returns the original response rather than creating a duplicate transaction -- a manual retry using that exact key is expected to be safe per Circle's documented contract, even though this code does not attempt it automatically.`
    )
    this.name = 'CircleAmbiguousSubmitError'
  }
}

export interface CircleExecutorOptions {
  /** The Circle client used to call createTransfer()/getTransaction(). Never logged, never persisted by this class. */
  circle: CircleClient
  /** Circle's own wallet id sending funds -- distinct from the onchain address, per Circle's own wallet model. */
  walletId: string
  /** Circle's own tokenId for the asset being sent (e.g. Base USDC's Circle-assigned token identifier). */
  tokenId: string
  /** Durable store for this adapter's own transaction record -- REQUIRED, no default (same discipline as every other adapter's `store` option). */
  store: CircleRequestStore
  /** Base RPC used ONLY for read-only resume re-confirmation of an already-known transaction hash. Defaults to the public Base RPC. */
  rpcUrl?: string
  /** Test seam: inject a fake read-only client instead of connecting to rpcUrl. */
  publicClient?: MinimalResumeClient
}

interface CirclePreparedReference {
  amount: string
  destinationAddress: string
}

export class CircleCommerceExecutor implements CommerceExecutor {
  readonly id = 'circle-base-usdc'
  readonly version = 'v2'
  readonly recoveryMode: ExecutorRecoveryMode = 'stable-payment-identity'

  private readonly circle: CircleClient
  private readonly walletId: string
  private readonly tokenId: string
  private readonly store: CircleRequestStore
  private readonly rpcUrl: string
  private readonly injectedPublicClient?: MinimalResumeClient

  constructor(options: CircleExecutorOptions) {
    if (!options.store) throw new CircleStoreRequiredError()
    this.circle = options.circle
    this.walletId = options.walletId
    this.tokenId = options.tokenId
    this.store = options.store
    this.rpcUrl = options.rpcUrl ?? 'https://mainnet.base.org'
    this.injectedPublicClient = options.publicClient
  }

  /** Read-only: validates the frozen action against this executor's Base/USDC scope. No Circle call. */
  async prepare(context: PrepareContext): Promise<PrepareResult> {
    if (context.action.network !== BASE_NETWORK) throw new Error(`this executor only supports ${BASE_NETWORK}, got "${context.action.network}"`)
    if (context.action.asset.toLowerCase() !== BASE_USDC.toLowerCase()) {
      throw new Error(`this executor only supports USDC (${BASE_USDC}), got "${context.action.asset}"`)
    }
    // decimalToAtomic6 both validates the amount shape and confirms it
    // fits USDC's 6 decimals -- Circle's own transfer amount is decimal,
    // like the frozen action, so no conversion is needed here; this call
    // exists purely to reuse the existing validation.
    decimalToAtomic6(context.action.amount)
    const reference: CirclePreparedReference = { amount: context.action.amount, destinationAddress: context.action.recipient }
    return { clientSubmissionKey: context.clientSubmissionKey, reference, preparedAt: new Date().toISOString(), providerReference: null }
  }

  async submit(prepared: PrepareResult): Promise<ExecutionResult> {
    const ref = prepared.reference as CirclePreparedReference
    const clientSubmissionKey = prepared.clientSubmissionKey
    const idempotencyKey = deriveIdempotencyKey(clientSubmissionKey)

    const existing = await this.store.get(clientSubmissionKey)
    if (existing?.transactionId) return this.resolve(clientSubmissionKey, existing.transactionId, idempotencyKey)
    if (existing) throw new CircleAmbiguousSubmitError(clientSubmissionKey, idempotencyKey)

    const placeholder: CircleRequestRecord = { clientSubmissionKey, transactionId: null, tokenId: this.tokenId, amount: ref.amount, destinationAddress: ref.destinationAddress, walletId: this.walletId, transactionHash: null }
    const { claimed, record: claimedRecord } = await this.store.claim(clientSubmissionKey, placeholder)
    if (!claimed) {
      if (claimedRecord.transactionId) return this.resolve(clientSubmissionKey, claimedRecord.transactionId, idempotencyKey)
      throw new CircleAmbiguousSubmitError(clientSubmissionKey, idempotencyKey)
    }

    // We won the claim -- exactly this call may proceed to Circle. This IS
    // Circle's own independent custody/policy check (the wallet's signing
    // authority and any Circle-side policy engine rules are entirely
    // Circle's, not OCD's).
    const result = await this.circle.createTransfer({ walletId: this.walletId, tokenId: this.tokenId, destinationAddress: ref.destinationAddress, amount: ref.amount, idempotencyKey })

    // Persist the transaction identity FIRST, before anything else -- this
    // is the durable identity resume()/future submit() calls key off of.
    const record: CircleRequestRecord = { ...claimedRecord, transactionId: result.id }
    await this.store.set(record)

    return this.resolveFromResult(clientSubmissionKey, result.id, result)
  }

  /**
   * Shared by submit() (first check, right after the send) and resume()
   * (every later check) -- ONE getTransaction() poll, then an honest
   * mapping of Circle's current state. Neither caller loops internally; a
   * still-pending transaction returns submission-ambiguous with a retry
   * hint, and the orchestrator's own retry pattern (calling resume(),
   * never submit(), for an already-claimed identity) drives the next poll.
   */
  private async resolve(clientSubmissionKey: string, transactionId: string, idempotencyKey: string): Promise<ExecutionResult> {
    const record = await this.store.get(clientSubmissionKey)
    if (record?.transactionHash) {
      // Already resolved in a prior call -- never re-poll or re-send.
      return { clientSubmissionKey, status: 'transaction-known', transactionHash: record.transactionHash, providerReference: `circle:${transactionId}` }
    }
    let result: CircleTransactionResult
    try {
      result = await this.circle.getTransaction(transactionId)
    } catch (err: any) {
      // getTransaction is a read-only status check -- a failure here is
      // ambiguous about Circle's OWN reachability, never about whether the
      // transaction itself changed state. Safe to just try again later.
      return { clientSubmissionKey, status: 'submission-ambiguous', reason: `could not reach Circle to check transaction ${transactionId}: ${err?.message || 'no response'}`, retryAfterSeconds: 5, providerReference: `circle:${transactionId}` }
    }
    return this.resolveFromResult(clientSubmissionKey, transactionId, result)
  }

  private async resolveFromResult(clientSubmissionKey: string, transactionId: string, result: CircleTransactionResult): Promise<ExecutionResult> {
    const providerReference = `circle:${transactionId}`

    if (result.state === 'INITIATED' || result.state === 'QUEUED' || result.state === 'SENT') {
      return { clientSubmissionKey, status: 'submission-ambiguous', reason: `Circle transaction ${transactionId} is ${result.state} -- poll again, do not resubmit`, retryAfterSeconds: 5, providerReference }
    }
    if (result.state === 'CONFIRMED') {
      // Per Circle's own docs: included in a block, awaiting finality --
      // NOT yet the terminal COMPLETE state. A transaction hash may exist
      // here, but this adapter reports transaction-known only once Circle
      // itself calls this transaction finalized, mirroring the terminal
      // discipline onchaindiligence-mcp's providerEvidence.ts applies.
      return { clientSubmissionKey, status: 'submission-ambiguous', reason: `Circle transaction ${transactionId} is CONFIRMED (included, awaiting finality per Circle's own docs) -- not yet COMPLETE`, retryAfterSeconds: 5, providerReference }
    }
    if (result.state === 'FAILED' || result.state === 'CANCELLED' || result.state === 'DENIED') {
      // Terminal and definitive: no successful transfer occurred.
      return {
        clientSubmissionKey,
        status: 'manual-recovery-required',
        reason: `Circle reported ${result.state} for transaction ${transactionId} -- no successful transfer occurred; this will not resolve differently on retry`,
        providerReference,
      }
    }

    // state === 'COMPLETE': a transaction hash is expected.
    if (!result.txHash) {
      return {
        clientSubmissionKey,
        status: 'manual-recovery-required',
        reason: `Circle reported COMPLETE for transaction ${transactionId} but no txHash was present -- check Circle directly before retrying`,
        providerReference,
      }
    }
    const record = await this.store.get(clientSubmissionKey)
    if (record) await this.store.set({ ...record, transactionHash: result.txHash })
    return { clientSubmissionKey, status: 'transaction-known', transactionHash: result.txHash, providerReference }
  }

  async resume(prepared: PrepareResult, priorOutcome?: ExecutionResult): Promise<ExecutionResult> {
    // Mirrors every other adapter's own resume(): if a transaction hash is
    // ALREADY known from a prior call, independently re-confirm it
    // read-only on-chain -- never guess a new one, never re-send.
    if (priorOutcome?.status === 'transaction-known') {
      const client = this.injectedPublicClient ?? createPublicClient({ chain: base, transport: http(this.rpcUrl) })
      try {
        await client.getTransactionReceipt({ hash: priorOutcome.transactionHash as `0x${string}` })
        return priorOutcome
      } catch {
        return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'submission-ambiguous', reason: 'previously reported transaction hash was not found on Base mainnet (may still be propagating)' }
      }
    }

    // The orchestrator reconstructs a GENERIC `prepared.reference = { action }`
    // on resume (see payboxExecutor.ts's header for why) -- this adapter's
    // own record can only be found via its durable store, keyed by
    // clientSubmissionKey.
    const record = await this.store.get(prepared.clientSubmissionKey)
    if (!record || !record.transactionId) {
      return {
        clientSubmissionKey: prepared.clientSubmissionKey,
        status: 'manual-recovery-required',
        reason: 'no Circle transaction is on record for this submission attempt -- check Circle directly (dashboard or Get Transaction) before retrying',
      }
    }
    return this.resolve(prepared.clientSubmissionKey, record.transactionId, deriveIdempotencyKey(prepared.clientSubmissionKey))
  }
}
