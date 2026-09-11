/** Fully offline fake TurnkeyClient -- mirrors fakePayboxClient.mjs's discipline: never calls a real Turnkey account, no network. */
export class FakeTurnkeyClient {
  constructor() {
    this.sends = new Map() // sendTransactionStatusId -> status record
    this.sendTransactionCalls = []
    this.getTransactionStatusCalls = []
    this.nextId = 1
    /** Override to control what sendTransaction() returns/does. */
    this.onSendTransaction = null
  }

  async sendTransaction(input) {
    this.sendTransactionCalls.push(input)
    if (this.onSendTransaction) return this.onSendTransaction(input, this)
    const id = `sts_${this.nextId++}`
    this.sends.set(id, { status: 'BROADCASTING' })
    return { sendTransactionStatusId: id }
  }

  async getTransactionStatus(sendTransactionStatusId) {
    this.getTransactionStatusCalls.push(sendTransactionStatusId)
    const record = this.sends.get(sendTransactionStatusId)
    if (!record) throw new Error(`no such sendTransactionStatusId: ${sendTransactionStatusId}`)
    return record
  }
}
