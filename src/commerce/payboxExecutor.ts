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
 * PUBLIC CONTRACT USED (docs.paybox.sh, inspected live 2026-09-06):
 *   - `pay_x402` (reference/mcp-tools): signs an x402 v2 "exact" payment
 *     authorization for a wallet-kind credential. Returns a `request_id`
 *     immediately; on eventual `success`, `output.value.x_payment` carries
 *     the header name/value to present to the paid resource. PayBox does
 *     NOT itself call the resource or broadcast anything on-chain for this
 *     tool -- broadcasting happens when the caller attaches that header to
 *     an HTTP request to the resource, exactly like x402Executor.ts's own
 *     `wrapFetchWithPayment` step, except the SIGNING half now happens
 *     inside PayBox's vault instead of a local private key.
 *   - `get_request` (reference/mcp-tools): polls the CURRENT status of a
 *     request by `request_id`. Docs (concepts/requests) state the request
 *     lifecycle explicitly: non-terminal `pending_approval` ->
 *     `pending_signature` -> terminal `success` | `denied` | `error`, and
 *     the "critical rule": "submit once, then poll -- never re-issue the
 *     original tool call to 'finish' it. Resubmission creates a duplicate
 *     operation." This adapter follows that rule exactly: `pay_x402` is
 *     called AT MOST ONCE per clientSubmissionKey (from prepare()); every
 *     subsequent check, in submit() or resume(), calls `get_request` only.
 *
 * THIS FILE DEPENDS ON NO SPECIFIC PAYBOX SDK VERSION: `PayBoxClient` below
 * is a minimal structural interface mirroring exactly the two documented
 * tool contracts above (same discipline as x402Executor.ts's `ClientEvmSigner`
 * -- narrow enough that the real `@paybox-sh/sdk`'s `PayboxClient`, a direct
 * MCP tool-call wrapper, or a test double can all satisfy it unmodified).
 *
 * WHY A SEPARATE PayBoxRequestStore (Section 11's "small adapter-specific
 * helper" exception): the orchestrator (client.ts's CommerceOperation)
 * persists only clientSubmissionKey/executorId/executionRequestId/
 * transactionHash across a restart -- on resume, it reconstructs a GENERIC
 * `PrepareResult.reference = { action }`, not whatever an individual
 * executor's own prepare() returned (see client.ts's executeLocked(),
 * both resume branches). X402BaseUsdcExecutor never needed its own store
 * because its only durable identity IS the eventual transaction hash, which
 * the orchestrator already persists. PayBox is different: `pay_x402` has NO
 * documented idempotency key, so this adapter's OWN durable request_id
 * (keyed by clientSubmissionKey, which the orchestrator DOES reliably pass
 * to both prepare() and resume()) is the only thing standing between a lost
 * response and a duplicate PayBox request. This is the genuinely-required
 * small helper Section 11 anticipates -- not a parallel lifecycle API.
 *
 * RECOVERY MODE: 'stable-payment-identity', not 'provider-idempotent' and
 * not 'manual'. Chosen by what PayBox's OWN public contract actually
 * guarantees, not for the strongest-sounding label (Section 5):
 *   - NOT 'provider-idempotent': that would claim calling `pay_x402` twice
 *     with the same intent is safe (PayBox itself would dedupe). Docs say
 *     the opposite -- resubmitting creates a duplicate request. False if
 *     claimed.
 *   - IS 'stable-payment-identity': once a request_id exists, `get_request`
 *     can be polled/resumed against that SAME id indefinitely, deterministically,
 *     with no risk of creating a new operation -- exactly the definition
 *     Section 5 gives for this label. The identity is the PayBox request_id
 *     itself, established once in prepare() and never re-created.
 *   - The one honest gap: if `pay_x402` is called but the process dies
 *     before learning whether PayBox ever created a request (no response at
 *     all), there is no stable identity to resume -- see prepare()'s
 *     PayBoxAmbiguousPrepareError, which surfaces this narrow window
 *     explicitly rather than silently retrying pay_x402 a second time.
 */
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js'
import { BASE_NETWORK, BASE_USDC, type MinimalResumeClient } from './x402Executor.js'
import { X402ChallengeError, decodeChallenge, validateChallenge, decodeSettlementResponse, decimalToAtomic6 } from './x402Challenge.js'

