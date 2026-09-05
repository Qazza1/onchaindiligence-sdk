# @onchaindiligence/sdk

A small, typed client for the [OnchainDiligence](https://onchaindiligence.com) compliance API. It hides the HTTP `402` pay-per-call flow entirely: you configure a funded account once, and every method transparently answers the payment challenge, settles on Tempo, and returns a typed, signed result.

A separate `@onchaindiligence/sdk/commerce` export orchestrates an *agent's own merchant payment lifecycle* (open → preflight → execute → observe/finalize) against `mcp.onchaindiligence.com` — see [Commerce client](#commerce-client-agent-payments) below.

```bash
npm install @onchaindiligence/sdk mppx viem
```

## Why

OnchainDiligence charges per call over HTTP `402 Payment Required`. Standard clients like `fetch` or `axios` don't handle that challenge — you'd have to catch the 402, parse the payment requirements, sign a payment, and retry. This SDK does all of that for you, so a compliance check is a single typed call.

## Usage

```ts
import { OnchainDiligence } from '@onchaindiligence/sdk'
import { privateKeyToAccount } from 'viem/accounts'

const od = new OnchainDiligence({
  account: privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`),
})

// Sanctions-screen a wallet
const wallet = await od.screen('0x7f268357A8c2552623316e2562D90e642bB538E5')
if (wallet.data.sanctioned) throw new Error('sanctioned address')

// OFAC name screening (fuzzy match)
const name = await od.screenName('Vladimir Putin')
console.log(name.data.hit, name.data.matches)

// UK company verification
const company = await od.verifyCompany('00000006')

// Combined diligence
const both = await od.diligence({
  wallet: '0x7f26…',
  company: '00000006',
})

// Anchor the complete authentic attestation envelope, then check it (free)
const anchored = await od.anchor(wallet)
const status = await od.anchored(wallet.attestation.signature!)
```

Every paid response is a `Signed<T>` — the result plus an `attestation` you can verify independently:

```ts
{
  data: { address: '0x…', sanctioned: false, /* … */ },
  attestation: {
    signed: true,
    schema_version: 'onchaindiligence.attestation.v2',
    issuer: 'https://api.onchaindiligence.com',
    purpose: 'compliance-screening-result',
    issued_at: '…',
    key_id: 'ed25519-…',
    algorithm: 'ed25519',
    canonicalization: 'RFC8785',
    signature: '…'
  }
}
```

## Methods

| Method | Returns | Paid |
|--------|---------|------|
| `screen(address)` | `Signed<SanctionsResult>` | yes |
| `screenName(name, { threshold? })` | `Signed<NameScreenResult>` | yes |
| `verifyCompany(number)` | `Signed<CompanyResult>` | yes |
| `diligence({ wallet?, company? })` | `Signed<DiligenceResult>` | yes |
| `anchor(envelope)` | `Signed<AnchorResult>` | yes |
| `anchored(signature)` | `AnchorStatus` | free |
| `health()` | service status | free |

Errors throw `OnchainDiligenceError` with the HTTP `status` and a message.

## Commerce client (agent payments)

```bash
npm install @onchaindiligence/sdk
```

A separate, `@onchaindiligence/sdk/commerce` export orchestrates an agent's
merchant payment lifecycle against `mcp.onchaindiligence.com`:

> **Keep your wallet. Keep your payment provider. Add OCD once.**

OCD evaluates a proposed payment against your policy and observes/reconciles
what actually settled. It never holds a key, never authorizes a payment, and
never replaces your executor's own authorization — see
[`CommerceExecutor`](src/commerce/executor.ts).

```ts
import { createCommerceClient, NodeFileRecoveryStore, MockCommerceExecutor, apiPurchasePolicy } from '@onchaindiligence/sdk/commerce'

const ocd = createCommerceClient({ recovery: new NodeFileRecoveryStore('./ocd-recovery') })

const { policy } = apiPurchasePolicy({ maxAmount: '1.00', allowedNetwork: 'eip155:8453', allowedAsset: BASE_USDC })
const op = await ocd.open({ action: proposedPayment, policy })

