/**
 * x402Executor.ts — the one narrow, production-quality executor adapter for
 * the existing Base USDC x402 v2 "exact" flow (D2.5, Section 4).
 *
 * SCOPE, DELIBERATE: Base mainnet, USDC, x402 v2 exact scheme only — no
 * other chain/asset/scheme. Reuses the EXACT same proven pattern as
 * onchaindiligence-mcp's scripts/first-commerce-lifecycle.ts (D2.2A) and
 * operator/src/main.ts (D2.2B), the only two places this integration has
 * ever moved real money: `wrapFetchWithPayment` + `x402Client` +
 * `ExactEvmScheme(signer)`, called through EXACTLY ONCE per submit().
 *
 * RECOVERY MODE IS HONESTLY 'manual', not 'stable-payment-identity':
 * `wrapFetchWithPayment` is an atomic sign-and-pay primitive — it does not
 * expose the ERC-3009 nonce it generates internally, so if `submit()` never
 * receives a response (timeout, connection drop), this adapter has no
 * independent identity to query "was this specific authorization consumed"
 * against. A deeper integration COULD extract the nonce via
 * `ExactEvmScheme.createPaymentPayload()` and later check it on-chain via
 * USDC's own `authorizationState(authorizer, nonce)` view function — but
 * that path is unproven against the real facilitator (verifying it would
 * require a live payment, which no milestone through D2.5 permits) and is
 * therefore NOT implemented here. Reporting 'manual' honestly, and resolving
 * to manual-recovery-required on an ambiguous submit, is the correct choice
 * over pretending a recovery guarantee this code cannot actually back up —
 * see onchaindiligence-mcp's own D2.4 executionBinding.ts: "It is preferable
 * to pretending exactly-once execution can be guaranteed."
 *
 * The ONE exception: if `submit()` DID receive a response before some LATER
 * step failed (so a transaction hash is already known), `resume()` can and
 * does independently re-confirm it read-only on-chain — no guessing, no new
 * payment, just checking what's already claimed.
 */
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { wrapFetchWithPayment } from '@x402/fetch'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { toClientEvmSigner, type ClientEvmSigner } from '@x402/evm'
import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js'

export type { ClientEvmSigner }
export { toClientEvmSigner }

export const BASE_NETWORK = 'eip155:8453'
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** The subset of viem's PublicClient resume() actually calls -- narrowed so tests can inject a minimal fake instead of a real RPC connection. */
export interface MinimalResumeClient {
  getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<unknown>
}

export interface X402ExecutorOptions {
  /**
   * Signs the EIP-3009 payment authorization. Never logged, never persisted
   * by this class. `@x402/evm`'s own ExactEvmScheme wants exactly this
   * shape (address + signTypedData), NOT a full viem Account/WalletClient --
   * that's deliberate: it's the one interface both a Node private-key
   * signer (`toClientEvmSigner(privateKeyToAccount(pk))`, re-exported from
   * this module) and a browser injected-wallet signer (hand-built around
   * `walletClient.signTypedData`, since an injected wallet's viem account has
   * no signing methods of its own) can equally satisfy.
   */
  signer: ClientEvmSigner
  /** Base RPC used ONLY for read-only resume confirmation. Defaults to the public Base RPC. */
  rpcUrl?: string
  fetch?: typeof globalThis.fetch
  /** Test seam: inject a fake read-only client instead of connecting to rpcUrl. */
  publicClient?: MinimalResumeClient
}

interface X402PreparedReference {
  resourceUrl: string
  network: string
  asset: string
  atomicAmount: string
  recipient: string
}

/**
 * `Buffer` is a Node global, not a browser one -- calling `Buffer.from(...)`
 * here used to throw `ReferenceError: Buffer is not defined` in a real
 * browser (confirmed live, D2.5A: a real OneSource 402 challenge, valid and
 * byte-identical through the local proxy, failed to decode). That
 * ReferenceError was thrown INSIDE decodeChallenge()'s try/catch below and
 * silently relabeled as "Payment-Required header was not base64-encoded
 * JSON" -- a misleading error that looks like a merchant-format problem but
 * isn't one. `atob`/`TextDecoder` are the browser-safe equivalents (both
 * also globally available in Node), mirroring lifecycleCore.ts's own
 * isomorphic decodeChallenge in onchaindiligence-mcp exactly.
 */
