// Non-paying probe of the lifecycle preflight endpoint for ONE existing operation.
// Sends the operation's real headers and a valid preflight body but NO payment authorization, so the
// server answers with its x402 402 challenge. It never pays, signs, or wraps fetch with x402.
export async function probePreflightChallenge({ endpoint, operationId, recoveryCredential, action, policy, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${endpoint.replace(/\/$/, '')}/x402/lifecycle/preflight-payment`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ocd-operation-id': operationId,
      'x-ocd-recovery-credential': recoveryCredential,
    },
    body: JSON.stringify({ action, policy, options: {}, references: {}, publication: {} }),
  })
  return { status: res.status, live: res.status === 402 }
}
