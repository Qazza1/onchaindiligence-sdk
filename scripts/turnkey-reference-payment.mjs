#!/usr/bin/env node
// Turnkey reference payment runner.
//   Turnkey signs and executes. OCD independently observes, reconciles and preserves evidence.
//
// READINESS (default): no money movement, no signing. Checks Turnkey auth/wallet/policies/balance,
// the OCD workspace key, opens one SDK operation and checks the paid preflight challenge is live (unpaid).
// EXECUTE: only when TURNKEY_REFERENCE_EXECUTE=true. Not used until explicitly approved.
//
// Required env (never printed): TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID,
// TURNKEY_WALLET_ADDRESS, OCD_API_KEY, TURNKEY_REFERENCE_RECIPIENT, TURNKEY_REFERENCE_AMOUNT.
// Optional: TURNKEY_REFERENCE_NETWORK / _ASSET (Base mainnet / canonical USDC only), OCD_ENDPOINT,
// OCD_PREFLIGHT_BUYER_KEY (execute mode only: x402 buyer that pays the $0.01 preflight).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createPublicClient, http, parseAbi, formatUnits } from 'viem'
import { base } from 'viem/chains'
import { resolveRunMode, assertMayExecute, loadPaymentConfig, missingCredentials } from './turnkeyReferenceGuards.mjs'
import { createTurnkeyClient } from './turnkeyClientAdapter.mjs'
import { probePreflightChallenge } from './turnkeyPreflightProbe.mjs'

const env = process.env
const line = (label, value) => console.log(`${label.padEnd(24)}${value}`)

/** Durable file-backed request store so a crash after send never leads to a second send. */
class FileTurnkeyRequestStore {
  constructor(path) { this.path = path }
  read() { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {} }
  async get(key) { return this.read()[key] ?? null }
  async set(record) { const all = this.read(); all[record.clientSubmissionKey] = record; writeFileSync(this.path, JSON.stringify(all, null, 2)) }
  async claim(key, placeholder) {
    const all = this.read()
    if (all[key]) return { claimed: false, record: all[key] }
    all[key] = placeholder; writeFileSync(this.path, JSON.stringify(all, null, 2))
    return { claimed: true, record: placeholder }
  }
}

async function readiness(cfg, sdk, turnkeyApi) {
  const { createCommerceClient, InMemoryRecoveryStore } = sdk
  const publicClient = createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL || 'https://mainnet.base.org') })

  const who = await turnkeyApi.getWhoami({})
  line('Turnkey credentials:', `authenticated (organization ${who.organizationName || who.organizationId})`)

  let resolved = false
  const wallets = await turnkeyApi.getWallets({})
  for (const w of wallets.wallets ?? []) {
    const accounts = await turnkeyApi.getWalletAccounts({ walletId: w.walletId })
    if ((accounts.accounts ?? []).some((a) => a.address?.toLowerCase() === cfg.wallet.toLowerCase())) resolved = true
  }
  line('Turnkey wallet:', `${cfg.wallet} (${resolved ? 'resolved in organization' : 'NOT FOUND among organization wallet accounts'})`)

  const policies = await turnkeyApi.getPolicies({})
  const list = policies.policies ?? []
  line('Turnkey policies:', list.length ? `${list.length} defined: ${list.map((p) => `${p.policyName} [${p.effect}]`).join('; ')}` : 'none defined (Turnkey default: deny unless root user quorum)')
  line('Policy evaluation:', 'not exposed read-only by Turnkey; evaluated by Turnkey only when execution is attempted')

  const usdc = await publicClient.readContract({ address: cfg.asset, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [cfg.wallet] })
  const eth = await publicClient.getBalance({ address: cfg.wallet })
  line('Network / asset:', `Base mainnet / USDC ${cfg.asset}`)
  line('Wallet balance:', `${formatUnits(usdc, 6)} USDC, ${formatUnits(eth, 18)} ETH (gas)`)
  line('Proposed payment:', `${cfg.amount} USDC -> ${cfg.recipient}`)

  const recovery = new InMemoryRecoveryStore()
  const client = createCommerceClient({ endpoint: env.OCD_ENDPOINT, accountApiKey: env.OCD_API_KEY, recovery })
  const action = { kind: 'PAYMENT', resource: null, network: cfg.network, asset: cfg.asset, amount: cfg.amount, sender: cfg.wallet, recipient: cfg.recipient }
  const policy = { max_amount: cfg.amount, allowed_networks: [cfg.network], allowed_assets: [cfg.asset], expected_recipient: cfg.recipient, allowed_resource_origins: null }
  const op = await client.open({ action, policy })
  line('OCD SDK operation:', `created ${op.operationId} (client source: sdk; workspace-attached)`)

  // Unpaid probe for this exact operation/input: valid headers + body, no payment, so the server returns its 402 challenge.
  const record = await recovery.load(op.operationId)
  const probe = await probePreflightChallenge({ endpoint: env.OCD_ENDPOINT || 'https://mcp.onchaindiligence.com', operationId: op.operationId, recoveryCredential: record.recoveryCredential, action, policy })
  line('Preflight:', probe.live ? 'paid preflight is live (402 challenge). NOT paid in readiness mode.' : `unexpected HTTP ${probe.status} from preflight probe`)
  console.log('')
  line('Execution:', 'NOT SUBMITTED')
  line('Transaction:', 'none')
}

