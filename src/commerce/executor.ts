/**
 * executor.ts — the CommerceExecutor contract (D2.5, Section 3).
 *
 * OCD evaluates. The executor authorizes and submits. These are DELIBERATELY
 * independent: an OCD ALLOW is a policy opinion, never a grant of wallet
 * authority, and this interface exists precisely so a developer can swap
 * wallets/providers without OCD code ever touching a private key or a
 * payment authorization it didn't need to see.
 *
 * `prepare()` MUST NOT broadcast anything — it is the point where a durable
 * execution/payment identity is created (and, in the commerce client's
 * orchestration, persisted to the recovery store and registered with OCD's
 * execution-bindings endpoint) BEFORE any state-changing network call.
 * `submit()` is called AT MOST ONCE per prepared identity by the orchestrator
 * — an executor must never invent a second identity/authorization on its
 * own initiative. `resume()` must query/resume the SAME prepared identity,
 * never fabricate a new payment.
 */

export type ExecutorRecoveryMode = 'provider-idempotent' | 'stable-payment-identity' | 'manual'

export interface PrepareContext {
  /** Opaque, caller-chosen key identifying THIS submission attempt — reused verbatim across retries of the same attempt so prepare() stays idempotent from the orchestrator's point of view. */
  clientSubmissionKey: string
  /** The exact, frozen action this execution must satisfy (from the bound PREFLIGHT receipt) — never re-negotiated by the executor. */
  action: { network: string; asset: string; amount: string; recipient: string; resource: string | null; sender: string | null }
}

export interface PrepareResult {
  clientSubmissionKey: string
  /** Executor-specific durable reference to what was prepared (e.g. a validated 402 challenge) — opaque to the orchestrator, round-tripped back into submit()/resume() unchanged. */
  reference: unknown
  preparedAt: string
}

export type ExecutionOutcome =
  | { status: 'transaction-known'; transactionHash: string; providerReference?: string | null }
  | { status: 'submission-ambiguous'; reason: string; retryAfterSeconds?: number }
  | { status: 'manual-recovery-required'; reason: string }

export type ExecutionResult = ExecutionOutcome & { clientSubmissionKey: string }

export interface CommerceExecutor {
  readonly id: string
  readonly version: string
  readonly recoveryMode: ExecutorRecoveryMode

  /** Performs executor-specific authorization/grant checks and creates the durable execution/payment identity. MUST NOT broadcast payment. */
  prepare(context: PrepareContext): Promise<PrepareResult>

  /** Submits EXACTLY the prepared payment identity. Must not generate a new authorization on retry — the orchestrator calls this at most once per prepared identity. */
  submit(prepared: PrepareResult): Promise<ExecutionResult>

  /** Queries/resumes the existing execution referenced by `prepared`. Must NEVER create a new merchant payment — if this executor's recoveryMode is 'manual' and no independent evidence exists, this must return manual-recovery-required rather than guess. */
  resume(prepared: PrepareResult, priorOutcome?: ExecutionResult): Promise<ExecutionResult>
}
