/**
 * turnkeyExecutor.ts — the one narrow TurnkeyCommerceExecutor adapter (D3.4C3).
 *
 * PROVES: OCD can sit alongside Turnkey exactly the way it already sits
 * alongside PayBox (D2.6) -- Turnkey independently custodies keys and
 * signs/broadcasts; OCD independently evaluates policy beforehand and
 * independently observes Base settlement afterward. This file never sees a
 * Turnkey private key, API key, or signing credential; it only calls the
 * narrow `TurnkeyClient` interface below.
 *
 * TWO DISTINCT TURNKEY MECHANISMS (confirmed against current official
 * Turnkey docs at D3.4C3-PREP and re-confirmed immediately before this
 * implementation):
 *   - `SIGN_TRANSACTION` (an activity that signs only -- no broadcast, no
 *     transaction hash). NOT used by this adapter: it proves a signature
 *     was produced, never that anything was sent, included, or settled.
 *   - `ethSendTransaction()` (signs AND broadcasts, returns a
 *     `sendTransactionStatusId` tracked via polling or the
 *     `transaction:status` webhook to BROADCASTING -> INCLUDED/FAILED, with
 *     `txHash` present on INCLUDED). This adapter uses ONLY this combined
 *     lifecycle.
 *
 * No current Turnkey documentation states a durable guaranteed linkage
 * between the signing `activityId` and the `sendTransactionStatusId` this
 * adapter tracks, beyond both appearing on the same send response/webhook
 * message -- this adapter does not rely on `activityId` for anything;
 * `sendTransactionStatusId` alone is the durable identity, exactly as
 * `onchaindiligence-mcp`'s `parseTurnkeyWebhookEvidenceInput()` treats it.
 *
 * PROVIDER EVIDENCE SCOPING (deliberate, not an oversight): unlike PayBox
 * (which has no webhook and so must submit a caller-reported provider claim
 * through this adapter's `ExecutionResult.providerEvidence`), Turnkey's
 * `transaction:status` webhook already delivers Ed25519-signature-verified,
 * provider-authenticated evidence directly to OCD server-side
 * (onchaindiligence-mcp's `turnkeyWebhookRoute.ts`) -- which is STRONGER
 * evidence than anything this adapter could submit as a caller-reported
 * claim. This adapter therefore does NOT attach a `providerEvidence`
 * payload to its `ExecutionResult`; a deployment that cannot configure the
 * webhook can add that path later as an additive, explicitly-weaker
 * fallback, but inventing it now, unrequested, would be exactly the kind of
 * ahead-of-need surface this project avoids.
 *
 * BINDING STRENGTH HONESTY (same discipline as payboxExecutor.ts): this
 * file never computes or claims a binding strength -- that remains entirely
 * server-side (onchaindiligence-mcp's commerceLifecycle.ts, unmodified by
 * D3.4C3). A verified Turnkey webhook signature proves Turnkey authored the
 * claim, never that this specific transfer is the one this operation
 * committed to -- that correlation is `provider_reference`-based durable
 * binding matching, entirely server-side.
 *
 * RECOVERY MODE: 'stable-payment-identity', not 'provider-idempotent' and
 * not 'manual' -- chosen by what Turnkey's OWN public contract actually
 * guarantees (Section 5's discipline), the same reasoning payboxExecutor.ts
 * applies to PayBox's request_id:
 *   - NOT 'provider-idempotent': no current Turnkey documentation states
 *     that calling `ethSendTransaction()` twice for the same intent is safe
 *     (i.e. that Turnkey itself deduplicates the SEND call by some
 *     idempotency key on the request side) -- the payload's own
 *     `idempotencyKey` is documented only as an OUTPUT field describing the
 *     provider's own send record, not a documented input-side dedupe
 *     contract this adapter can rely on. Treated conservatively as NOT
 *     idempotent-on-retry, per D3.4C3-PREP's explicit UNKNOWN.
 *   - IS 'stable-payment-identity': once a `sendTransactionStatusId` exists,
 *     it can be polled/resumed against that SAME id indefinitely and
 *     deterministically, with no risk of creating a new operation -- the
 *     identity is the `sendTransactionStatusId` itself, established once in
 *     `submit()` and never re-created.
 *   - The one honest gap, mirroring PayBox's `PayBoxAmbiguousPrepareError`:
 *     if `ethSendTransaction()` is called but the process dies before
 *     learning whether Turnkey ever created a `sendTransactionStatusId`,
 *     there is no stable identity to resume -- see
 *     `TurnkeyAmbiguousSubmitError`, which surfaces this narrow window
 *     explicitly rather than silently retrying (which could send a SECOND
 *     transaction for the same intended payment).
 */
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js'
import { BASE_NETWORK, BASE_USDC, type MinimalResumeClient } from './x402Executor.js'
import { decimalToAtomic6 } from './x402Challenge.js'

