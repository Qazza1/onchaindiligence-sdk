/**
 * @onchaindiligence/sdk/commerce
 * ------------------------------
 * The online commerce client (D2.5): open/resume a durable OCD operation,
 * evaluate preflight, execute through an independent executor, and
 * observe/finalize into a signed Commerce Receipt — without hand-assembling
 * onchaindiligence-mcp's D2.4 lifecycle machinery yourself.
 *
 *   import { createCommerceClient, MockCommerceExecutor } from '@onchaindiligence/sdk/commerce'
 *
 * Kept separate from the package's root export (the OFFLINE compliance-API
 * client + zero-network attestation verifier) — this module makes network
 * calls and requires a durable recovery store; the root export does not.
 *
 * BROWSER-SAFE by construction: everything here bundles for
 * `--platform=browser` (no Node built-ins). `NodeFileRecoveryStore` is
 * genuinely Node-only (it wraps `node:fs`) and lives at the separate
 * `@onchaindiligence/sdk/commerce/node` subpath instead — importing THIS
 * barrel from a browser bundle can never accidentally pull in `node:fs`.
 */
export * from './types.js';
export * from './results.js';
export * from './executor.js';
export * from './recoveryStore.js';
export * from './mockExecutor.js';
export * from './x402Executor.js';
export * from './payboxExecutor.js';
export * from './client.js';
export * from './policyTemplates.js';
export * from './evidenceExport.js';
