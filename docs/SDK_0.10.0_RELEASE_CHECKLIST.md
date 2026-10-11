# SDK 0.10.0 release preparation

Status: **candidate source only — NOT published by this PR**.

## Contents

- Explicit opt-in `preflightMode: 'free'` for authenticated workspace-owned lifecycle preflights, Base USDC and Solana mainnet USDC.
- Free path uses `POST /operations/{id}/preflight/free`, persists the selected fee mode and operation recovery before evaluation, and **never falls back** to paid x402 on timeout, disabled route, 402 or allowance exhaustion.
- Existing `preflightMode: 'paid'` remains the default. Merchant purchases still require caller-controlled signing and funds.
- Verifiable receipts convey signing integrity; they do not alone prove onchain settlement, legitimate authorization, or fulfilment.

## Before public npm publication (separate explicit owner approval)

1. Confirm current `main` includes free-mode SDK PR #17 at merge SHA `a03f3155e6fa04a76e308401747bd6d18f5007db`.
2. Confirm manifest and lockfile versions both read `0.10.0`; no unrelated dependency changes.
3. Verify GitHub CI, typecheck, `npm test`, TypeScript examples, secret scan, and a clean consumer `npm pack --dry-run` and installed-package import of `@onchaindiligence/sdk/commerce`.
4. Confirm the registry does not already contain `@onchaindiligence/sdk@0.10.0` and publisher ownership/2FA are available. Do not generate or expose an npm credential in code or logs.
5. Inspect the exact packed artifact (dist, exports, types, LICENSE, conformance), omit .env/credentials and development data, and verify the SHA-256 of the candidate tarball.
6. Request separate explicit authorization before **publishing**. After approval, publish the exact reviewed artifact and verify the registry install, version, imports, and dist-tags.
7. Only after the SDK is published, reconcile MCP PR #58's stale `0.2.0-rc.0` release prep with merged Auto-Evidence PR #61; pin an appropriate SDK dependency, regenerate lockfile, recheck packed installs/optional Solana peer behavior, and request separate publication authorization for the proxy.

## Important deployment distinction

The free-preflight server code is merged, but `OCD_FREE_PREFLIGHT_ENABLED` remains disabled until a separate production database migration and activation are approved. Installing SDK 0.10.0 by itself does **not** grant 100 free signed preflights or activate a free trial. Until rollout, a free-mode request receives `free_preflight_disabled`; the client must not silently pay the existing Base x402 fee instead.

Production database project indicated by Vercel `NEON_PROJECT_ID` metadata: `little-flower-28931530`. The earlier SQL contention test ran on a different, isolated project `wispy-band-54116432` and is not proof the actual production schema is migrated. Do not apply migrations without a scoped production credential and explicit approval.
