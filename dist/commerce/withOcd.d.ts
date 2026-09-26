/**
 * Thin x402 v2 wrapper: preserve the caller's signer/client, while inserting
 * OCD's existing commerce lifecycle before payload creation and after the
 * merchant's settlement response.  It deliberately does not wrap fetch or
 * mutate a Response.
 */
import type { x402Client } from '@x402/core/client';
import { type CommerceRecoveryStore } from './recoveryStore.js';
import type { CommercePolicy, ReceiptDecision, ReceiptEnvelope } from './types.js';
/** Alias kept intentionally small: the wrapper accepts the existing commerce policy wire contract. */
export type Policy = CommercePolicy;
export type OcdResult = {
    kind: 'full-lifecycle';
    receipt: ReceiptEnvelope;
    operationId: string;
} | {
    kind: 'post-payment-evidence';
    receipt: ReceiptEnvelope;
} | {
    kind: 'blocked';
    decision: ReceiptDecision;
} | {
    kind: 'no-receipt';
    reason: string;
    operationId?: string;
};
export interface WithOcdOptions {
    policy: Policy;
    onReceipt: (result: OcdResult) => void | Promise<void>;
    /** Volatile by default. Supply durable storage for any restart/serverless recovery path. */
    store?: CommerceRecoveryStore;
    onOcdUnavailable?: 'abort' | 'proceed';
    baseUrl?: string;
}
export declare class OcdPaymentPolicyError extends Error {
    constructor(message: string);
}
/**
 * Registers OCD lifecycle hooks on an existing x402 v2 client and returns the
 * same client. The caller retains all wallet/signer ownership.
 *
 * v1 is intentionally untouched: v1 does not provide the required v2 hook
 * correlation, so this wrapper never fabricates OCD evidence for it.
 */
export declare function withOcd(client: x402Client, options: WithOcdOptions): x402Client;
