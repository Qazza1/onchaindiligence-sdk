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
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { BASE_NETWORK, BASE_USDC } from './x402Executor.js';
import { decimalToAtomic6 } from './x402Challenge.js';
export { BASE_NETWORK as CDP_BASE_NETWORK, BASE_USDC as CDP_BASE_USDC };
export class CdpSendError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.name = 'CdpSendError';
        this.code = code;
    }
}
/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation. Does not survive a restart. */
export class InMemoryCdpRequestStore {
    records = new Map();
    async get(clientSubmissionKey) {
        return this.records.get(clientSubmissionKey) ?? null;
    }
    async set(record) {
        this.records.set(record.clientSubmissionKey, { ...record });
    }
    async claim(clientSubmissionKey, placeholder) {
        const existing = this.records.get(clientSubmissionKey);
        if (existing)
            return { claimed: false, record: { ...existing } };
        const stored = { ...placeholder };
        this.records.set(clientSubmissionKey, stored);
        return { claimed: true, record: { ...stored } };
    }
}
export class CdpStoreRequiredError extends Error {
    constructor() {
        super("CdpCommerceExecutor requires an explicit, durable `store` (CdpRequestStore) -- InMemoryCdpRequestStore is test/example-only and does not survive a restart, which would silently make this executor's advertised recoveryMode ('stable-payment-identity') false. Pass a durable implementation in production; InMemoryCdpRequestStore only in tests/examples.");
        this.name = 'CdpStoreRequiredError';
    }
}
export class CdpAmbiguousSubmitError extends Error {
    constructor(clientSubmissionKey, idempotencyKey) {
        super(`a prior submit() for clientSubmissionKey "${clientSubmissionKey}" called CDP's sendTransaction() but this process never learned the result -- check CDP directly (dashboard or Get Transaction) for an orphaned send tied to this payment before retrying. Unlike this project's other provider adapters, CDP's own documentation states that a request retried with the SAME X-Idempotency-Key ("${idempotencyKey}") returns an identical response rather than creating a duplicate transaction -- a manual retry using that exact key is expected to be safe per CDP's documented contract, even though this code does not attempt it automatically.`);
        this.name = 'CdpAmbiguousSubmitError';
    }
}
export class CdpCommerceExecutor {
    id = 'cdp-base-usdc';
    version = 'v1';
    recoveryMode = 'stable-payment-identity';
    cdp;
    store;
    rpcUrl;
    injectedPublicClient;
    constructor(options) {
        if (!options.store)
            throw new CdpStoreRequiredError();
        this.cdp = options.cdp;
        this.store = options.store;
        this.rpcUrl = options.rpcUrl ?? 'https://mainnet.base.org';
        this.injectedPublicClient = options.publicClient;
    }
    /** Read-only: validates the frozen action against this executor's Base/USDC scope. No CDP call. */
    async prepare(context) {
        if (context.action.network !== BASE_NETWORK)
            throw new Error(`this executor only supports ${BASE_NETWORK}, got "${context.action.network}"`);
        if (context.action.asset.toLowerCase() !== BASE_USDC.toLowerCase()) {
            throw new Error(`this executor only supports USDC (${BASE_USDC}), got "${context.action.asset}"`);
        }
        if (!context.action.sender) {
            throw new Error('action.sender is required -- the CDP server wallet EVM account address to send from');
        }
        const reference = {
            atomicAmount: decimalToAtomic6(context.action.amount),
            recipient: context.action.recipient,
            from: context.action.sender,
        };
        return { clientSubmissionKey: context.clientSubmissionKey, reference, preparedAt: new Date().toISOString(), providerReference: null };
    }
    async submit(prepared) {
        const ref = prepared.reference;
        const clientSubmissionKey = prepared.clientSubmissionKey;
        const existing = await this.store.get(clientSubmissionKey);
        if (existing?.transactionHash)
            return this.finalOutcome(clientSubmissionKey, existing);
        if (existing?.failed)
            return this.finalOutcome(clientSubmissionKey, existing);
        if (existing) {
            // Claimed but neither a hash nor a definitive failure is on record --
            // the known, unavoidable crash window. Never a second sendTransaction() call.
            throw new CdpAmbiguousSubmitError(clientSubmissionKey, clientSubmissionKey);
        }
        const placeholder = { clientSubmissionKey, network: BASE_NETWORK, atomicAmount: ref.atomicAmount, recipient: ref.recipient, from: ref.from, transactionHash: null, failed: null };
        const { claimed, record: claimedRecord } = await this.store.claim(clientSubmissionKey, placeholder);
        if (!claimed) {
            if (claimedRecord.transactionHash || claimedRecord.failed)
                return this.finalOutcome(clientSubmissionKey, claimedRecord);
            throw new CdpAmbiguousSubmitError(clientSubmissionKey, clientSubmissionKey);
        }
        // We won the claim -- exactly this call may proceed to CDP. This IS
        // CDP's own independent custody/policy check (the server wallet's
        // signing authority and any CDP-side policy engine rules are entirely
        // CDP's, not OCD's).
        let result;
        try {
            result = await this.cdp.sendTransaction({ address: ref.from, to: ref.recipient, value: ref.atomicAmount, network: 'base', idempotencyKey: clientSubmissionKey });
        }
        catch (err) {
            // Terminal and definitive: CDP itself rejected the send before ever
            // broadcasting (e.g. insufficient funds, policy denial). No merchant
            // payment occurred. Persisted BEFORE returning so this never
            // re-attempts sendTransaction on a later call.
            const code = err instanceof CdpSendError ? err.code : null;
            const message = err instanceof Error ? err.message : String(err);
            const record = { ...claimedRecord, failed: { code, message } };
            await this.store.set(record);
            return this.finalOutcome(clientSubmissionKey, record);
        }
        if (!result.transactionHash) {
            // CDP's own documented shape for this call always populates
            // transactionHash for an EOA account send that succeeded -- an
            // empty success response is inconsistent, not a case to guess about.
            const record = { ...claimedRecord, failed: { code: 'MISSING_TRANSACTION_HASH', message: 'CDP sendTransaction succeeded but returned no transactionHash (and no userOpHash is expected/supported by this EOA-only adapter)' } };
            await this.store.set(record);
            return this.finalOutcome(clientSubmissionKey, record);
        }
        const record = { ...claimedRecord, transactionHash: result.transactionHash };
        await this.store.set(record);
        return this.finalOutcome(clientSubmissionKey, record);
    }
    finalOutcome(clientSubmissionKey, record) {
        if (record.transactionHash) {
            const providerReference = `cdp:${record.transactionHash}`;
            const providerEvidence = {
                provider: 'cdp',
                providerVersion: this.version,
                payload: { status: 'success', transaction_hash: record.transactionHash, network: 'base', idempotency_key: clientSubmissionKey },
            };
            return { clientSubmissionKey, status: 'transaction-known', transactionHash: record.transactionHash, providerReference, providerEvidence };
        }
        // record.failed is guaranteed set here (finalOutcome is only called once one or the other is true).
        const failed = record.failed;
        const providerReference = `cdp:${clientSubmissionKey}`;
        const providerEvidence = {
            provider: 'cdp',
            providerVersion: this.version,
            payload: { status: 'failed', network: 'base', idempotency_key: clientSubmissionKey, error: { code: failed.code, message: failed.message } },
        };
        return {
            clientSubmissionKey,
            status: 'manual-recovery-required',
            reason: `CDP sendTransaction failed${failed.code ? ` (${failed.code})` : ''}: ${failed.message} -- no transaction was broadcast; this will not resolve differently on retry`,
            providerReference,
            providerEvidence,
        };
    }
    async resume(prepared, priorOutcome) {
        // Mirrors every other adapter's own resume(): if a transaction hash is
        // ALREADY known from a prior call, independently re-confirm it
        // read-only on-chain -- never guess a new one, never re-send.
        if (priorOutcome?.status === 'transaction-known') {
            const client = this.injectedPublicClient ?? createPublicClient({ chain: base, transport: http(this.rpcUrl) });
            try {
                await client.getTransactionReceipt({ hash: priorOutcome.transactionHash });
                return priorOutcome;
            }
            catch {
                return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'submission-ambiguous', reason: 'previously reported transaction hash was not found on Base mainnet (may still be propagating)' };
            }
        }
        // The orchestrator reconstructs a GENERIC `prepared.reference = { action }`
        // on resume (see payboxExecutor.ts's header for why) -- this adapter's
        // own record can only be found via its durable store, keyed by
        // clientSubmissionKey.
        const record = await this.store.get(prepared.clientSubmissionKey);
        if (!record || (!record.transactionHash && !record.failed)) {
            return {
                clientSubmissionKey: prepared.clientSubmissionKey,
                status: 'manual-recovery-required',
                reason: 'no CDP send result is on record for this submission attempt -- check CDP directly (dashboard or Get Transaction) before retrying',
            };
        }
        return this.finalOutcome(prepared.clientSubmissionKey, record);
    }
}
