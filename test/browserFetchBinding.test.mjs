/** Regression test for a confirmed live D2.5A defect: OnchainDiligenceCommerceClient
 * and X402BaseUsdcExecutor stored `options.fetch ?? globalThis.fetch` verbatim
 * and later invoked it as `this.fetchImpl(...)`. `fetch` is a WebIDL operation
 * on the global object with a receiver brand check -- calling it through ANY
 * indirection other than the bare `fetch(...)` identifier (a local variable,
 * a class property) detaches it from that receiver and throws "Illegal
 * invocation" in every real browser. Node's fetch/undici implementation does
 * NOT enforce this check, so the bug was invisible to every existing
 * Node-based test in this suite -- it only surfaced live, against a real
 * browser page with no `fetch` option supplied to createCommerceClient(),
 * exactly the default/expected usage for a browser integration.
 *
 * This test can't use a real browser, so it reproduces the ONE thing that
 * actually matters: a fetch implementation that throws unless called with
 * the exact receiver it expects (globalThis) -- exactly what a real
 * browser's `fetch` does -- and proves both classes tolerate a caller who
 * supplies NO `fetch` option at all (the real-world failure case).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'
import { InMemoryRecoveryStore, createCommerceClient, X402BaseUsdcExecutor, BASE_NETWORK, BASE_USDC, toClientEvmSigner } from '../dist/commerce/index.js'

/** Mimics a real browser's `fetch`: throws "Illegal invocation" unless called with EXACTLY `expectedReceiver` as `this`. */
function makeBrandCheckedFetch(expectedReceiver) {
  return function fetch(...args) {
    if (this !== expectedReceiver) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
  }
}

test('OnchainDiligenceCommerceClient with no fetch option survives a browser-realistic branded global fetch', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = makeBrandCheckedFetch(globalThis)
  try {
    const client = createCommerceClient({ endpoint: 'https://example.invalid', recovery: new InMemoryRecoveryStore() })
    // apiFetch is the client's own internal dispatch -- every public method
    // (open/preflight/verifyReceipt/getReceipt) routes through it. If the
    // constructor stored an unbound reference, this throws "Illegal
    // invocation" instead of ever reaching the network layer.
    const res = await client.apiFetch('/whatever')
    assert.equal(res.status, 200)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('X402BaseUsdcExecutor with no fetch option survives a browser-realistic branded global fetch', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = makeBrandCheckedFetch(globalThis)
  try {
    const signer = toClientEvmSigner(privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001'))
    const executor = new X402BaseUsdcExecutor({ signer })
    const context = {
      clientSubmissionKey: 'test-key',
      action: { network: BASE_NETWORK, asset: BASE_USDC, amount: '0.001', recipient: '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897', resource: 'https://merchant.example/thing', sender: null },
    }
    // The fake fetch returns 200, not a 402 challenge -- prepare() is
    // expected to reject on THAT basis. What this test asserts is that the
    // rejection is the real "expected HTTP 402" error, never "Illegal
    // invocation" -- proving the fetch call itself succeeded structurally.
    await assert.rejects(executor.prepare(context), (err) => {
      assert.ok(!/Illegal invocation/.test(err.message), `must not fail on the fetch receiver itself: ${err.message}`)
      assert.match(err.message, /expected HTTP 402/)
      return true
    })
  } finally {
    globalThis.fetch = realFetch
  }
})