function base64ToUtf8(base64: string): string {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

class X402ChallengeError extends Error {}

function decodeChallenge(res: Response): any {
  const header = res.headers.get('payment-required')
  if (!header) throw new X402ChallengeError(`${res.url}: 402 response carried no Payment-Required header`)
  try {
    return JSON.parse(base64ToUtf8(header))
  } catch {
    throw new X402ChallengeError(`${res.url}: Payment-Required header was not base64-encoded JSON`)
  }
}

/** Validates a decoded x402 v2 "exact" challenge against the frozen preflighted action. Never mutates anything; throws before any signing could occur. */
function validateChallenge(challenge: any, expected: { network: string; asset: string; amount: string; recipient: string }): void {
  if (challenge?.x402Version !== 2) throw new X402ChallengeError(`unexpected x402 version ${challenge?.x402Version} (expected 2)`)
  const accepts = challenge?.accepts?.[0]
  if (!accepts) throw new X402ChallengeError('challenge contained no accepts entry')
  if (accepts.scheme !== 'exact') throw new X402ChallengeError(`unexpected scheme "${accepts.scheme}" (expected "exact")`)
  if (accepts.network !== expected.network) throw new X402ChallengeError(`network mismatch: quoted "${accepts.network}", expected "${expected.network}"`)
  if (String(accepts.asset).toLowerCase() !== expected.asset.toLowerCase()) {
    throw new X402ChallengeError(`asset mismatch: quoted "${accepts.asset}", expected "${expected.asset}"`)
  }
  if (String(accepts.payTo).toLowerCase() !== expected.recipient.toLowerCase()) {
    throw new X402ChallengeError(`recipient mismatch: quoted "${accepts.payTo}", expected "${expected.recipient}" -- refusing to pay an unexpected address`)
  }
  if (String(accepts.amount) !== expected.amount) {
    throw new X402ChallengeError(`amount mismatch: quoted "${accepts.amount}", expected exactly "${expected.amount}" atomic units`)
  }
}

function decodeSettlementResponse(res: Response): { transactionHash: string | null } {
  const header = res.headers.get('x-payment-response') ?? res.headers.get('payment-response')
  if (!header) return { transactionHash: null }
  try {
    const decoded = JSON.parse(base64ToUtf8(header))
    return { transactionHash: typeof decoded?.transaction === 'string' ? decoded.transaction : null }
  } catch {
    return { transactionHash: null }
  }
}

/**
 * Converts a canonical decimal amount (e.g. "1.00") into USDC's 6-decimal
 * atomic unit string, WITHOUT floating point — mirrors
 * onchaindiligence-mcp's src/money.ts exactly (kept independent here since
 * this package does not depend on that server-side module).
 */
function decimalToAtomic6(amount: string): string {
  const [intPart, fracPart = ''] = amount.split('.')
  if (fracPart.length > 6) throw new X402ChallengeError(`amount "${amount}" has more precision than USDC's 6 decimals support`)
  return BigInt(intPart + fracPart.padEnd(6, '0')).toString()
}

export class X402BaseUsdcExecutor implements CommerceExecutor {
  readonly id = 'x402-base-usdc-exact'
  readonly version = 'v1'
  readonly recoveryMode: ExecutorRecoveryMode = 'manual'

  private readonly signer: ClientEvmSigner
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly rpcUrl: string
  private readonly injectedPublicClient?: MinimalResumeClient

  constructor(options: X402ExecutorOptions) {
    this.signer = options.signer
    // See client.ts's constructor comment: a bare `globalThis.fetch`
    // reference, later invoked as `this.fetchImpl(...)`, throws "Illegal
    // invocation" in real browsers (detached from its required receiver) --
    // invisible under Node, which is why this only surfaces against a real
    // injected-wallet browser flow. Bind it here so this executor is safe to
    // construct with no `fetch` option in either environment.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.rpcUrl = options.rpcUrl ?? 'https://mainnet.base.org'
    this.injectedPublicClient = options.publicClient
  }

  async prepare(context: PrepareContext): Promise<PrepareResult> {
    if (context.action.network !== BASE_NETWORK) throw new X402ChallengeError(`this executor only supports ${BASE_NETWORK}, got "${context.action.network}"`)
    if (context.action.asset.toLowerCase() !== BASE_USDC.toLowerCase()) throw new X402ChallengeError(`this executor only supports USDC (${BASE_USDC}), got "${context.action.asset}"`)
    if (!context.action.resource) throw new X402ChallengeError('action.resource (the x402 resource URL) is required to prepare a submission')

    // Provoke the 402 challenge with a plain, unauthenticated request --
    // read-only, no signing, no payment. This is the ENTIRE point of
    // prepare(): validate what we'd be agreeing to pay BEFORE any
    // authorization exists.
    const probe = await this.fetchImpl(context.action.resource)
    if (probe.status !== 402) {
      throw new X402ChallengeError(`expected HTTP 402 from ${context.action.resource}, got ${probe.status}`)
    }
    const challenge = decodeChallenge(probe)
    const atomicAmount = decimalToAtomic6(context.action.amount)
    validateChallenge(challenge, { network: context.action.network, asset: context.action.asset, amount: atomicAmount, recipient: context.action.recipient })

    const reference: X402PreparedReference = {
      resourceUrl: context.action.resource,
      network: context.action.network,
      asset: context.action.asset,
      atomicAmount,
      recipient: context.action.recipient,
    }
    return { clientSubmissionKey: context.clientSubmissionKey, reference, preparedAt: new Date().toISOString() }
  }

  async submit(prepared: PrepareResult): Promise<ExecutionResult> {
    const ref = prepared.reference as X402PreparedReference
    const client = new x402Client().register(ref.network as any, new ExactEvmScheme(this.signer))
    const payingFetch = wrapFetchWithPayment(this.fetchImpl, client)

    let res: Response
    try {
      res = await payingFetch(ref.resourceUrl)
    } catch (err: any) {
      // No response at all -- the single most dangerous case: we genuinely
      // do not know whether the facilitator ever broadcast the
      // authorization. Never retry automatically; report ambiguous.
      return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'submission-ambiguous', reason: err?.message || 'no response from resource/facilitator' }
    }

    if (res.status === 402) {
      // The payment was rejected outright (e.g. facilitator declined the
      // authorization before ever broadcasting) -- this is a DEFINITIVE
      // non-payment, safe to report as ambiguous-for-manual-review rather
      // than a silent failure, since we still can't be 100% sure nothing
      // was ever submitted on-chain by a misbehaving facilitator.
      return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'submission-ambiguous', reason: `resource still returned 402 after payment attempt (status ${res.status})` }
    }
    if (!res.ok) {
      return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'submission-ambiguous', reason: `resource returned HTTP ${res.status} after a payment attempt was made -- outcome unknown` }
    }

    const { transactionHash } = decodeSettlementResponse(res)
    if (!transactionHash) {
      // Paid successfully per the resource's own 2xx, but we couldn't parse
      // a transaction hash out of the settlement response -- still
      // ambiguous from OCD's perspective (D2.4 finalize needs the hash).
      return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'submission-ambiguous', reason: 'resource responded successfully but no transaction hash could be parsed from the settlement response' }
    }
    return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'transaction-known', transactionHash, providerReference: this.id }
  }

  async resume(prepared: PrepareResult, priorOutcome?: ExecutionResult): Promise<ExecutionResult> {
    // The only safe resume this adapter can do: if a transaction hash is
    // ALREADY known (from a prior submit() that got a response before some
    // later step failed), independently re-confirm it exists on-chain --
    // never guess a new one, never resubmit.
    if (priorOutcome?.status === 'transaction-known') {
      const client = this.injectedPublicClient ?? createPublicClient({ chain: base, transport: http(this.rpcUrl) })
      try {
        await client.getTransactionReceipt({ hash: priorOutcome.transactionHash as `0x${string}` })
        return priorOutcome
      } catch {
        // Not found (yet, or ever) -- still don't fabricate a different
        // outcome; report ambiguous so the caller keeps trying, mirroring
        // observeTransaction's own "not-found is not the same as failed".
        return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'submission-ambiguous', reason: 'previously reported transaction hash was not found on Base mainnet (may still be propagating)' }
      }
    }
    return {
      clientSubmissionKey: prepared.clientSubmissionKey,
      status: 'manual-recovery-required',
      reason: 'this executor cannot independently identify a submitted-but-unconfirmed x402 payment authorization -- check the merchant/your wallet history manually before retrying',
    }
  }
}
