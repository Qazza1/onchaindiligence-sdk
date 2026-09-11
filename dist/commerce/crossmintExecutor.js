/**
 * crossmintExecutor.ts — the one narrow CrossmintCommerceExecutor adapter (D3.4C4).
 *
 * PROVES: OCD can sit alongside Crossmint's Agent Wallets exactly the way it
 * already sits alongside Turnkey (D3.4C3) and PayBox (D2.6) -- Crossmint
 * independently custodies keys (smart-contract/account-abstraction or MPC
 * wallets, per current Crossmint docs) and sends the transfer; OCD
 * independently evaluates policy beforehand and independently observes Base
 * settlement afterward. This file never sees a Crossmint API key beyond
 * what its narrow `CrossmintClient` dependency needs, and never a wallet's
 * private key/signing material.
 *
 * CURRENT OFFICIAL CONTRACT (confirmed against docs.crossmint.com at
 * implementation time, not from memory): a wallet-transfer send returns a
 * transaction object whose `status` is one of `awaiting-approval`,
 * `pending`, `success`, or `failed` -- note this is a DIFFERENT vocabulary
 * than the webhook's own `data.status` (`succeeded`/`failed` only, see
 * onchaindiligence-mcp's providerEvidence.ts Crossmint section); this
 * module talks to the REST send/poll API and uses ITS documented values,
 * never conflating the two. `onChain.txId` is the final transaction hash
 * when present; current documentation exposes no separate UserOperation
 * hash on this response shape, so this module has nothing else to
 * distinguish it from.
 *
 * IDEMPOTENCY (a real, if incomplete, documented mechanism -- better than
 * Turnkey's or PayBox's current guarantee): Crossmint's transfer endpoint
 * accepts an `x-idempotency-key` header documented as "prevents duplicate
 * transactions." This module passes `clientSubmissionKey` as that header on
 * every attempt as defense-in-depth. It does NOT rely on this alone to
 * treat a lost-response retry as safe, because current documentation does
 * not explicitly state the header covers a crash-before-response scenario
 * specifically (only that it "prevents duplicate transactions" generally)
 * -- so the same atomic-claim-before-provider-call discipline as
 * payboxExecutor.ts/turnkeyExecutor.ts still applies, and a lost response
 * before the transfer `id` is known is still surfaced as an honest
 * ambiguity (CrossmintAmbiguousSubmitError), never silently retried. If a
 * future integration confirms the header's guarantee is strong enough to
 * retry safely, this is the one place to relax that -- not assumed here.
 *
 * BINDING STRENGTH HONESTY (same discipline as payboxExecutor.ts/
 * turnkeyExecutor.ts): this file never computes or claims a binding
 * strength -- that remains entirely server-side (onchaindiligence-mcp's
 * commerceLifecycle.ts, unmodified by D3.4C4).
 *
 * RECOVERY MODE: 'stable-payment-identity' -- once a transfer `id` exists,
 * it can be polled via the Get Transaction API indefinitely and
 * deterministically, with no risk of creating a new operation. The one
 * honest gap, mirroring TurnkeyAmbiguousSubmitError/
 * PayBoxAmbiguousPrepareError: if the transfer call is made but the process
 * dies before learning the transfer `id`, there is no stable identity to
 * resume.
 */
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { BASE_NETWORK, BASE_USDC } from './x402Executor.js';
export { BASE_NETWORK as CROSSMINT_BASE_NETWORK, BASE_USDC as CROSSMINT_BASE_USDC };
/** Volatile, single-process, TEST/EXAMPLE-ONLY implementation -- same discipline as InMemoryTurnkeyRequestStore/InMemoryPayBoxRequestStore. Does not survive a restart. */
export class InMemoryCrossmintRequestStore {
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
export class CrossmintStoreRequiredError extends Error {
    constructor() {
        super("CrossmintCommerceExecutor requires an explicit, durable `store` (CrossmintRequestStore) -- InMemoryCrossmintRequestStore is test/example-only and does not survive a restart, which would silently make this executor's advertised recoveryMode ('stable-payment-identity') false. Pass a durable implementation in production; InMemoryCrossmintRequestStore only in tests/examples.");
        this.name = 'CrossmintStoreRequiredError';
    }
}
export class CrossmintAmbiguousSubmitError extends Error {
    constructor(clientSubmissionKey) {
        super(`a prior submit() for clientSubmissionKey "${clientSubmissionKey}" called Crossmint's transfer() but this process never learned the resulting transfer id -- current Crossmint documentation does not explicitly guarantee x-idempotency-key covers this crash-before-response window, so calling transfer() again here could send a SECOND transfer for the same intended payment. Check Crossmint directly (Console or List Wallet Transfers) for an orphaned transfer tied to this payment before retrying.`);
        this.name = 'CrossmintAmbiguousSubmitError';
    }
}
export class CrossmintCommerceExecutor {
    id = 'crossmint-base-usdc';
    version = 'v1';
    recoveryMode = 'stable-payment-identity';
    crossmint;
    store;
    rpcUrl;
    injectedPublicClient;
    constructor(options) {
        if (!options.store)
            throw new CrossmintStoreRequiredError();
        this.crossmint = options.crossmint;
        this.store = options.store;
        this.rpcUrl = options.rpcUrl ?? 'https://mainnet.base.org';
        this.injectedPublicClient = options.publicClient;
    }
    /**
     * Read-only from end to end: validates the frozen action against this
     * executor's Base/USDC scope and establishes the durable submission
     * identity's INPUT (not yet a Crossmint call) -- no store write, no
     * transfer() call. Mirrors TurnkeyCommerceExecutor/PayBoxCommerceExecutor
     * gateway-mode prepare(): the actual state-changing action moves entirely
     * to submit(), called only after the orchestrator has already registered
     * the durable OCD execution binding.
     */
    async prepare(context) {
        if (context.action.network !== BASE_NETWORK)
            throw new Error(`this executor only supports ${BASE_NETWORK}, got "${context.action.network}"`);
        if (context.action.asset.toLowerCase() !== BASE_USDC.toLowerCase()) {
            throw new Error(`this executor only supports USDC (${BASE_USDC}), got "${context.action.asset}"`);
        }
        if (!context.action.sender) {
            throw new Error('action.sender is required -- the Crossmint wallet locator transfers will be sent from');
        }
        const reference = {
            transferId: null,
            tokenLocator: `base:${context.action.asset}`,
            amount: context.action.amount,
            recipient: context.action.recipient,
            walletLocator: context.action.sender,
        };
        return { clientSubmissionKey: context.clientSubmissionKey, reference, preparedAt: new Date().toISOString(), providerReference: null };
    }
    async submit(prepared) {
        const ref = prepared.reference;
        const clientSubmissionKey = prepared.clientSubmissionKey;
        const existing = await this.store.get(clientSubmissionKey);
        if (existing?.transferId) {
            // Another submit() call already established the transfer -- never
            // call transfer() again; just resolve/poll the existing one.
            return this.resolve(clientSubmissionKey, existing.transferId);
        }
        if (existing && !existing.transferId) {
            // A prior submit() claimed this slot but crashed before learning the
            // transfer id. Known, unavoidable crash window -- honest ambiguity,
            // never a guess, never a second transfer() call.
            throw new CrossmintAmbiguousSubmitError(clientSubmissionKey);
        }
        const placeholder = {
            clientSubmissionKey,
            transferId: null,
            tokenLocator: ref.tokenLocator,
            amount: ref.amount,
            recipient: ref.recipient,
            walletLocator: ref.walletLocator,
            transactionHash: null,
        };
        const { claimed, record: claimedRecord } = await this.store.claim(clientSubmissionKey, placeholder);
        if (!claimed) {
            if (claimedRecord.transferId)
                return this.resolve(clientSubmissionKey, claimedRecord.transferId);
            throw new CrossmintAmbiguousSubmitError(clientSubmissionKey);
        }
        // We won the claim -- exactly this call may proceed to Crossmint. This
        // IS Crossmint's own independent custody/approval check (the wallet's
        // own signer/approval policy is entirely Crossmint's, not OCD's).
        // clientSubmissionKey doubles as the x-idempotency-key -- defense in
        // depth (see this file's header); the atomic claim above is what this
        // adapter actually relies on.
        const result = await this.crossmint.transfer({
            walletLocator: ref.walletLocator,
            tokenLocator: ref.tokenLocator,
            recipient: ref.recipient,
            amount: ref.amount,
            idempotencyKey: clientSubmissionKey,
        });
        // Persist the transfer identity FIRST, before anything else -- this is
        // the durable identity resume()/future submit() calls key off of.
        const record = { ...claimedRecord, transferId: result.id };
        await this.store.set(record);
        return this.resolveFromResult(clientSubmissionKey, result.id, result);
    }
    /**
     * Shared by submit() (first check, right after the send) and resume()
     * (every later check) -- ONE getTransaction() poll, then an honest
     * mapping of Crossmint's current status. Neither caller loops internally;
     * a still-pending transfer returns submission-ambiguous with a retry
     * hint, and the orchestrator's own retry pattern (calling resume(), never
     * submit(), for an already-claimed identity) drives the next poll.
     */
    async resolve(clientSubmissionKey, transferId) {
        const record = await this.store.get(clientSubmissionKey);
        if (record?.transactionHash) {
            // Already resolved in a prior call -- never re-poll or re-send.
            return { clientSubmissionKey, status: 'transaction-known', transactionHash: record.transactionHash, providerReference: `crossmint:${transferId}` };
        }
        let result;
        try {
            result = await this.crossmint.getTransaction(transferId);
        }
        catch (err) {
            // getTransaction is a read-only status check -- a failure here is
            // ambiguous about Crossmint's OWN reachability, never about whether
            // the transfer itself changed state. Safe to just try again later.
            return { clientSubmissionKey, status: 'submission-ambiguous', reason: `could not reach Crossmint to check transfer ${transferId}: ${err?.message || 'no response'}`, retryAfterSeconds: 5, providerReference: `crossmint:${transferId}` };
        }
        return this.resolveFromResult(clientSubmissionKey, transferId, result);
    }
    async resolveFromResult(clientSubmissionKey, transferId, result) {
        const providerReference = `crossmint:${transferId}`;
        if (result.status === 'awaiting-approval' || result.status === 'pending') {
            return { clientSubmissionKey, status: 'submission-ambiguous', reason: `Crossmint transfer ${transferId} is ${result.status} -- poll again, do not resubmit`, retryAfterSeconds: result.status === 'awaiting-approval' ? 15 : 5, providerReference };
        }
        if (result.status === 'failed') {
            // Terminal and definitive per Crossmint's own docs: no transaction
            // ever landed onchain (or it reverted -- either way, no successful
            // payment). Mapped to manual-recovery-required, the closest of the
            // three ExecutionOutcome states to "no execution occurred" -- never
            // endlessly-retryable submission-ambiguous for a status Crossmint
            // itself calls terminal.
            return {
                clientSubmissionKey,
                status: 'manual-recovery-required',
                reason: `Crossmint reported failed for transfer ${transferId}${result.error?.message ? `: ${result.error.message}` : ''} -- no successful transfer occurred; this will not resolve differently on retry`,
                providerReference,
            };
        }
        // status === 'success': a transaction hash is expected. Whether it
        // succeeded or reverted onchain in a way OCD cares about is NOT decided
        // here -- this adapter only reports what Crossmint reports; OCD's own
        // independent Base observer (unmodified by D3.4C4) is what determines
        // the actual canonical USDC Transfer, exactly as it already does for
        // every other executor.
        const txHash = result.onChain?.txId;
        if (!txHash) {
            return {
                clientSubmissionKey,
                status: 'manual-recovery-required',
                reason: `Crossmint reported success for transfer ${transferId} but no onChain.txId was present -- check Crossmint directly before retrying`,
                providerReference,
            };
        }
        const record = await this.store.get(clientSubmissionKey);
        if (record)
            await this.store.set({ ...record, transactionHash: txHash });
        return { clientSubmissionKey, status: 'transaction-known', transactionHash: txHash, providerReference };
    }
    async resume(prepared, priorOutcome) {
        // Mirrors X402BaseUsdcExecutor/PayBoxCommerceExecutor/
        // TurnkeyCommerceExecutor's own resume(): if a transaction hash is
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
        // on resume (see payboxExecutor.ts's header for why) -- the Crossmint
        // transfer id can only be found via this adapter's OWN durable store,
        // keyed by clientSubmissionKey.
        const record = await this.store.get(prepared.clientSubmissionKey);
        if (!record || !record.transferId) {
            return {
                clientSubmissionKey: prepared.clientSubmissionKey,
                status: 'manual-recovery-required',
                reason: 'no Crossmint transfer is on record for this submission attempt -- check Crossmint directly (Console or List Wallet Transfers) before retrying',
            };
        }
        return this.resolve(prepared.clientSubmissionKey, record.transferId);
    }
}