export { BASE_NETWORK as TURNKEY_BASE_NETWORK, BASE_USDC as TURNKEY_BASE_USDC }

// --- Turnkey's documented public contract (the combined send/track lifecycle only) ---

export type TurnkeyTransactionStatus = 'BROADCASTING' | 'INCLUDED' | 'FAILED'

export interface TurnkeyTransactionStatusResult {
  status: TurnkeyTransactionStatus
  /** Present only on INCLUDED. */
  txHash?: string | null
  /** Present on FAILED, and on INCLUDED when the transaction reverted onchain (per current Turnkey docs). */
  error?: { message?: string } | null
}

export interface TurnkeySendTransactionInput {
  from: string
  to: string
  value: string
  data?: string
  caip2: string
}

/**
 * The minimal Turnkey public surface this executor depends on -- narrow
 * enough that the real Turnkey SDK's `ethSendTransaction`/
 * `pollTransactionStatus` via a small transport adapter, or a test double,
 * can both satisfy it unmodified (same discipline as x402Executor.ts's
 * `ClientEvmSigner` and payboxExecutor.ts's `PayBoxClient`).
 */
export interface TurnkeyClient {
  /** Signs AND broadcasts in one call (ethSendTransaction). Returns the durable send/track identity. Never called more than once per prepared identity by this adapter. */
  sendTransaction(input: TurnkeySendTransactionInput): Promise<{ sendTransactionStatusId: string }>
  /** Polls the current status of a send by its sendTransactionStatusId (pollTransactionStatus). Read-only. */
  getTransactionStatus(sendTransactionStatusId: string): Promise<TurnkeyTransactionStatusResult>
}

// --- the adapter-specific durable request store (same "small adapter-specific helper" exception payboxExecutor.ts documents) ---

export interface TurnkeyRequestRecord {
  clientSubmissionKey: string
  /** null only in the narrow window between "we called sendTransaction" and "we recorded its sendTransactionStatusId" -- see submit(). */
  sendTransactionStatusId: string | null
  network: string
  asset: string
  atomicAmount: string
  recipient: string
  from: string
  /** Set once INCLUDED is observed for this record -- once set, this adapter never re-polls or re-sends. */
  transactionHash: string | null
}

export interface TurnkeyRequestStore {
  get(clientSubmissionKey: string): Promise<TurnkeyRequestRecord | null>
  set(record: TurnkeyRequestRecord): Promise<void>
  /**
   * Atomically claims the attempt slot for `clientSubmissionKey`: if no
   * record exists yet, stores `placeholder` (which MUST have
   * `sendTransactionStatusId: null`) and returns `{ claimed: true, record:
   * placeholder }` -- the caller, and ONLY the caller, may now call
   * `sendTransaction()`. If a record already exists, returns `{ claimed:
   * false, record: <the existing record, unmodified> }` and the caller MUST
   * NOT call `sendTransaction()` again. A real, multi-process
   * implementation MUST make this genuinely atomic (same discipline as
   * `PayBoxRequestStore.claim()`/`CommerceRecoveryStore.create()`).
   */
  claim(clientSubmissionKey: string, placeholder: TurnkeyRequestRecord): Promise<{ claimed: boolean; record: TurnkeyRequestRecord }>
}