export { BASE_NETWORK as PAYBOX_BASE_NETWORK, BASE_USDC as PAYBOX_BASE_USDC }

// --- PayBox's documented public contract (docs.paybox.sh/reference/mcp-tools) ---

export type PayBoxRequestStatus = 'pending_approval' | 'pending_signature' | 'success' | 'denied' | 'error'

export interface PayBoxRequestEnvelope {
  request_id: string
  status: PayBoxRequestStatus
  /** Present on `success`. For pay_x402, carries `{ x_payment: { header, value } }` -- the signed payment header to present to the paid resource. PayBox does not itself call the resource. */
  output?: { value?: { x_payment?: { header: string; value: string } } } & Record<string, unknown>
  /** Present on `denied`. */
  reason?: string
  /** Present on `error`. */
  message?: string
}

export interface PayBoxPayX402Input {
  /** A wallet-kind credential id. */
  credential_id: string
  /** The 402's `accepts` PaymentRequirements array, verbatim. */
  accepts: unknown[]
  /** The paid resource URL, for audit/display. */
  resource_url: string
  /** 1 for JSON-body requirements, 2 for header requirements. */
  x402_version?: 1 | 2
}

/**
 * The minimal PayBox public surface this executor depends on -- exactly
 * `pay_x402` and `get_request`, structurally typed so any transport (the
 * real `@paybox-sh/sdk` PayboxClient, an MCP tool-call wrapper, or a test
 * double) can satisfy it without this package taking a hard dependency on
 * a specific vendor SDK version.
 */
export interface PayBoxClient {
  payX402(input: PayBoxPayX402Input): Promise<PayBoxRequestEnvelope>
  getRequest(requestId: string): Promise<PayBoxRequestEnvelope>
}

// --- the adapter-specific durable request store (see header) ---

export interface PayBoxRequestRecord {
  clientSubmissionKey: string
  /** null only in the narrow window between "we called pay_x402" and "we recorded its request_id" -- see prepare(). */
  payboxRequestId: string | null
  resourceUrl: string
  network: string
  asset: string
  atomicAmount: string
  recipient: string
  /** Set once the merchant resource confirms the payment and returns a hash -- once set, this adapter never re-presents the PayBox-signed header to the merchant again. */
  transactionHash: string | null
}

export interface PayBoxRequestStore {
  get(clientSubmissionKey: string): Promise<PayBoxRequestRecord | null>
  set(record: PayBoxRequestRecord): Promise<void>
  /**
   * Atomically claims the attempt slot for `clientSubmissionKey` (D2.6
   * review fix #3): if no record exists yet, stores `placeholder` (which
   * MUST have `payboxRequestId: null`) and returns `{ claimed: true, record:
   * placeholder }` -- the caller, and ONLY the caller, may now call
   * `pay_x402` for this key. If a record already exists (whether still in
   * the ambiguous pre-request-id window, or already holding a
   * `payboxRequestId`), returns `{ claimed: false, record: <the existing
   * record, unmodified> }` and the caller MUST NOT call `pay_x402`.
   *
   * This is the ONE operation in this interface that a real, multi-process
   * implementation MUST make genuinely atomic (e.g. a SQL `INSERT ... ON
   * CONFLICT DO NOTHING` followed by a `SELECT`, or an equivalent
   * conditional-put) -- the same discipline as `CommerceRecoveryStore.create()`
   * throwing `RecoveryRecordExistsError` rather than silently overwriting.
   * `InMemoryPayBoxRequestStore`'s implementation is atomic only because a
   * single JS `Map` access with no `await` in between can never interleave
   * with another call in the same process.
   */
  claim(clientSubmissionKey: string, placeholder: PayBoxRequestRecord): Promise<{ claimed: boolean; record: PayBoxRequestRecord }>
}