const evaluation = await op.preflight()
if (evaluation.kind === 'blocked' || evaluation.kind === 'approval-required') return handleThat(evaluation)

const execution = await op.execute({ executor: myExecutor }) // e.g. new X402BaseUsdcExecutor({ account })
if (execution.kind !== 'execution-recorded') return handleThat(execution)

const result = await op.observeAndFinalize() // safe to retry while kind === 'pending'
console.log(result.receipt.receipt.execution.status) // read the fact, never infer "success" from existence
```

See **[examples/quickstart.ts](examples/quickstart.ts)** for the complete,
runnable, ~20-line integration (uses a mocked executor and an in-process demo
server — `npx tsx examples/quickstart.ts` costs nothing and needs no wallet).

Key pieces:

| Export | What it is |
|---|---|
| `createCommerceClient` / `CommerceOperation` | Orchestrates open → preflight → execute → observe/finalize. |
| `CommerceExecutor` | The contract your wallet/payment provider implements: `prepare` → `submit` → `resume`. Independent of OCD's policy decision by construction. |
| `X402BaseUsdcExecutor` | The one production executor: Base mainnet, USDC, x402 v2 exact. Its `recoveryMode` is honestly `'manual'` — see the file's own header for why. |
| `MockCommerceExecutor` | Deterministic, no-network executor for tests/docs. |
| `CommerceRecoveryStore` | Durable identity storage — required, no safe default. `NodeFileRecoveryStore` survives a restart; implement the interface against your own database for a multi-instance deployment. `InMemoryRecoveryStore` is test-only. |
| `apiPurchasePolicy` / `approvalAboveThresholdPolicy` / `fixedRecipientPolicy` | Three starter policy templates — ordinary strict policy objects, no new semantics. |
| `buildEvidenceExport` | A minimal, deterministic, secret-free evidence manifest. |
| `client.getReceipt()` / `client.verifyReceipt()` | Free, structured, reuse OCD's converged verification contract — a convenience, not a stronger trust model than verifying offline yourself. |

Every lifecycle result is a discriminated union (`evaluation.kind`,
`execution.kind`, `result.kind`) — `'pending'` states carry a machine-readable
`safeNextAction`, `retryAfterSeconds`, and `mayAlreadyHavePaid`, so a `pending`
outcome is never confused with failure or with "safe to pay again."

## Offline verification

The security-sensitive verifier performs zero network access. Supply key records
you independently chose to trust; merely downloading a public key does not make
it a trusted publisher identity. Version 2 uses domain-separated RFC 8785
canonical JSON, while explicit legacy v1 attestations retain their original
verification path.

```ts
import { verifyAttestationOffline } from '@onchaindiligence/sdk'

const result = await verifyAttestationOffline(signed, trustedRegistry)
// result.state is exactly VALID, INVALID, or UNVERIFIABLE
console.log(result.components.signature, result.components.key_window)
```

`verifyAttestationOnline()` is a separate convenience wrapper. It only treats
the discovered registry as identity authority when the caller explicitly sets
`trustRegistry: true` (or supplies an approval callback). The class method
`od.verifyAttestation()` remains an online compatibility wrapper for existing
clients; new security-sensitive code should use the standalone offline API.

The signature authenticates the signer's `issued_at` assertion. It does not by
itself prove objective time. A separately verified on-chain anchor can establish
an external “existed no later than” bound; freshness, key validity, signature
validity, and anchor status remain separate checks.

**On-chain verification — read this first.** The EVM has no native Ed25519 precompile (only `ecrecover` for ECDSA), so verifying an Ed25519 signature *inside* a Solidity contract is expensive and non-trivial — it requires a full Ed25519 implementation in the contract. For most use cases, verify off-chain. If you need on-chain proof that a check happened, prefer the **anchoring** flow (`anchor()` / `anchored()`), which records the attestation hash on Tempo so a contract can check a `bytes32` rather than recover an Ed25519 signature. That's the cheaper, EVM-friendly path to on-chain verifiability.

## License

MIT
