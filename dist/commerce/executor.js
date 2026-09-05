/**
 * executor.ts — the CommerceExecutor contract (D2.5, Section 3).
 *
 * OCD evaluates. The executor authorizes and submits. These are DELIBERATELY
 * independent: an OCD ALLOW is a policy opinion, never a grant of wallet
 * authority, and this interface exists precisely so a developer can swap
 * wallets/providers without OCD code ever touching a private key or a
 * payment authorization it didn't need to see.
 *
 * `prepare()` MUST NOT broadcast anything — it is the point where a durable
 * execution/payment identity is created (and, in the commerce client's
 * orchestration, persisted to the recovery store and registered with OCD's
 * execution-bindings endpoint) BEFORE any state-changing network call.
 * `submit()` is called AT MOST ONCE per prepared identity by the orchestrator
 * — an executor must never invent a second identity/authorization on its
 * own initiative. `resume()` must query/resume the SAME prepared identity,
 * never fabricate a new payment.
 */
export {};