/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation -- same discipline as InMemoryPayBoxRequestStore. Does not survive a restart. */
export class InMemoryTurnkeyRequestStore implements TurnkeyRequestStore {
  private readonly records = new Map<string, TurnkeyRequestRecord>()
  async get(clientSubmissionKey: string): Promise<TurnkeyRequestRecord | null> {
    return this.records.get(clientSubmissionKey) ?? null
  }
  async set(record: TurnkeyRequestRecord): Promise<void> {
    this.records.set(record.clientSubmissionKey, { ...record })
  }
  async claim(clientSubmissionKey: string, placeholder: TurnkeyRequestRecord): Promise<{ claimed: boolean; record: TurnkeyRequestRecord }> {
    // No `await` between the check and the write -- race-free for
    // concurrent callers IN THIS PROCESS only, same as PayBox's in-memory store.
    const existing = this.records.get(clientSubmissionKey)
    if (existing) return { claimed: false, record: { ...existing } }
    const stored = { ...placeholder }
    this.records.set(clientSubmissionKey, stored)
    return { claimed: true, record: { ...stored } }
  }
}

export class TurnkeyStoreRequiredError extends Error {
  constructor() {
    super(
      "TurnkeyCommerceExecutor requires an explicit, durable `store` (TurnkeyRequestStore) -- InMemoryTurnkeyRequestStore is test/example-only and does not survive a restart, which would silently make this executor's advertised recoveryMode ('stable-payment-identity') false. Pass a durable implementation in production; InMemoryTurnkeyRequestStore only in tests/examples."
    )
    this.name = 'TurnkeyStoreRequiredError'
  }
}

export class TurnkeyAmbiguousSubmitError extends Error {
  constructor(clientSubmissionKey: string) {
    super(
      `a prior submit() for clientSubmissionKey "${clientSubmissionKey}" called Turnkey's sendTransaction() but this process never learned whether Turnkey created a sendTransactionStatusId -- no current Turnkey documentation guarantees send-side idempotency, so calling it again here could send a SECOND transaction for the same intended payment. Check Turnkey directly (dashboard or API) for an orphaned send tied to this payment before retrying.`
    )
    this.name = 'TurnkeyAmbiguousSubmitError'
  }
}

export interface TurnkeyExecutorOptions {
  /** The Turnkey client used to call sendTransaction()/getTransactionStatus(). Never logged, never persisted by this class. */
  turnkey: TurnkeyClient
  /** Durable store for this adapter's own send identity -- REQUIRED, no default (same discipline as PayBoxExecutorOptions.store). */
  store: TurnkeyRequestStore
  /** Base RPC used ONLY for read-only resume re-confirmation of an already-known transaction hash. Defaults to the public Base RPC. */
  rpcUrl?: string
  /** Test seam: inject a fake read-only client instead of connecting to rpcUrl. */
  publicClient?: MinimalResumeClient
}

interface TurnkeyPreparedReference {
  sendTransactionStatusId: string | null
  network: string
  asset: string
  atomicAmount: string
  recipient: string
  from: string
}

export class TurnkeyCommerceExecutor implements CommerceExecutor {
  readonly id = 'turnkey-base-usdc'
  readonly version = 'v1'
  readonly recoveryMode: ExecutorRecoveryMode = 'stable-payment-identity'

  private readonly turnkey: TurnkeyClient
  private readonly store: TurnkeyRequestStore
  private readonly rpcUrl: string
  private readonly injectedPublicClient?: MinimalResumeClient

  constructor(options: TurnkeyExecutorOptions) {
    if (!options.store) throw new TurnkeyStoreRequiredError()
    this.turnkey = options.turnkey
    this.store = options.store
    this.rpcUrl = options.rpcUrl ?? 'https://mainnet.base.org'
    this.injectedPublicClient = options.publicClient
  }