/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation -- same discipline as recoveryStore.ts's InMemoryRecoveryStore. Does not survive a restart; a real deployment must implement this against durable storage. */
export class InMemoryPayBoxRequestStore implements PayBoxRequestStore {
  private readonly records = new Map<string, PayBoxRequestRecord>()
  async get(clientSubmissionKey: string): Promise<PayBoxRequestRecord | null> {
    return this.records.get(clientSubmissionKey) ?? null
  }
  async set(record: PayBoxRequestRecord): Promise<void> {
    this.records.set(record.clientSubmissionKey, { ...record })
  }
  async claim(clientSubmissionKey: string, placeholder: PayBoxRequestRecord): Promise<{ claimed: boolean; record: PayBoxRequestRecord }> {
    // No `await` between the check and the write -- this is what makes this
    // specific implementation race-free for concurrent callers IN THIS PROCESS.
    const existing = this.records.get(clientSubmissionKey)
    if (existing) return { claimed: false, record: { ...existing } }
    const stored = { ...placeholder }
    this.records.set(clientSubmissionKey, stored)
    return { claimed: true, record: { ...stored } }
  }
}

/** Thrown by the PayBoxCommerceExecutor constructor when no durable store was supplied (D2.6 review fix #2). */
export class PayBoxStoreRequiredError extends Error {
  constructor() {
    super(
      "PayBoxCommerceExecutor requires an explicit, durable `store` (PayBoxRequestStore) -- InMemoryPayBoxRequestStore is test/example-only and does not survive a restart, which would silently make this executor's advertised recoveryMode ('stable-payment-identity') false. Pass a durable implementation in production; InMemoryPayBoxRequestStore only in tests/examples."
    )
    this.name = 'PayBoxStoreRequiredError'
  }
}

/** Thrown by prepare() when a PRIOR attempt for this exact clientSubmissionKey called pay_x402 but this process never learned the outcome -- see this file's header for why this cannot be silently retried. */
export class PayBoxAmbiguousPrepareError extends Error {
  constructor(clientSubmissionKey: string) {
    super(
      `a prior prepare() for clientSubmissionKey "${clientSubmissionKey}" called PayBox's pay_x402 but this process never learned whether PayBox created a request -- pay_x402 has no idempotency key, so calling it again here could create a SECOND PayBox request for the same intended payment. Check PayBox directly (dashboard or "paybox request --list") for an orphaned request tied to this payment before retrying.`
    )
    this.name = 'PayBoxAmbiguousPrepareError'
  }
}

export interface PayBoxExecutorOptions {
  /** The PayBox client used to call pay_x402/get_request. Never logged, never persisted by this class. */
  paybox: PayBoxClient
  /** The single PayBox wallet-kind credential this executor pays from (Section 2: one credential, one operation at a time for the reference flow). */
  credentialId: string
  /**
   * Durable store for this adapter's own request identity -- REQUIRED, no
   * default (D2.6 review fix #2). This class advertises
   * `recoveryMode: 'stable-payment-identity'`, which is only true if the
   * PayBox request_id genuinely survives a restart; silently defaulting to
   * `InMemoryPayBoxRequestStore` would make that claim false the moment the
   * process restarts. `InMemoryPayBoxRequestStore` remains available for
   * tests/examples but must be passed explicitly, exactly like
   * `CommerceRecoveryStore` has no safe default either.
   */
  store: PayBoxRequestStore
  fetch?: typeof globalThis.fetch
  /** Base RPC used ONLY for read-only resume confirmation of an already-known transaction hash. Defaults to the public Base RPC. */
  rpcUrl?: string
  /** Test seam: inject a fake read-only client instead of connecting to rpcUrl. */
  publicClient?: MinimalResumeClient
}

