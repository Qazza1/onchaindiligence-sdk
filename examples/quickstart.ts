/**
 * quickstart.ts — the canonical OnChainDiligence commerce integration.
 *
 * Run with: npx tsx examples/quickstart.ts
 *
 * Uses a MOCKED executor (never touches a chain, never moves money) so this
 * file is safe to run as documentation. To pay for real, swap
 * MockCommerceExecutor for X402BaseUsdcExecutor with a real funded viem
 * Account — nothing else in this file changes.
 *
 * This is the ~20-line integration the SDK exists to make possible:
 *
 *   configure -> policy -> open -> preflight -> respect the decision ->
 *   executor authorizes independently -> submit once -> resume if needed ->
 *   observe/finalize -> verify -> export evidence
 *
 * What this DOESN'T hide, on purpose:
 *   - OCD evaluates (preflight). It never authorizes payment.
 *   - The executor authorizes and submits. OCD never holds a key.
 *   - Ambiguous outcomes are surfaced as `pending`, not silently retried.
 *   - "The model remembered to call this" is never the security boundary --
 *     this script is application code, not a tool the agent could skip.
 */
import { createCommerceClient, InMemoryRecoveryStore, MockCommerceExecutor, apiPurchasePolicy, buildEvidenceExport } from '../src/commerce/index.js'
import { createDemoFetch } from './demoServer.js'

async function main() {
  // 1. Configure OCD. A real app should use a durable store (see
  //    NodeFileRecoveryStore, or implement CommerceRecoveryStore against
  //    your own database) -- InMemoryRecoveryStore is test/demo-only and
  //    does NOT survive a restart.
  //
  //    `fetch: createDemoFetch()` points this quickstart at an in-process
  //    demo server (examples/demoServer.ts) so the WHOLE lifecycle below
  //    completes for free, deterministically, with no live network call.
  //    For a real integration: delete the `fetch` line entirely (the
  //    client then talks to the real https://mcp.onchaindiligence.com),
  //    and swap MockCommerceExecutor below for X402BaseUsdcExecutor with a
  //    real funded viem Account -- preflight becomes a real $0.01 payment.
  const ocd = createCommerceClient({
    recovery: new InMemoryRecoveryStore(),
    fetch: createDemoFetch(),
  })

  // 2. Configure policy -- a starter template, not hand-rolled JSON.
  const { policy } = apiPurchasePolicy({
    maxAmount: '1.00',
    allowedNetwork: 'eip155:8453',
    allowedAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
  })

  // 3. Open a durable operation for ONE intended payment.
  const op = await ocd.open({
    intent: 'quickstart demo purchase',
    action: {
      kind: 'PAYMENT',
      resource: 'https://service.example/api/thing',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '0.50',
      sender: null,
      recipient: '0x000000000000000000000000000000000000dEaD',
    },
    policy,
  })
  console.log(`opened operation ${op.operationId}`)

  // 4. Preflight -- OCD evaluates. This call is itself paid ($0.01) and,
  //    unlike the legacy route, safely resumable: a lost response here can
  //    be retried with zero risk of a second charge.
  const evaluation = await op.preflight()

  // 5. Respect the decision. This branch IS the enforcement boundary --
  //    move it into your own application code, don't skip it.
  if (evaluation.kind === 'blocked') {
    console.log('BLOCKED:', evaluation.reasons)
    return
  }
  if (evaluation.kind === 'approval-required') {
    console.log('Needs human approval:', evaluation.reasons)
    return // a real app would route this to its own approval workflow
  }
  if (evaluation.kind === 'pending') {
    console.log('Preflight is still settling — retry shortly:', evaluation.safeNextAction)
    return
  }
  if (evaluation.kind === 'terminal-error') {
    console.error('Preflight failed:', evaluation.error)
    return
  }
  console.log('ALLOW — proceeding. Receipt:', evaluation.receipt.receipt.receipt_id)

  // 6/7. The executor independently authorizes AND submits. OCD's ALLOW is
  //    a policy opinion, never a grant of wallet authority -- the executor
  //    is what actually moves money, and it does so exactly once.
  const executor = new MockCommerceExecutor() // swap for X402BaseUsdcExecutor for a real payment
  const execution = await op.execute({ executor })

  if (execution.kind === 'pending') {
    console.log('Execution outcome is ambiguous:', execution.safeNextAction)
    // A real app persists here and calls op.execute() again later -- it
    // will call executor.resume(), never submit() a second time.
    return
  }
  if (execution.kind === 'manual-recovery-required') {
    console.log('Manual recovery required:', execution.reason)
    return
  }
  if (execution.kind === 'terminal-error') {
    console.error('Execution failed:', execution.error)
    return
  }
  console.log('Execution recorded, tx:', execution.transactionHash)

  // 8. Observe/finalize -- independently confirms settlement and produces
  //    the signed Commerce Receipt. Safe to retry if pending.
  let result = await op.observeAndFinalize()
  while (result.kind === 'pending') {
    console.log('Observation pending:', result.safeNextAction)
    result = await op.observeAndFinalize() // a real app would wait retryAfterSeconds first
  }
  if (result.kind === 'terminal-error') {
    console.error('Finalize failed:', result.error)
    return
  }
  console.log('Receipt produced:', result.receipt.receipt.receipt_id, '— execution:', result.receipt.receipt.execution.status)

  // 9. Verify -- a receipt existing is not the same as a receipt proving
  //    what you think it proves. Always check execution/settlement fields,
  //    never infer success from "a receipt exists".
  const verification = await ocd.verifyReceipt(result.receipt)
  console.log('Verification:', verification.state, verification.code)

  // 10. Export evidence -- a minimal, deterministic, secret-free manifest.
  const manifest = await buildEvidenceExport({
    operationId: op.operationId,
    commerceReceipt: result.receipt,
    lifecycleEvidence: result.evidence,
  })
  console.log('Evidence manifest digest:', manifest.manifest_digest)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