  /**
   * Read-only from end to end: validates the frozen action against this
   * executor's Base/USDC scope and establishes the durable submission
   * identity's INPUT (not yet a Turnkey call) -- no store write, no
   * sendTransaction() call. Mirrors PayBoxCommerceExecutor's gateway-mode
   * prepare(): the actual state-changing action moves entirely to submit(),
   * called only after the orchestrator has already registered the durable
   * OCD execution binding.
   */
  async prepare(context: PrepareContext): Promise<PrepareResult> {
    if (context.action.network !== BASE_NETWORK) throw new Error(`this executor only supports ${BASE_NETWORK}, got "${context.action.network}"`)
    if (context.action.asset.toLowerCase() !== BASE_USDC.toLowerCase()) {
      throw new Error(`this executor only supports USDC (${BASE_USDC}), got "${context.action.asset}"`)
    }
    if (!context.action.sender) {
      throw new Error('action.sender is required -- the Turnkey wallet address transactions will be sent from')
    }
    const atomicAmount = decimalToAtomic6(context.action.amount)
    const reference: TurnkeyPreparedReference = {
      sendTransactionStatusId: null,
      network: context.action.network,
      asset: context.action.asset,
      atomicAmount,
      recipient: context.action.recipient,
      from: context.action.sender,
    }
    return { clientSubmissionKey: context.clientSubmissionKey, reference, preparedAt: new Date().toISOString(), providerReference: null }
  }

  async submit(prepared: PrepareResult): Promise<ExecutionResult> {
    const ref = prepared.reference as TurnkeyPreparedReference
    const clientSubmissionKey = prepared.clientSubmissionKey

    const existing = await this.store.get(clientSubmissionKey)
    if (existing?.sendTransactionStatusId) {
      // Another submit() call already established the send -- never call
      // sendTransaction() again; just resolve/poll the existing one.
      return this.resolve(clientSubmissionKey, existing.sendTransactionStatusId)
    }
    if (existing && !existing.sendTransactionStatusId) {
      // A prior submit() claimed this slot but crashed before learning the
      // sendTransactionStatusId. Known, unavoidable crash window -- honest
      // ambiguity, never a guess, never a second sendTransaction() call.
      throw new TurnkeyAmbiguousSubmitError(clientSubmissionKey)
    }

    const placeholder: TurnkeyRequestRecord = {
      clientSubmissionKey,
      sendTransactionStatusId: null,
      network: ref.network,
      asset: ref.asset,
      atomicAmount: ref.atomicAmount,
      recipient: ref.recipient,
      from: ref.from,
      transactionHash: null,
    }
    const { claimed, record: claimedRecord } = await this.store.claim(clientSubmissionKey, placeholder)
    if (!claimed) {
      if (claimedRecord.sendTransactionStatusId) return this.resolve(clientSubmissionKey, claimedRecord.sendTransactionStatusId)
      throw new TurnkeyAmbiguousSubmitError(clientSubmissionKey)
    }

    // We won the claim -- exactly this call may proceed to Turnkey. This IS
    // Turnkey's own independent custody/policy check (organization/user
    // signing policy is entirely Turnkey's, not OCD's).
    const { sendTransactionStatusId } = await this.turnkey.sendTransaction({
      from: ref.from,
      to: ref.recipient,
      value: ref.atomicAmount,
      caip2: ref.network,
    })

    // Persist the send identity FIRST, before anything else -- this is the
    // durable identity resume()/future submit() calls key off of.
    const record: TurnkeyRequestRecord = { ...claimedRecord, sendTransactionStatusId }
    await this.store.set(record)

    return this.resolve(clientSubmissionKey, sendTransactionStatusId)
  }

