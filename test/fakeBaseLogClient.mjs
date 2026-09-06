/**
 * fakeBaseLogClient.mjs — a minimal fake satisfying MinimalBaseLogClient
 * (getBlockNumber/getLogs), used to test PayBoxCommerceExecutor's gateway-
 * mode transaction discovery offline. No real RPC, no real chain.
 */
export class FakeBaseLogClient {
  constructor({ startBlock = 1000n } = {}) {
    this.currentBlock = startBlock
    /** Array of { blockNumber, transactionHash, blockHash, logIndex, from, to, value (bigint) }. */
    this.transfers = []
  }

  addTransfer({ blockNumber, transactionHash, blockHash, logIndex, from, to, value }) {
    this.transfers.push({ blockNumber, transactionHash, blockHash, logIndex, from, to, value })
    if (blockNumber > this.currentBlock) this.currentBlock = blockNumber
  }

  async getBlockNumber() {
    return this.currentBlock
  }

  async getLogs({ fromBlock, toBlock, args }) {
    return this.transfers
      .filter((t) => t.blockNumber >= fromBlock && t.blockNumber <= toBlock)
      .filter((t) => (args?.from ? t.from.toLowerCase() === args.from.toLowerCase() : true))
      .filter((t) => (args?.to ? t.to.toLowerCase() === args.to.toLowerCase() : true))
      .map((t) => ({
        transactionHash: t.transactionHash,
        blockHash: t.blockHash,
        logIndex: t.logIndex,
        args: { from: t.from, to: t.to, value: t.value },
      }))
  }
}
