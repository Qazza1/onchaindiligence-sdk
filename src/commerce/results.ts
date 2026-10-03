/**
 * results.ts — discriminated unions for every lifecycle outcome (D2.5,
 * Section 2). Ordinary lifecycle states are never thrown as exceptions —
 * only genuinely exceptional conditions (bad input, a network the caller
 * cannot reasonably plan around) do. `receipt-produced` deliberately does
 * NOT mean "payment succeeded": the receipt may describe a confirmed
 * payment, a failed execution, a mismatch, or an uncertain observation —
 * read `receipt.receipt.execution.status` / `.settlement.status` /
 * `.decision.status`, never infer success from a receipt merely existing.
 */
import type { ReceiptEnvelope, OperationStatus } from './types.js'
import type { ExecutionResult } from './executor.js'

/** Shared shape for every non-terminal "come back later" outcome. */
export interface PendingInfo {
  /** Where in the lifecycle this operation currently sits. */
  phase: 'preflight-in-progress' | 'awaiting-execution' | 'execution-ambiguous' | 'awaiting-observation' | 'observation-pending'
  /** What the caller should do next, in plain language a UI can show directly. */
  safeNextAction: string
  /** Seconds to wait before retrying, when known. */
  retryAfterSeconds?: number
  /** True whenever OCD's fee (or, for execution, the merchant payment) may already have been taken — the caller must NEVER treat this as "safe to pay again". */
  mayAlreadyHavePaid: boolean
  operationId: string
  executionRequestId?: string | null
}

export type PreflightEvaluation =
  // Deliberately does NOT carry the raw finalization capability token --
  // that stays internal to the client's recovery record (observeAndFinalize()
  // reads it directly) so this result is always safe to log/serialize
  // without leaking a bearer secret (D2.5 Section 15 test #18).
  | { kind: 'ready'; operationId: string; receipt: ReceiptEnvelope; capabilityExpiresAt: string }
  | { kind: 'blocked'; operationId: string; receipt: ReceiptEnvelope; reasons: string[] }
  | { kind: 'approval-required'; operationId: string; receipt: ReceiptEnvelope; reasons: string[] }
  | ({ kind: 'pending' } & PendingInfo)
  | { kind: 'terminal-error'; operationId: string; error: string }

export type ExecutionRecord =
  | { kind: 'execution-recorded'; operationId: string; executionRequestId: string; transactionHash: string; providerReference?: string | null }
  | { kind: 'manual-recovery-required'; operationId: string; executionRequestId: string; reason: string }
  | ({ kind: 'pending' } & PendingInfo)
  | { kind: 'terminal-error'; operationId: string; error: string }

export type FinalizeResult =
  | {
      kind: 'receipt-produced'
      operationId: string
      receipt: ReceiptEnvelope
      evidence: { bundle_digest: string; binding_strength: 'TRANSFER_MATCH_ONLY' | 'EXECUTOR_CORRELATED' | 'PAYMENT_IDENTITY_LINKED' } | null
    }
  | ({ kind: 'pending' } & PendingInfo)
  | { kind: 'terminal-error'; operationId: string; error: string }

export type ResumeResult =
  | { kind: 'resumed'; operationId: string; status: OperationStatus }
  | { kind: 'recovery-failed'; reason: string }

/**
 * Input for OnchainDiligenceCommerceClient.observePayment(): a payment that
 * already happened, identified by network + transaction reference. `expected`
 * values are caller assertions only -- OCD compares them against its own chain
 * observation and never uses them as evidence.
 */
export interface ObservePaymentParams {
  /**
   * OCD settlement network, validated by the server (not by this client): 'eip155:8453' (Base USDC), 'eip155:1' (Ethereum USDC),
   * 'eip155:4217' (Tempo pathUSD), 'eip155:5042' (Arc USDC, observation only) or 'solana:mainnet' (Solana USDC).
   */
  network: string
  /** EVM transaction hash, or Solana transaction signature. */
  transactionReference: string
  expected?: { recipient?: string; asset?: string; amount?: string }
}

/**
 * Outcome of observePayment(). `receipt` is a signed, observation-only Public
 * Action Receipt: its decision is UNKNOWN and it makes no authorization claim;
 * read `settlement.status`, never infer success from a receipt merely existing.
 * `pending` means no receipt was issued yet and nothing about the payment was
 * concluded -- it is not a failure.
 */
export type ObservePaymentResult =
  | { kind: 'receipt'; receipt: ReceiptEnvelope; existing: boolean }
  | { kind: 'pending'; reason: 'transaction-not-found' | 'insufficient-confirmations' | 'observation-unavailable' | 'rate-limited'; message: string; retryAfterSeconds: number | null }
  | { kind: 'rejected'; message: string }

export function pending(operationId: string, info: Omit<PendingInfo, 'operationId'>): { kind: 'pending' } & PendingInfo {
  return { kind: 'pending', operationId, ...info }
}