interface PayBoxPreparedReference {
  payboxRequestId: string | null
  resourceUrl: string
  network: string
  asset: string
  atomicAmount: string
  recipient: string
}

export class PayBoxCommerceExecutor implements CommerceExecutor {
  readonly id = 'paybox-x402-base-usdc'
  readonly version = 'v1'
  readonly recoveryMode: ExecutorRecoveryMode = 'stable-payment-identity'

  private readonly paybox: PayBoxClient
  private readonly credentialId: string
  private readonly store: PayBoxRequestStore
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly rpcUrl: string
  private readonly injectedPublicClient?: MinimalResumeClient

  constructor(options: PayBoxExecutorOptions) {
    if (!options.store) throw new PayBoxStoreRequiredError()
    this.paybox = options.paybox
    this.credentialId = options.credentialId
    this.store = options.store
    // See client.ts's constructor comment: binding here is what keeps a bare
    // `globalThis.fetch` reference safe to call as `this.fetchImpl(...)` in
    // a real browser.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.rpcUrl = options.rpcUrl ?? 'https://mainnet.base.org'
    this.injectedPublicClient = options.publicClient
  }

  async prepare(context: PrepareContext): Promise<PrepareResult> {
    if (context.action.network !== BASE_NETWORK) throw new X402ChallengeError(`this executor only supports ${BASE_NETWORK}, got "${context.action.network}"`)
    if (context.action.asset.toLowerCase() !== BASE_USDC.toLowerCase()) {
      throw new X402ChallengeError(`this executor only supports USDC (${BASE_USDC}), got "${context.action.asset}"`)
    }
    if (!context.action.resource) throw new X402ChallengeError('action.resource (the x402 resource URL) is required to prepare a submission')

    // Read-only probe -- no PayBox call, no signing, no payment. Establishes
    // exactly what would be agreed to pay BEFORE any authorization exists,
    // identical in spirit to X402BaseUsdcExecutor.prepare(). Safe to run
    // more than once even under a concurrent race (it has no side effects),
    // so it happens BEFORE the atomic claim below.
    const probe = await this.fetchImpl(context.action.resource)
    if (probe.status !== 402) throw new X402ChallengeError(`expected HTTP 402 from ${context.action.resource}, got ${probe.status}`)
    const challenge = decodeChallenge(probe)
    const atomicAmount = decimalToAtomic6(context.action.amount)
    validateChallenge(challenge, { network: context.action.network, asset: context.action.asset, amount: atomicAmount, recipient: context.action.recipient })

    // D2.6 review fix #3: atomically claim the attempt slot for this
    // clientSubmissionKey -- exactly one concurrent caller may proceed to
    // call pay_x402. A loser either reuses the winner's already-established
    // request (if it finished first) or, if the winner is still in the
    // ambiguous pre-request-id window, stops safely rather than racing to
    // call pay_x402 itself.
    const placeholder: PayBoxRequestRecord = {
      clientSubmissionKey: context.clientSubmissionKey,
      payboxRequestId: null,
      resourceUrl: context.action.resource,
      network: context.action.network,
      asset: context.action.asset,
      atomicAmount,
      recipient: context.action.recipient,
      transactionHash: null,
    }
    const { claimed, record: claimedRecord } = await this.store.claim(context.clientSubmissionKey, placeholder)
    if (!claimed) {
      if (claimedRecord.payboxRequestId) {
        // Another attempt already established (or is finishing establishing)
        // a PayBox request for this exact key -- never call pay_x402 again.
        return this.toPrepareResult(context.clientSubmissionKey, claimedRecord)
      }
      // The winner called pay_x402 but this process never learned the
      // outcome (crash, or the winner is still in flight). Known,
      // unavoidable crash window (see this file's header) -- surface it
      // honestly rather than racing to call pay_x402 ourselves.
      throw new PayBoxAmbiguousPrepareError(context.clientSubmissionKey)
    }

    // We won the claim -- exactly this call may proceed to PayBox. This is
    // PayBox's OWN independent grant/authorization check -- pay_x402
    // internally applies the credential's approval mode ("Always Ask" vs
    // autonomous-within-limits per docs.paybox.sh/concepts/model) before
    // ever producing a signature. Does NOT broadcast anything on-chain (see
    // header) -- only establishes the durable request_id.
    const envelope = await this.paybox.payX402({
      credential_id: this.credentialId,
      accepts: (challenge as { accepts: unknown[] }).accepts,
      resource_url: context.action.resource,
      x402_version: (challenge as { x402Version?: 1 | 2 }).x402Version,
    })

    const record: PayBoxRequestRecord = { ...claimedRecord, payboxRequestId: envelope.request_id }
    await this.store.set(record)
    return this.toPrepareResult(context.clientSubmissionKey, record)
  }

