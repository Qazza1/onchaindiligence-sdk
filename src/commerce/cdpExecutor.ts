/**
 * cdpExecutor.ts — the one narrow CdpCommerceExecutor adapter (D3.4C5).
 *
 * PROVES: OCD can sit alongside a Coinbase Developer Platform (CDP) Server
 * Wallet exactly the way it already sits alongside Turnkey (D3.4C3),
 * Crossmint (D3.4C4), and PayBox (D2.6) -- CDP independently custodies keys
 * (server-managed EOA accounts) and signs/broadcasts; OCD independently
 * evaluates policy beforehand and independently observes Base settlement
 * afterward. This file never sees a CDP API secret beyond what its narrow
 * `CdpClient` dependency needs, and never a wallet's private key.
 *
 * SCOPE, DELIBERATE (confirmed against docs.cdp.coinbase.com at
 * implementation time): CDP Server Wallet v2, EVM Account (EOA) execution
 * via `sendEvmTransaction` -- NOT AgentKit (an orchestration/developer
 * framework, not a provider identity) and NOT Smart Accounts/user
 * operations. Current CDP documentation shows the send response as
 * `{ transactionHash, userOpHash }`, with exactly one populated depending
 * on account type -- for an EOA account only `transactionHash` is ever
 * populated. A Smart Account send would return `userOpHash` instead, a
 * genuinely distinct identity from the eventual on-chain transaction hash;
 * this file never accepts or looks for that field, so it can never
 * accidentally collapse the two.
 *
 * NO SEPARATE PROVIDER IDENTITY: unlike Turnkey's sendTransactionStatusId,
 * Crossmint's transferId, or PayBox's request_id, current CDP documentation
 * defines no async operation/request id distinct from `transactionHash`
 * for an EOA send -- the send call is synchronous with respect to
 * broadcast (CDP handles nonce/gas/signing/broadcasting internally and
 * returns once done). The transaction hash IS the durable identity here;
 * this is a confirmed fact about the current API shape, not a design
 * shortcut. See providerEvidence.ts's (onchaindiligence-mcp) matching
 * section header for the full identity discussion.
 *
 * IDEMPOTENCY (documented more strongly here than for Turnkey/Crossmint):
 * CDP's REST API documents `X-Idempotency-Key` as making "duplicate
 * requests with the same key return identical responses" -- a genuine
 * crash-recovery guarantee, not just request-shaping. This adapter passes
 * `clientSubmissionKey` as that key on every attempt. It still keeps the
 * SAME atomic-claim-before-provider-call discipline as every other
 * executor (never assume any single provider-side guarantee alone is
 * sufficient), so a lost response before a transaction hash is durably
 * recorded still surfaces as CdpAmbiguousSubmitError rather than silently
 * retrying within this process -- but, uniquely among this project's
 * adapters, that error can honestly tell the caller that a manual retry
 * with the SAME idempotency key is safe per CDP's own documented contract.
 *
 * NO WEBHOOK: current CDP documentation exposes no wallet-transaction
 * webhook/event mechanism for this send path, and `waitForTransactionReceipt()`
 * is documented as a thin wrapper over standard EVM JSON-RPC -- not a
 * CDP-proprietary status API. So, mirroring PayBox's architecture (not
 * Turnkey's/Crossmint's push-webhook shape), this adapter itself submits a
 * caller-reported ProviderEvidenceSubmission once `sendEvmTransaction`
 * resolves -- there is nothing else to poll.
 *
 * `claimedState` semantics: SUCCEEDED here means "CDP's server wallet
 * successfully broadcast this transaction" -- the same character of claim
 * x402's own `success: true` facilitator response already makes (a checked
 * claim, not proof of on-chain inclusion), never "CDP confirms settlement."
 * OCD's independent Base observer remains the only source of actual
 * inclusion/revert/settlement truth.
 *
 * BINDING STRENGTH HONESTY (same discipline as every other adapter here):
 * this file never computes or claims a binding strength -- that remains
 * entirely server-side (onchaindiligence-mcp's commerceLifecycle.ts,
 * unmodified by D3.4C5).
 *
 * RECOVERY MODE: 'stable-payment-identity' -- once a transaction hash is
 * known, it is a durable, independently-verifiable identity (any EVM RPC
 * can confirm it exists), and CDP's own idempotency-key guarantee makes the
 * crash-before-response window narrower and better-documented than any
 * other adapter in this project.
 */
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode, ProviderEvidenceSubmission } from './executor.js'
import { BASE_NETWORK, BASE_USDC, type MinimalResumeClient } from './x402Executor.js'
import { decimalToAtomic6 } from './x402Challenge.js'

