/** Regression test for a confirmed live D2.5A defect: registering an
 * execution binding for the real x402 executor failed with
 *
 *   failed to register execution binding: recovery_capability_class must
 *   be one of: provider-idempotent, stable-payment-identity, none
 *
 * Root cause: CommerceExecutor's public `recoveryMode` vocabulary
 * ('provider-idempotent' | 'stable-payment-identity' | 'manual') and D2.4's
 * persisted `recovery_capability_class` column ('provider-idempotent' |
 * 'stable-payment-identity' | 'none') name the SAME third state with
 * different words -- the executor-facing API says 'manual' (no automatic
 * recovery capability exists; a human must look), the server's own enum
 * says 'none' (neither of the two capability classes applies). Both carry
 * the identical consequence: an ambiguous outcome for that binding MUST
 * resolve to 'manual-recovery-required', never a silent resubmission (see
 * onchaindiligence-mcp's executionBinding.ts header). client.ts sent
 * `executor.recoveryMode` verbatim as `recovery_capability_class`, so any
 * executor honestly reporting 'manual' (X402BaseUsdcExecutor always does)
 * could never register a binding at all.
 *
 * test/fakeServer.mjs did not catch this because it accepted whatever
 * `recovery_capability_class` value it was given -- it now validates
 * against the real enum (see its own comment), which is what makes these
 * tests actually exercise the real contract instead of a looser stand-in.
 *
 * Run with: npm test (builds, then node --test test/*.test.mjs)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommerceClient, InMemoryRecoveryStore, MockCommerceExecutor } from '../dist/commerce/index.js'
import { createFakeServer } from './fakeServer.mjs'

const ACTION = {
  kind: 'PAYMENT',
  resource: 'https://service.example/api',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '1.00',
  sender: null,
  recipient: '0x000000000000000000000000000000000000dEaD',
}
const POLICY = { max_amount: '5.00', allowed_networks: null, allowed_assets: null, expected_recipient: null, allowed_resource_origins: null }

/**
 * Mirrors X402BaseUsdcExecutor's own real resume() logic exactly (see its
 * header: "RECOVERY MODE IS HONESTLY 'manual' ... reporting 'manual'
 * honestly ... is the correct choice over pretending a recovery guarantee
 * this code cannot actually back up"): submit() can go ambiguous, and
 * resume() -- having no independent way to identify what happened -- must
 * report manual-recovery-required rather than ever guessing or resubmitting.
 * Not MockCommerceExecutor's 'ambiguous-then-success' script, which
 * deliberately models the OPPOSITE (a resume that DOES resolve) -- the
 * scenario under test here needs a resume that honestly does not.
 */
class HonestlyStuckManualExecutor {
  id = 'test-manual-executor'
  version = 'v1'
  recoveryMode = 'manual'
  submitCallCount = 0

  async prepare(context) {
    return { clientSubmissionKey: context.clientSubmissionKey, reference: { action: context.action }, preparedAt: new Date().toISOString() }
  }

  async submit(prepared) {
    this.submitCallCount++
    return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'submission-ambiguous', reason: 'test: simulated lost response, no independent recovery identity' }
  }

  async resume(prepared) {
    return { clientSubmissionKey: prepared.clientSubmissionKey, status: 'manual-recovery-required', reason: 'test: this executor cannot independently identify a submitted-but-unconfirmed payment' }
  }
}

test("manual executor: binding registers (maps to server 'none'), never 400s", async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: ACTION, policy: POLICY })
  const evaluation = await op.preflight()
  assert.equal(evaluation.kind, 'ready')

  const executor = new HonestlyStuckManualExecutor()
  const execution = await op.execute({ executor })
  assert.notEqual(execution.kind, 'terminal-error', `execute() must not fail to register the binding: ${execution.error ?? ''}`)
})

test('manual executor: an ambiguous submit resolves to manual-recovery-required on retry, and submit() is never called a second time', async () => {
  const server = createFakeServer()
  const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
  const op = await client.open({ action: ACTION, policy: POLICY })
  const evaluation = await op.preflight()
  assert.equal(evaluation.kind, 'ready')

  const executor = new HonestlyStuckManualExecutor()

  const first = await op.execute({ executor })
  assert.equal(first.kind, 'pending', 'a fresh ambiguous submit must surface as pending, not a fabricated failure or success')
  assert.equal(first.phase, 'execution-ambiguous')
  assert.equal(executor.submitCallCount, 1)

  // The caller follows safeNextAction and calls execute() again -- this
  // must invoke executor.resume(), never executor.submit() a second time.
  const second = await op.execute({ executor })
  assert.equal(second.kind, 'manual-recovery-required', 'an executor with no independent recovery identity must end at manual-recovery-required, never a guessed outcome')
  assert.equal(executor.submitCallCount, 1, 'submit() must never be called automatically a second time for the same clientSubmissionKey')

  // And a THIRD call, for good measure -- still never resubmits.
  const third = await op.execute({ executor })
  assert.equal(third.kind, 'manual-recovery-required')
  assert.equal(executor.submitCallCount, 1)
})

test("provider-idempotent and stable-payment-identity still map to the SAME class name, unchanged", async () => {
  for (const recoveryMode of ['provider-idempotent', 'stable-payment-identity']) {
    const server = createFakeServer()
    const client = createCommerceClient({ recovery: new InMemoryRecoveryStore(), fetch: server.fetch })
    const op = await client.open({ action: ACTION, policy: POLICY })
    const evaluation = await op.preflight()
    assert.equal(evaluation.kind, 'ready')

    const executor = new MockCommerceExecutor({ recoveryMode })
    const execution = await op.execute({ executor })
    assert.equal(execution.kind, 'execution-recorded', `${recoveryMode}: binding registration and submission must succeed unchanged`)
  }
})