async function execute(cfg, sdk, turnkeyApi) {
  assertMayExecute(resolveRunMode(env))
  const { createCommerceClient, TurnkeyCommerceExecutor } = sdk
  const { NodeFileRecoveryStore } = await import('../dist/commerce/node.js')
  if (!env.OCD_PREFLIGHT_BUYER_KEY) throw new Error('OCD_PREFLIGHT_BUYER_KEY is required in execute mode (x402 buyer that pays the $0.01 preflight)')
  const { wrapFetchWithPayment } = await import('@x402/fetch')
  const { x402Client } = await import('@x402/core/client')
  const { ExactEvmScheme } = await import('@x402/evm/exact/client')
  const { toClientEvmSigner } = await import('@x402/evm')
  const { privateKeyToAccount } = await import('viem/accounts')
  const buyer = privateKeyToAccount(env.OCD_PREFLIGHT_BUYER_KEY)
  const paidFetch = wrapFetchWithPayment(globalThis.fetch, new x402Client().register(cfg.network, new ExactEvmScheme(toClientEvmSigner(buyer))))
  const client = createCommerceClient({ endpoint: env.OCD_ENDPOINT, accountApiKey: env.OCD_API_KEY, fetch: paidFetch, recovery: new NodeFileRecoveryStore('./ocd-recovery') })
  const action = { kind: 'PAYMENT', resource: null, network: cfg.network, asset: cfg.asset, amount: cfg.amount, sender: cfg.wallet, recipient: cfg.recipient }
  const policy = { max_amount: cfg.amount, allowed_networks: [cfg.network], allowed_assets: [cfg.asset], expected_recipient: cfg.recipient, allowed_resource_origins: null }
  const op = await client.open({ action, policy })
  line('OCD operation:', op.operationId)
  const evaluation = await op.preflight()
  line('Preflight:', evaluation.kind)
  if (evaluation.kind !== 'ready') { line('Execution:', 'NOT SUBMITTED (preflight did not allow)'); return }
  const executor = new TurnkeyCommerceExecutor({ turnkey: createTurnkeyClient(turnkeyApi), store: new FileTurnkeyRequestStore('./ocd-turnkey-requests.json') })
  const execution = await op.execute({ executor })
  line('Execution:', execution.kind)
  if (execution.kind === 'execution-recorded') line('Transaction:', execution.transactionHash)
  const result = await op.observeAndFinalize()
  line('Finalize:', result.kind)
}

async function main() {
  const mode = resolveRunMode(env)
  line('Mode:', mode.toUpperCase())
  const missing = missingCredentials(env)
  if (missing.length) { console.error(`Missing required environment variables: ${missing.join(', ')}`); process.exit(2) }
  const cfg = loadPaymentConfig(env)
  const sdk = await import('../dist/commerce/index.js')
  const { Turnkey } = await import('@turnkey/sdk-server')
  const turnkeyApi = new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    apiPublicKey: env.TURNKEY_API_PUBLIC_KEY,
    apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY,
    defaultOrganizationId: env.TURNKEY_ORGANIZATION_ID,
  }).apiClient()
  if (mode === 'execute') await execute(cfg, sdk, turnkeyApi)
  else await readiness(cfg, sdk, turnkeyApi)
}

main().catch((err) => { console.error(`Reference run failed: ${err?.message || 'unknown error'}`); process.exit(1) })