export { BASE_NETWORK as CDP_BASE_NETWORK, BASE_USDC as CDP_BASE_USDC }

// --- CDP's documented public contract (EOA sendEvmTransaction only) ---

export interface CdpSendTransactionInput {
  /** The CDP server wallet EVM account address to send from. */
  address: string
  to: string
  /** Atomic (wei-equivalent) value as a decimal string. */
  value: string
  network: 'base'
  /** Passed as X-Idempotency-Key. See this file's header on CDP's documented guarantee. */
  idempotencyKey: string
}

export interface CdpSendTransactionResult {
  /** Populated for EOA accounts. Current CDP docs never populate this alongside userOpHash. */
  transactionHash?: string | null
}

export class CdpSendError extends Error {
  readonly code: string | null
  constructor(message: string, code: string | null) {
    super(message)
    this.name = 'CdpSendError'
    this.code = code
  }
}

/**
 * The minimal CDP public surface this executor depends on -- narrow enough
 * that the real `@coinbase/cdp-sdk`'s `account.sendTransaction()` via a
 * small transport adapter, or a test double, can both satisfy it
 * unmodified (same discipline as x402Executor.ts's ClientEvmSigner and
 * payboxExecutor.ts/turnkeyExecutor.ts/crossmintExecutor.ts's own client
 * interfaces). Must reject with a CdpSendError (or any Error) on a send
 * failure -- current CDP docs describe no other terminal-failure shape for
 * this call.
 */
export interface CdpClient {
  sendTransaction(input: CdpSendTransactionInput): Promise<CdpSendTransactionResult>
}

// --- the adapter-specific durable request store (same "small adapter-specific helper" exception the other adapters document) ---

export interface CdpRequestRecord {
  clientSubmissionKey: string
  network: string
  atomicAmount: string
  recipient: string
  from: string
  /** null only in the narrow window between "we called sendTransaction" and "we recorded its result" -- see submit(). */
  transactionHash: string | null
  /** Set once we know CDP definitively never broadcast this attempt (a CdpSendError) -- terminal, distinct from the null/unknown crash window. */
  failed: { code: string | null; message: string } | null
}

export interface CdpRequestStore {
  get(clientSubmissionKey: string): Promise<CdpRequestRecord | null>
  set(record: CdpRequestRecord): Promise<void>
  /**
   * Atomically claims the attempt slot for `clientSubmissionKey`: if no
   * record exists yet, stores `placeholder` (which MUST have
   * `transactionHash: null` and `failed: null`) and returns `{ claimed:
   * true, record: placeholder }` -- the caller, and ONLY the caller, may
   * now call `sendTransaction()`. If a record already exists, returns
   * `{ claimed: false, record: <the existing record, unmodified> }` and
   * the caller MUST NOT call `sendTransaction()` again. A real,
   * multi-process implementation MUST make this genuinely atomic (same
   * discipline as every other adapter's `claim()`).
   */
  claim(clientSubmissionKey: string, placeholder: CdpRequestRecord): Promise<{ claimed: boolean; record: CdpRequestRecord }>
}

/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation. Does not survive a restart. */
export class InMemoryCdpRequestStore implements CdpRequestStore {
  private readonly records = new Map<string, CdpRequestRecord>()
  async get(clientSubmissionKey: string): Promise<CdpRequestRecord | null> {
    return this.records.get(clientSubmissionKey) ?? null
  }
  async set(record: CdpRequestRecord): Promise<void> {
    this.records.set(record.clientSubmissionKey, { ...record })
  }
  async claim(clientSubmissionKey: string, placeholder: CdpRequestRecord): Promise<{ claimed: boolean; record: CdpRequestRecord }> {
    const existing = this.records.get(clientSubmissionKey)
    if (existing) return { claimed: false, record: { ...existing } }
    const stored = { ...placeholder }
    this.records.set(clientSubmissionKey, stored)
    return { claimed: true, record: { ...stored } }
  }
}

