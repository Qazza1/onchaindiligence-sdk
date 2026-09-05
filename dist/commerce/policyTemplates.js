export const POLICY_TEMPLATE_VERSION = 'onchaindiligence.policy-template.v1';
/** A. Bounded API purchase: caps amount, network, and asset; no recipient/origin restriction. */
export function apiPurchasePolicy(params) {
    return {
        policy: {
            max_amount: params.maxAmount,
            allowed_networks: [params.allowedNetwork],
            allowed_assets: [params.allowedAsset],
            expected_recipient: null,
            allowed_resource_origins: null,
        },
        templateVersion: POLICY_TEMPLATE_VERSION,
        templateName: 'bounded-api-purchase',
    };
}
/**
 * B. Approval required above threshold: this template alone cannot express
 * "ALLOW below X, REQUIRE_APPROVAL above X" as a single policy object — OCD
 * policy evaluation is FAIL-closed on max_amount (exceeding it is BLOCK, not
 * REQUIRE_APPROVAL; see onchaindiligence-mcp's evaluatePreflightPolicy). This
 * helper instead returns the policy to use for the "approval" tier: no
 * amount cap at all (acknowledged explicitly), so amount-based judgment is
 * left entirely to whatever separate human/approval process the developer's
 * own application wires up above OCD -- OCD's role stays what it always is
 * (policy evaluation), never a stand-in for that approval step.
 */
export function approvalAboveThresholdPolicy(params) {
    return {
        policy: {
            max_amount: null,
            allowed_networks: [params.allowedNetwork],
            allowed_assets: [params.allowedAsset],
            expected_recipient: params.expectedRecipient ?? null,
            allowed_resource_origins: null,
            acknowledge_unconstrained: true,
        },
        templateVersion: POLICY_TEMPLATE_VERSION,
        templateName: 'approval-above-threshold',
    };
}
/** C. Fixed-recipient bounded payment: caps amount AND pins the exact recipient — the tightest of the three templates. */
export function fixedRecipientPolicy(params) {
    return {
        policy: {
            max_amount: params.maxAmount,
            allowed_networks: [params.allowedNetwork],
            allowed_assets: [params.allowedAsset],
            expected_recipient: params.expectedRecipient,
            allowed_resource_origins: null,
        },
        templateVersion: POLICY_TEMPLATE_VERSION,
        templateName: 'fixed-recipient-bounded-payment',
    };
}