  /**
   * Shared by submit() (first check, right after the send) and resume()
   * (every later check) -- ONE getTransactionStatus() poll, then an honest
   * mapping of Turnkey's current status. Neither caller loops internally; a
   * still-BROADCASTING send returns submission-ambiguous with a retry hint,
   * and the orchestrator's own retry pattern (calling resume(), never
   * submit(), for an already-claimed identity) drives the next poll.
   */
  private async resolve(clientSubmissionKey: string, sendTransactionStatusId: string): Promise<ExecutionResult> {
    const record = await this.store.get(clientSubmissionKey)
    if (record?.transactionHash) {
      // Already resolved in a prior call -- never re-poll or re-send.
      return { clientSubmissionKey, status: 'transaction-known', transactionHash: record.transactionHash, providerReference: `turnkey:${sendTransactionStatusId}` }
    }
    const providerReference = `turnkey:${sendTransactionStatusId}`

    let result: TurnkeyTransactionStatusResult
    try {
      result = await this.turnkey.getTransactionStatus(sendTransactionStatusId)
    } catch (err: any) {
      // getTransactionStatus is a read-only status check -- a failure here
      // is ambiguous about Turnkey's OWN reachability, never about whether
      // the send itself changed state. Safe to just try again later.
      return { clientSubmissionKey, status: 'submission-ambiguous', reason: `could not reach Turnkey to check send ${sendTransactionStatusId}: ${err?.message || 'no response'}`, retryAfterSeconds: 5, providerReference }
    }

    if (result.status === 'BROADCASTING') {
      return { clientSubmissionKey, status: 'submission-ambiguous', reason: `Turnkey send ${sendTransactionStatusId} is BROADCASTING -- poll again, do not resubmit`, retryAfterSeconds: 5, providerReference }
    }
    if (result.status === 'FAILED') {
      // Terminal and definitive per Turnkey's own docs: no transaction ever
      // landed onchain. Mapped to manual-recovery-required, the closest of
      // the three ExecutionOutcome states to "no execution occurred" --
      // never endlessly-retryable submission-ambiguous for a status Turnkey
      // itself calls terminal.
      return {
        clientSubmissionKey,
        status: 'manual-recovery-required',
        reason: `Turnkey reported FAILED for send ${sendTransactionStatusId}${result.error?.message ? `: ${result.error.message}` : ''} -- no transaction landed onchain; this will not resolve differently on retry`,
        providerReference,
      }
    }

    // status === 'INCLUDED': a transaction hash exists. Whether it
    // succeeded or reverted onchain is NOT decided here -- this adapter
    // only reports what Turnkey reports was included; OCD's own
    // independent Base observer (unmodified by D3.4C3) is what determines
    // revert/success, exactly as it already does for every other executor.
    if (!result.txHash) {
      return {
        clientSubmissionKey,
        status: 'manual-recovery-required',
        reason: `Turnkey reported INCLUDED for send ${sendTransactionStatusId} but no txHash was present -- check Turnkey directly before retrying`,
        providerReference,
      }
    }
    // record is expected to already exist here (submit() persists it with
    // sendTransactionStatusId before ever calling resolve()); only persist
    // the resolved hash if it does, rather than fabricate a record shape.
    if (record) await this.store.set({ ...record, transactionHash: result.txHash })
    return { clientSubmissionKey, status: 'transaction-known', transactionHash: result.txHash, providerReference }
  }

  async resume(prepared: PrepareResult, priorOutcome?: ExecutionResult): Promise<ExecutionResult> {
    // Mirrors X402BaseUsdcExecutor/PayBoxCommerceExecutor's own resume(): if
    // a transaction hash is ALREADY known from a prior call, independently
    // re-confirm it read-only on-chain -- never guess a new one, never
    // re-send.
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
    // on resume (see payboxExecutor.ts's header for why) -- the Turnkey
    // sendTransactionStatusId can only be found via this adapter's OWN
    // durable store, keyed by clientSubmissionKey.
    const record = await this.store.get(prepared.clientSubmissionKey)
    if (!record || !record.sendTransactionStatusId) {
      return {
        clientSubmissionKey: prepared.clientSubmissionKey,
        status: 'manual-recovery-required',
        reason: 'no Turnkey send is on record for this submission attempt -- check Turnkey directly (dashboard or API) before retrying',
      }
    }
    return this.resolve(prepared.clientSubmissionKey, record.sendTransactionStatusId)
  }
}
