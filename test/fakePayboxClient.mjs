/**
 * fakePayboxClient.mjs — a minimal, in-memory stand-in for the real
 * `@paybox-sh/sdk` PayboxClient (or an MCP tool-call wrapper), used ONLY to
 * test PayBoxCommerceExecutor's orchestration logic offline. Reproduces the
 * CONTRACT documented at docs.paybox.sh/reference/mcp-tools (request_id
 * issuance, status vocabulary, output shape) -- no real PayBox account, no
 * real network, no real payment.
 */
export class FakePayBoxClient {
  constructor() {
    this.payX402Calls = []
    this.getRequestCalls = []
    this.requests = new Map() // request_id -> envelope
    this.nextRequestId = 1
    /** Override: (input, client) => envelope | throws. Defaults to an immediate 'success'. */
    this.onPayX402 = null
    /** Override: (requestId, client) => envelope | throws. Defaults to returning whatever is on record. */
    this.onGetRequest = null
  }

  async payX402(input) {
    this.payX402Calls.push(input)
    if (this.onPayX402) return this.onPayX402(input, this)
    const requestId = `paybox-req-${this.nextRequestId++}`
    const envelope = { request_id: requestId, status: 'success', output: { value: { x_payment: { header: 'X-PAYMENT', value: `signed-for-${requestId}` } } } }
    this.requests.set(requestId, envelope)
    return envelope
  }

  async getRequest(requestId) {
    this.getRequestCalls.push(requestId)
    if (this.onGetRequest) return this.onGetRequest(requestId, this)
    const envelope = this.requests.get(requestId)
    if (!envelope) throw new Error(`fake PayBox: unknown request_id ${requestId}`)
    return envelope
  }

  /** Test helper: set/replace the envelope PayBox currently reports for a request_id. */
  setStatus(requestId, envelope) {
    this.requests.set(requestId, { request_id: requestId, ...envelope })
  }
}
