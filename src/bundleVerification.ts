/**
 * Portable Agent Evidence bundle verification.
 *
 * This is deliberately a thin, zero-network delegation to the protocol
 * package. The caller supplies trust; this SDK never discovers keys or falls
 * back to an OCD service.
 */
import {
  TrustPolicy,
  verifyBundle,
  type AttestationKeyRecord,
  type PortableBundle,
  type TrustPolicyOptions,
  type VerificationReport,
} from '@onchaindiligence/agent-evidence'

export type OfflineBundleTrust = TrustPolicy | readonly AttestationKeyRecord[]
export type OfflineBundleVerificationOptions = TrustPolicyOptions
export type OfflineBundleVerificationReport = VerificationReport

/**
 * Verify a portable signed bundle using only caller-supplied public keys.
 * `VALID` means cryptographic integrity under that trust policy; it does not
 * establish authorization, safety, settlement, delivery, or truth.
 */
export function verifyBundleOffline(
  bundle: string | Uint8Array | PortableBundle | Record<string, unknown>,
  trust: OfflineBundleTrust,
  options: OfflineBundleVerificationOptions = {},
): OfflineBundleVerificationReport {
  const policy = trust instanceof TrustPolicy ? trust : TrustPolicy.fromKeyRecords(trust, options)
  return verifyBundle(bundle, policy)
}
