/**
 * mockExecutor.ts — a deterministic, no-network CommerceExecutor for the
 * quickstart and tests. It never touches a chain and never moves money;
 * every outcome is scripted so documentation and tests can demonstrate the
 * FULL lifecycle without a live payment, per D2.5's own mandate ("Use a
 * mocked/test executor for the normal quickstart so running documentation
 * does not cost money").
 */
import { randomBytes } from 'node:crypto'
import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js'

export type MockOutcomeScript =
  | { kind: 'success'; transactionHash?: string }
  | { kind: 'ambiguous-then-success'; transactionHash?: string }
  | { kind: 'manual-recovery' }

export interface MockExecutorOptions {
  recoveryMode?: ExecutorRecoveryMode
  /** What submit()/resume() should do. Defaults to an immediate success. */
  script?: MockOutcomeScript
}

function fakeTransactionHash(): string {
  return '0x' + randomBytes(32).toString('hex')
}

/**
 * A minimal, fully in-memory executor. `prepare()` just records the frozen
 * action; `submit()` follows the configured script exactly once; `resume()`
 * only ever returns what submit() already committed to (or manual recovery,
 * for a 'manual' script) — it never invents a new outcome.
 */
export class MockCommerceExecutor implements CommerceExecutor {
  readonly id = 'mock-executor'
  readonly version = 'v1'
  readonly recoveryMode: ExecutorRecoveryMode
  private readonly script: MockOutcomeScript
  private readonly submittedOnce = new Set<string>()
  private readonly outcomes = new Map<string, ExecutionResult>()

  constructor(options: MockExecutorOptions = {}) {
    this.recoveryMode = options.recoveryMode ?? 'stable-payment-identity'
    this.script = options.script ?? { kind: 'success' }
  }

  async prepare(context: PrepareContext): Promise<PrepareResult> {
    return { clientSubmissionKey: context.clientSubmissionKey, reference: { action: context.action }, preparedAt: new Date().toISOString() }
  }

  async submit(prepared: PrepareResult): Promise<ExecutionResult> {
    const key = prepared.clientSubmissionKey
    if (this.submittedOnce.has(key)) {
      // An orchestrator bug would be the only way to reach this twice for
      // the same key -- report it as ambiguous rather than silently
      // fabricating a second transaction, exactly what a real executor must do.
      return { clientSubmissionKey: key, status: 'submission-ambiguous', reason: 'submit() called twice for the same clientSubmissionKey' }
    }
    this.submittedOnce.add(key)

    if (this.script.kind === 'manual-recovery') {
      const outcome: ExecutionResult = { clientSubmissionKey: key, status: 'manual-recovery-required', reason: 'mock script: no safe recovery identity' }
      this.outcomes.set(key, outcome)
      return outcome
    }
    if (this.script.kind === 'ambiguous-then-success') {
      const outcome: ExecutionResult = { clientSubmissionKey: key, status: 'submission-ambiguous', reason: 'mock script: simulated lost response after submission' }
      this.outcomes.set(key, outcome)
      return outcome
    }
    const outcome: ExecutionResult = {
      clientSubmissionKey: key,
      status: 'transaction-known',
      transactionHash: this.script.transactionHash ?? fakeTransactionHash(),
      providerReference: this.id,
    }
    this.outcomes.set(key, outcome)
    return outcome
  }

  async resume(prepared: PrepareResult): Promise<ExecutionResult> {
    const key = prepared.clientSubmissionKey
    const prior = this.outcomes.get(key)
    if (prior?.status === 'submission-ambiguous' && this.script.kind === 'ambiguous-then-success') {
      // The scripted "resolves on resume" case -- mirrors a real executor
      // that can now confirm what actually happened, e.g. a chain lookup.
      const resolved: ExecutionResult = {
        clientSubmissionKey: key,
        status: 'transaction-known',
        transactionHash: this.script.transactionHash ?? fakeTransactionHash(),
        providerReference: this.id,
      }
      this.outcomes.set(key, resolved)
      return resolved
    }
    if (prior) return prior
    return { clientSubmissionKey: key, status: 'manual-recovery-required', reason: 'resume() called before submit() ever ran for this identity' }
  }
}
