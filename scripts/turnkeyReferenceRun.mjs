// Restart-safe orchestration for ONE Turnkey reference payment.
//
// A process restart must never turn one approved reference payment into two. The first run records the
// immutable payment configuration and the OCD operation ID (non-secret) BEFORE any paid preflight or Turnkey
// call. Any later run must match that configuration exactly and resumes the SAME operation through the SDK's
// own recovery store / resume semantics; it never opens a second operation. No secret is ever written here:
// the recovery credential stays inside the SDK's recovery store, never in this state file.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export class ReferenceRunStateError extends Error { constructor(message) { super(message); this.name = 'ReferenceRunStateError' } }
export class ReferenceRunMismatchError extends Error { constructor(message) { super(message); this.name = 'ReferenceRunMismatchError' } }

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const STATE_KEYS = ['version', 'wallet', 'network', 'asset', 'recipient', 'amount', 'operationId', 'createdAt', 'completedAt', 'receiptId']

function atomic6(amount) {
  const [whole, frac = ''] = String(amount).split('.')
  return BigInt(whole + frac.padEnd(6, '0')).toString()
}

/** The immutable fingerprint of the approved reference payment. */
export function fingerprint(cfg) {
  return { wallet: cfg.wallet.toLowerCase(), network: cfg.network, asset: cfg.asset.toLowerCase(), recipient: cfg.recipient.toLowerCase(), amount: atomic6(cfg.amount) }
}

/** Validates a parsed state object strictly; anything unexpected (extra keys included) fails closed. */
export function validateReferenceState(value) {
  const fail = (why) => { throw new ReferenceRunStateError(`reference-run state is malformed (${why}); an operator must inspect or deliberately clear it before any new payment`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('not an object')
  const extra = Object.keys(value).filter((k) => !STATE_KEYS.includes(k))
  if (extra.length) fail(`unexpected field ${extra[0]}`)
  if (value.version !== 1) fail('unsupported version')
  for (const k of ['wallet', 'recipient', 'asset']) if (typeof value[k] !== 'string' || !ADDRESS.test(value[k])) fail(`invalid ${k}`)
  if (typeof value.network !== 'string' || !value.network) fail('invalid network')
  if (typeof value.amount !== 'string' || !/^\d+$/.test(value.amount)) fail('invalid amount')
  if (typeof value.operationId !== 'string' || !/^OCD-OP-[A-Za-z0-9_-]+$/.test(value.operationId)) fail('invalid operationId')
  if (typeof value.createdAt !== 'string') fail('invalid createdAt')
  if (value.completedAt !== null && typeof value.completedAt !== 'string') fail('invalid completedAt')
  if (value.receiptId !== null && typeof value.receiptId !== 'string') fail('invalid receiptId')
  return value
}

export function assertSamePayment(state, cfg) {
  const want = fingerprint(cfg)
  const diff = ['wallet', 'network', 'asset', 'recipient', 'amount'].filter((k) => String(state[k]).toLowerCase() !== String(want[k]).toLowerCase())
  if (diff.length) {
    throw new ReferenceRunMismatchError(`an existing reference run (operation ${state.operationId}) was recorded for a different ${diff.join(', ')}. Resolve that run, or deliberately clear the reference-run state file, before starting another payment. No new payment was started.`)
  }
}

/** Durable, non-secret, one-payment state file. Created exclusively so a concurrent first run cannot create a second record. */
export class FileReferenceRunState {
  constructor(path) { this.path = path }
  read() {
    if (!existsSync(this.path)) return null
    let parsed
    try { parsed = JSON.parse(readFileSync(this.path, 'utf8')) } catch { throw new ReferenceRunStateError('reference-run state is not valid JSON; an operator must inspect or deliberately clear it') }
    return validateReferenceState(parsed)
  }
  create(state) {
    validateReferenceState(state)
    try { writeFileSync(this.path, JSON.stringify(state, null, 2), { flag: 'wx' }) } catch (err) {
      if (err?.code === 'EEXIST') throw new ReferenceRunStateError('reference-run state was created concurrently; rerun to resume it')
      throw err
    }
  }
  update(patch) {
    const next = validateReferenceState({ ...this.read(), ...patch })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2)); renameSync(tmp, this.path)
    return next
  }
}

export function buildAction(cfg) {
  return { kind: 'PAYMENT', resource: null, network: cfg.network, asset: cfg.asset, amount: cfg.amount, sender: cfg.wallet, recipient: cfg.recipient }
}
export function buildPolicy(cfg) {
  return { max_amount: cfg.amount, allowed_networks: [cfg.network], allowed_assets: [cfg.asset], expected_recipient: cfg.recipient, allowed_resource_origins: null }
}

/**
 * Runs (or safely resumes) the one reference payment.
 * `client` is an OnchainDiligenceCommerceClient backed by a DURABLE recovery store; `executor` is the Turnkey executor
 * with a DURABLE request store; `state` is a FileReferenceRunState-compatible object.
 */
export async function runReferencePayment({ cfg, client, executor, state, now = () => new Date().toISOString() }) {
  const action = buildAction(cfg); const policy = buildPolicy(cfg)
  const existing = state.read() // malformed state throws here, before any network call
  if (existing) assertSamePayment(existing, cfg) // mismatch throws here, before any network call

  let op
  if (!existing) {
    op = await client.open({ action, policy })
    // Recorded before any paid preflight or Turnkey call.
    state.create({ version: 1, ...fingerprint(cfg), operationId: op.operationId, createdAt: now(), completedAt: null, receiptId: null })
  } else {
    try { op = await client.open({ operationId: existing.operationId, action, policy }) } // SDK resume from the durable recovery store
    catch (err) {
      throw new ReferenceRunStateError(`reference run ${existing.operationId} exists but its recovery record could not be loaded (${err?.name || 'error'}). It cannot be resumed safely; no new payment was started.`)
    }
  }
  const current = state.read()
  let record = op.currentRecord()

  if (current.completedAt || record.localPhase === 'finalized') {
    if (!current.completedAt) state.update({ completedAt: now() })
    return { kind: 'completed', operationId: op.operationId, receiptId: current.receiptId }
  }

  // The paid preflight is skipped whenever the operation already holds its authoritative ALLOW and capability.
  // Otherwise re-posting the identical action/policy is safe: the server deduplicates by operation + input.
  if (!(record.preflightReceiptId && record.preflightDecisionStatus === 'ALLOW' && record.finalizationCapability)) {
    const evaluation = await op.preflight()
    if (evaluation.kind !== 'ready') return { kind: 'not-ready', operationId: op.operationId, evaluation: evaluation.kind }
  }

  // execute() itself never re-prepares/re-submits when a submission identity or transaction already exists;
  // with a transaction hash on record we do not call it at all.
  record = op.currentRecord()
  if (!record.transactionHash) {
    const execution = await op.execute({ executor })
    if (execution.kind !== 'execution-recorded') return { kind: 'execution-not-recorded', operationId: op.operationId, execution: execution.kind, detail: execution.error ?? execution.reason ?? null }
  }

  const finalized = await op.observeAndFinalize()
  if (finalized.kind === 'receipt-produced') {
    state.update({ completedAt: now(), receiptId: finalized.receipt.receipt.receipt_id })
    return { kind: 'completed', operationId: op.operationId, receiptId: finalized.receipt.receipt.receipt_id }
  }
  if (finalized.kind === 'pending') return { kind: 'pending', operationId: op.operationId, phase: finalized.phase, retryAfterSeconds: finalized.retryAfterSeconds ?? null }
  return { kind: 'terminal-error', operationId: op.operationId, error: finalized.error ?? 'unknown' }
}
