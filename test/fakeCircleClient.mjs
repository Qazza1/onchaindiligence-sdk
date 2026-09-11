/** Fully offline fake CircleClient -- mirrors fakeCdpClient.mjs's discipline: never calls a real Circle account, no network. */
export class FakeCircleClient {
  constructor() {
    this.transactions = new Map() // id -> transaction result
    this.createTransferCalls = []
    this.getTransactionCalls = []
    this.nextId = 1
    /** Override to control what createTransfer() returns/throws. */
    this.onCreateTransfer = null
  }

  async createTransfer(input) {
    this.createTransferCalls.push(input)
    if (this.onCreateTransfer) return this.onCreateTransfer(input, this)
    const id = `circle-txn-${this.nextId++}`
    const result = { id, state: 'INITIATED' }
    this.transactions.set(id, result)
    return result
  }

  async getTransaction(id) {
    this.getTransactionCalls.push(id)
    const result = this.transactions.get(id)
    if (!result) throw new Error(`no such transaction id: ${id}`)
    return result
  }
}
