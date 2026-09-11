/** Fully offline fake CdpClient -- mirrors fakeTurnkeyClient.mjs/fakeCrossmintClient.mjs's discipline: never calls a real CDP account, no network. */
export class FakeCdpClient {
  constructor() {
    this.sendTransactionCalls = []
    /** Override to control what sendTransaction() returns/throws. */
    this.onSendTransaction = null
  }

  async sendTransaction(input) {
    this.sendTransactionCalls.push(input)
    if (this.onSendTransaction) return this.onSendTransaction(input, this)
    return { transactionHash: '0x' + 'ab'.repeat(32) }
  }
}