export class CdpStoreRequiredError extends Error {
  constructor() {
    super(
      "CdpCommerceExecutor requires an explicit, durable `store` (CdpRequestStore) -- InMemoryCdpRequestStore is test/example-only and does not survive a restart, which would silently make this executor's advertised recoveryMode ('stable-payment-identity') false. Pass a durable implementation in production; InMemoryCdpRequestStore only in tests/examples."
    )
    this.name = 'CdpStoreRequiredError'
  }
}

export class CdpAmbiguousSubmitError extends Error {
  constructor(clientSubmissionKey: string, idempotencyKey: string) {
    super(
      `a prior submit() for clientSubmissionKey "${clientSubmissionKey}" called CDP's sendTransaction() but this process never learned the result -- check CDP directly (dashboard or Get Transaction) for an orphaned send tied to this payment before retrying. Unlike this project's other provider adapters, CDP's own documentation states that a request retried with the SAME X-Idempotency-Key ("${idempotencyKey}") returns an identical response rather than creating a duplicate transaction -- a manual retry using that exact key is expected to be safe per CDP's documented contract, even though this code does not attempt it automatically.`
    )
    this.name = 'CdpAmbiguousSubmitError'
  }
}

export interface CdpExecutorOptions {
  /** The CDP client used to call sendTransaction(). Never logged, never persisted by this class. */
  cdp: CdpClient
  /** Durable store for this adapter's own send record -- REQUIRED, no default (same discipline as every other adapter's `store` option). */
  store: CdpRequestStore
  /** Base RPC used ONLY for read-only resume re-confirmation of an already-known transaction hash. Defaults to the public Base RPC. */
  rpcUrl?: string
  /** Test seam: inject a fake read-only client instead of connecting to rpcUrl. */
  publicClient?: MinimalResumeClient
}

interface CdpPreparedReference {
  atomicAmount: string
  recipient: string
  from: string
}

export class CdpCommerceExecutor implements CommerceExecutor {
  readonly id = 'cdp-base-usdc'
  readonly version = 'v1'
  readonly recoveryMode: ExecutorRecoveryMode = 'stable-payment-identity'

  private readonly cdp: CdpClient
  private readonly store: CdpRequestStore
  private readonly rpcUrl: string
  private readonly injectedPublicClient?: MinimalResumeClient

  constructor(options: CdpExecutorOptions) {
    if (!options.store) throw new CdpStoreRequiredError()
    this.cdp = options.cdp
    this.store = options.store
    this.rpcUrl = options.rpcUrl ?? 'https://mainnet.base.org'
    this.injectedPublicClient = options.publicClient
  }

  /** Read-only: validates the frozen action against this executor's Base/USDC scope. No CDP call. */
  async prepare(context: PrepareContext): Promise<PrepareResult> {
    if (context.action.network !== BASE_NETWORK) throw new Error(`this executor only supports ${BASE_NETWORK}, got "${context.action.network}"`)
    if (context.action.asset.toLowerCase() !== BASE_USDC.toLowerCase()) {
      throw new Error(`this executor only supports USDC (${BASE_USDC}), got "${context.action.asset}"`)
    }
    if (!context.action.sender) {
      throw new Error('action.sender is required -- the CDP server wallet EVM account address to send from')
    }
    const reference: CdpPreparedReference = {
      atomicAmount: decimalToAtomic6(context.action.amount),
      recipient: context.action.recipient,
      from: context.action.sender,
    }
    return { clientSubmissionKey: context.clientSubmissionKey, reference, preparedAt: new Date().toISOString(), providerReference: null }
  }

