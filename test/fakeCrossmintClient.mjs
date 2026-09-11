/** Fully offline fake CrossmintClient -- mirrors fakeTurnkeyClient.mjs's discipline: never calls a real Crossmint account, no network. */
export class FakeCrossmintClient {
  constructor() {
    this.transfers = new Map() // id -> transaction result
    this.transferCalls = []
    this.getTransactionCalls = []
    this.nextId = 1
    /** Override to control what transfer() returns/does. */
    this.onTransfer = null
  }

  async transfer(input) {
    this.transferCalls.push(input)
    if (this.onTransfer) return this.onTransfer(input, this)
    const id = `transfer_${this.nextId++}`
    const result = { id, status: 'pending' }
    this.transfers.set(id, result)
    return result
  }

  async getTransaction(id) {
    this.getTransactionCalls.push(id)
    const result = this.transfers.get(id)
    if (!result) throw new Error(`no such transfer id: ${id}`)
    return result
  }
}
