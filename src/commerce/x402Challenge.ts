/**
 * x402Challenge.ts — shared x402 v2 "exact" challenge helpers (D2.6).
 *
 * Extracted verbatim from x402Executor.ts (D2.5) so payboxExecutor.ts (D2.6)
 * can reuse the SAME proven challenge-decoding/validation logic instead of
 * maintaining a second copy of security-critical checks (wrong recipient,
 * wrong amount, wrong network/asset) that protect real money. Behavior is
 * byte-for-byte unchanged — see liveMerchantChallengeDecoding.test.mjs and
 * x402Executor.test.mjs, both of which exercise this code through
 * X402BaseUsdcExecutor and still pass unmodified after this extraction.
 */

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
export function base64ToUtf8(base64: string): string {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export class X402ChallengeError extends Error {}

export function decodeChallenge(res: Response): any {
  const header = res.headers.get('payment-required')
  if (!header) throw new X402ChallengeError(`${res.url}: 402 response carried no Payment-Required header`)
  try {
    return JSON.parse(base64ToUtf8(header))
  } catch {
    throw new X402ChallengeError(`${res.url}: Payment-Required header was not base64-encoded JSON`)
  }
}

/** Validates a decoded x402 v2 "exact" challenge against the frozen preflighted action. Never mutates anything; throws before any signing could occur. */
export function validateChallenge(challenge: any, expected: { network: string; asset: string; amount: string; recipient: string }): void {
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

export function decodeSettlementResponse(res: Response): { transactionHash: string | null } {
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
export function decimalToAtomic6(amount: string): string {
  const [intPart, fracPart = ''] = amount.split('.')
  if (fracPart.length > 6) throw new X402ChallengeError(`amount "${amount}" has more precision than USDC's 6 decimals support`)
  return BigInt(intPart + fracPart.padEnd(6, '0')).toString()
}