  async submit(prepared: PrepareResult): Promise<ExecutionResult> {
    const ref = prepared.reference as CdpPreparedReference
    const clientSubmissionKey = prepared.clientSubmissionKey

    const existing = await this.store.get(clientSubmissionKey)
    if (existing?.transactionHash) return this.finalOutcome(clientSubmissionKey, existing)
    if (existing?.failed) return this.finalOutcome(clientSubmissionKey, existing)
    if (existing) {
      // Claimed but neither a hash nor a definitive failure is on record --
      // the known, unavoidable crash window. Never a second sendTransaction() call.
      throw new CdpAmbiguousSubmitError(clientSubmissionKey, clientSubmissionKey)
    }

    const placeholder: CdpRequestRecord = { clientSubmissionKey, network: BASE_NETWORK, atomicAmount: ref.atomicAmount, recipient: ref.recipient, from: ref.from, transactionHash: null, failed: null }
    const { claimed, record: claimedRecord } = await this.store.claim(clientSubmissionKey, placeholder)
    if (!claimed) {
      if (claimedRecord.transactionHash || claimedRecord.failed) return this.finalOutcome(clientSubmissionKey, claimedRecord)
      throw new CdpAmbiguousSubmitError(clientSubmissionKey, clientSubmissionKey)
    }

    // We won the claim -- exactly this call may proceed to CDP. This IS
    // CDP's own independent custody/policy check (the server wallet's
    // signing authority and any CDP-side policy engine rules are entirely
    // CDP's, not OCD's).
    let result: CdpSendTransactionResult
    try {
      result = await this.cdp.sendTransaction({ address: ref.from, to: ref.recipient, value: ref.atomicAmount, network: 'base', idempotencyKey: clientSubmissionKey })
    } catch (err) {
      // Terminal and definitive: CDP itself rejected the send before ever
      // broadcasting (e.g. insufficient funds, policy denial). No merchant
      // payment occurred. Persisted BEFORE returning so this never
      // re-attempts sendTransaction on a later call.
      const code = err instanceof CdpSendError ? err.code : null
      const message = err instanceof Error ? err.message : String(err)
      const record: CdpRequestRecord = { ...claimedRecord, failed: { code, message } }
      await this.store.set(record)
      return this.finalOutcome(clientSubmissionKey, record)
    }

    if (!result.transactionHash) {
      // CDP's own documented shape for this call always populates
      // transactionHash for an EOA account send that succeeded -- an
      // empty success response is inconsistent, not a case to guess about.
      const record: CdpRequestRecord = { ...claimedRecord, failed: { code: 'MISSING_TRANSACTION_HASH', message: 'CDP sendTransaction succeeded but returned no transactionHash (and no userOpHash is expected/supported by this EOA-only adapter)' } }
      await this.store.set(record)
      return this.finalOutcome(clientSubmissionKey, record)
    }

    const record: CdpRequestRecord = { ...claimedRecord, transactionHash: result.transactionHash }
    await this.store.set(record)
    return this.finalOutcome(clientSubmissionKey, record)
  }

  private finalOutcome(clientSubmissionKey: string, record: CdpRequestRecord): ExecutionResult {
    if (record.transactionHash) {
      const providerReference = `cdp:${record.transactionHash}`
      const providerEvidence: ProviderEvidenceSubmission = {
        provider: 'cdp',
        providerVersion: this.version,
        payload: { status: 'success', transaction_hash: record.transactionHash, network: 'base', idempotency_key: clientSubmissionKey },
      }
      return { clientSubmissionKey, status: 'transaction-known', transactionHash: record.transactionHash, providerReference, providerEvidence }
    }
    // record.failed is guaranteed set here (finalOutcome is only called once one or the other is true).
    const failed = record.failed!
    const providerReference = `cdp:${clientSubmissionKey}`
    const providerEvidence: ProviderEvidenceSubmission = {
      provider: 'cdp',
      providerVersion: this.version,
      payload: { status: 'failed', network: 'base', idempotency_key: clientSubmissionKey, error: { code: failed.code, message: failed.message } },
    }
    return {
      clientSubmissionKey,
      status: 'manual-recovery-required',
      reason: `CDP sendTransaction failed${failed.code ? ` (${failed.code})` : ''}: ${failed.message} -- no transaction was broadcast; this will not resolve differently on retry`,
      providerReference,
      providerEvidence,
    }
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
    if (!record || (!record.transactionHash && !record.failed)) {
      return {
        clientSubmissionKey: prepared.clientSubmissionKey,
        status: 'manual-recovery-required',
        reason: 'no CDP send result is on record for this submission attempt -- check CDP directly (dashboard or Get Transaction) before retrying',
      }
    }
    return this.finalOutcome(prepared.clientSubmissionKey, record)
  }
}
