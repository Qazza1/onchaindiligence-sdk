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
export declare function base64ToUtf8(base64: string): string;
export declare class X402ChallengeError extends Error {
}
export declare function decodeChallenge(res: Response): any;
/** Validates a decoded x402 v2 "exact" challenge against the frozen preflighted action. Never mutates anything; throws before any signing could occur. */
export declare function validateChallenge(challenge: any, expected: {
    network: string;
    asset: string;
    amount: string;
    recipient: string;
}): void;
export declare function decodeSettlementResponse(res: Response): {
    transactionHash: string | null;
};
/**
 * Converts a canonical decimal amount (e.g. "1.00") into USDC's 6-decimal
 * atomic unit string, WITHOUT floating point — mirrors
 * onchaindiligence-mcp's src/money.ts exactly (kept independent here since
 * this package does not depend on that server-side module).
 */
export declare function decimalToAtomic6(amount: string): string;