  private toPrepareResult(clientSubmissionKey: string, record: PayBoxRequestRecord): PrepareResult {
    const reference: PayBoxPreparedReference = {
      payboxRequestId: record.payboxRequestId,
      resourceUrl: record.resourceUrl,
      network: record.network,
      asset: record.asset,
      atomicAmount: record.atomicAmount,
      recipient: record.recipient,
    }
    return {
      clientSubmissionKey,
      reference,
      preparedAt: new Date().toISOString(),
      // Section 7: correlated into the D2.4 execution binding, and from
      // there the lifecycle evidence bundle, by client.ts.
      providerReference: record.payboxRequestId ? `paybox:${record.payboxRequestId}` : null,
    }
  }

  async submit(prepared: PrepareResult): Promise<ExecutionResult> {
    const ref = prepared.reference as PayBoxPreparedReference
    return this.resolve(prepared.clientSubmissionKey, ref)
  }

  async resume(prepared: PrepareResult, priorOutcome?: ExecutionResult): Promise<ExecutionResult> {
    // Mirrors X402BaseUsdcExecutor's own resume(): if a transaction hash is
    // ALREADY known from a prior call, independently re-confirm it read-only
    // on-chain -- never guess a new one, never re-present the payment header.
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
    // on resume (see this file's header) -- the PayBox request_id can only be
    // found via this adapter's OWN durable store, keyed by the one field the
    // orchestrator DOES reliably pass through: clientSubmissionKey.
    const record = await this.store.get(prepared.clientSubmissionKey)
    if (!record || !record.payboxRequestId) {
      return {
        clientSubmissionKey: prepared.clientSubmissionKey,
        status: 'manual-recovery-required',
        reason: 'no PayBox request is on record for this submission attempt -- check PayBox directly (dashboard or CLI) before retrying',
      }
    }
    return this.resolve(prepared.clientSubmissionKey, {
      payboxRequestId: record.payboxRequestId,
      resourceUrl: record.resourceUrl,
      network: record.network,
      asset: record.asset,
      atomicAmount: record.atomicAmount,
      recipient: record.recipient,
    })
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
  private async resolve(clientSubmissionKey: string, ref: PayBoxPreparedReference): Promise<ExecutionResult> {
    const record = await this.store.get(clientSubmissionKey)
    if (record?.transactionHash) {
      // Already confirmed by the merchant in a prior call -- never re-present
      // the PayBox-signed payment header again.
      return { clientSubmissionKey, status: 'transaction-known', transactionHash: record.transactionHash, providerReference: `paybox:${ref.payboxRequestId}` }
    }
    if (!ref.payboxRequestId) {
      return { clientSubmissionKey, status: 'manual-recovery-required', reason: 'no PayBox request_id is available for this submission attempt' }
    }

    let envelope: PayBoxRequestEnvelope
    try {
      envelope = await this.paybox.getRequest(ref.payboxRequestId)
    } catch (err: any) {
      // get_request is a read-only status check -- a failure here is
      // ambiguous about PayBox's OWN reachability, never about whether the
      // request itself changed state. Safe to just try again later.
      return { clientSubmissionKey, status: 'submission-ambiguous', reason: `could not reach PayBox to check request ${ref.payboxRequestId}: ${err?.message || 'no response'}`, retryAfterSeconds: 5 }
    }

    if (envelope.status === 'pending_approval' || envelope.status === 'pending_signature') {
      return {
        clientSubmissionKey,
        status: 'submission-ambiguous',
        reason: `PayBox request ${ref.payboxRequestId} is ${envelope.status} -- poll again, do not resubmit`,
        retryAfterSeconds: envelope.status === 'pending_approval' ? 15 : 5,
      }
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
      }
    }
    if (envelope.status === 'error') {
      // D2.6 review fix #4: docs.paybox.sh/concepts/requests lists `error`
      // under "Terminal (polling stops)" -- treating it as retryable
      // submission-ambiguous would poll the SAME terminal envelope forever
      // and, worse, invites a caller to eventually give up and start a NEW
      // PayBox request for the same intent. Terminal and definitive, exactly
      // like `denied`: no merchant payment occurred and this request will
      // never resolve differently. A genuinely NEW attempt requires a NEW
      // operation/clientSubmissionKey, never a retry of this one.
      return {
        clientSubmissionKey,
        status: 'manual-recovery-required',
        reason: `PayBox reported a terminal error for request ${ref.payboxRequestId}${envelope.message ? `: ${envelope.message}` : ''} -- no merchant payment was made; this request will not resolve differently on retry`,
      }
    }

    // status === 'success': PayBox signed the payment. It did NOT submit it
    // to the merchant -- that's this adapter's job now, exactly like
    // X402BaseUsdcExecutor.submit()'s own post-signing half.
    const xPayment = envelope.output?.value?.x_payment
    if (!xPayment?.header || !xPayment?.value) {
      // `success` is ALSO terminal (per docs) -- polling get_request again
      // would return this exact same envelope forever, so this must stop
      // safely rather than being reported as retryable.
      return {
        clientSubmissionKey,
        status: 'manual-recovery-required',
        reason: `PayBox request ${ref.payboxRequestId} reached terminal status "success" but no x_payment header could be read from its output -- check PayBox directly before retrying`,
      }
    }
    return this.presentPaymentToMerchant(clientSubmissionKey, ref, xPayment)
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
   */
  private async presentPaymentToMerchant(
    clientSubmissionKey: string,
    ref: PayBoxPreparedReference,
    xPayment: { header: string; value: string }
  ): Promise<ExecutionResult> {
    let res: Response
    try {
      res = await this.fetchImpl(ref.resourceUrl, { headers: { [xPayment.header]: xPayment.value } })
    } catch (err: any) {
      return { clientSubmissionKey, status: 'submission-ambiguous', reason: err?.message || 'no response from the resource after presenting the PayBox-signed payment', retryAfterSeconds: 5 }
    }
    if (res.status === 402) {
      return { clientSubmissionKey, status: 'submission-ambiguous', reason: `resource still returned 402 after presenting the PayBox-signed payment (status ${res.status})` }
    }
    if (!res.ok) {
      return { clientSubmissionKey, status: 'submission-ambiguous', reason: `resource returned HTTP ${res.status} after presenting the PayBox-signed payment -- outcome unknown` }
    }
    const { transactionHash } = decodeSettlementResponse(res)
    if (!transactionHash) {
      return { clientSubmissionKey, status: 'submission-ambiguous', reason: 'resource responded successfully but no transaction hash could be parsed from the settlement response' }
    }

    // Durable BEFORE returning -- resolve() must never re-present this
    // payment header to the merchant again once a hash is known.
    const record = await this.store.get(clientSubmissionKey)
    if (record) await this.store.set({ ...record, transactionHash })
    return { clientSubmissionKey, status: 'transaction-known', transactionHash, providerReference: `paybox:${ref.payboxRequestId}` }
  }
}
