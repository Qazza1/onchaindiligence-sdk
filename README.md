# @onchaindiligence/sdk

A small, typed client for the [OnchainDiligence](https://onchaindiligence.com) compliance API. It hides the HTTP `402` pay-per-call flow entirely: you configure a funded account once, and every method transparently answers the payment challenge, settles on Tempo, and returns a typed, signed result.

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

// Anchor an attestation on Tempo, then verify it (free)
const anchored = await od.anchor(wallet.data ? wallet.attestation.signature! : '')
const status = await od.anchored(wallet.attestation.signature!)
```

Every paid response is a `Signed<T>` — the result plus an `attestation` you can verify independently:

```ts
{
  data: { address: '0x…', sanctioned: false, /* … */ },
  attestation: { signed: true, key_id: 'ed25519-…', signature: '…' }
}
```

## Methods

| Method | Returns | Paid |
|--------|---------|------|
| `screen(address)` | `Signed<SanctionsResult>` | yes |
| `screenName(name, { threshold? })` | `Signed<NameScreenResult>` | yes |
| `verifyCompany(number)` | `Signed<CompanyResult>` | yes |
| `diligence({ wallet?, company? })` | `Signed<DiligenceResult>` | yes |
| `anchor(signature)` | `Signed<AnchorResult>` | yes |
| `anchored(signature)` | `AnchorStatus` | free |
| `health()` | service status | free |

Errors throw `OnchainDiligenceError` with the HTTP `status` and a message.

## Verifying an attestation

The `signature` is an Ed25519 signature over the response data plus issue metadata. Off-chain verification is straightforward with the public key at `/.well-known/attestation-key`:

```ts
import { verify } from '@noble/ed25519'
// fetch the public key, reconstruct the signed bytes, then verify(signature, message, pubKey)
```

**On-chain verification — read this first.** The EVM has no native Ed25519 precompile (only `ecrecover` for ECDSA), so verifying an Ed25519 signature *inside* a Solidity contract is expensive and non-trivial — it requires a full Ed25519 implementation in the contract. For most use cases, verify off-chain. If you need on-chain proof that a check happened, prefer the **anchoring** flow (`anchor()` / `anchored()`), which records the attestation hash on Tempo so a contract can check a `bytes32` rather than recover an Ed25519 signature. That's the cheaper, EVM-friendly path to on-chain verifiability.

## License

MIT
