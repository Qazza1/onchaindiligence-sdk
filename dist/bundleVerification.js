/**
 * Portable Agent Evidence bundle verification.
 *
 * This is deliberately a thin, zero-network delegation to the protocol
 * package. The caller supplies trust; this SDK never discovers keys or falls
 * back to an OCD service.
 */
import { TrustPolicy, verifyBundle, } from '@onchaindiligence/agent-evidence';
/**
 * Verify a portable signed bundle using only caller-supplied public keys.
 * `VALID` means cryptographic integrity under that trust policy; it does not
 * establish authorization, safety, settlement, delivery, or truth.
 */
export function verifyBundleOffline(bundle, trust, options = {}) {
    const policy = trust instanceof TrustPolicy ? trust : TrustPolicy.fromKeyRecords(trust, options);
    return verifyBundle(bundle, policy);
}
