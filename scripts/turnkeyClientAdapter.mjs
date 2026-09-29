// Adapts @turnkey/sdk-server's apiClient() to the narrow TurnkeyClient interface the executor uses.
// Holds no key material itself: signing/broadcast happen inside Turnkey under its own policy engine.
export function createTurnkeyClient(api) {
  return {
    async sendTransaction({ from, to, value, data, caip2 }) {
      const res = await api.ethSendTransaction({ from, caip2, calls: [{ to, value: value ?? '0', ...(data ? { data } : {}) }] })
      if (!res?.sendTransactionStatusId) throw new Error('Turnkey did not return a sendTransactionStatusId')
      return { sendTransactionStatusId: res.sendTransactionStatusId }
    },
    async getTransactionStatus(sendTransactionStatusId) {
      const res = await api.getSendTransactionStatus({ sendTransactionStatusId })
      const raw = String(res?.txStatus ?? '').toUpperCase()
      const message = res?.txError || res?.error?.message || null
      if (raw === 'FAILED') return { status: 'FAILED', error: { message } }
      if (raw === 'INCLUDED' || raw === 'CONFIRMED') return { status: 'INCLUDED', txHash: res?.eth?.txHash ?? null, error: message ? { message } : null }
      // Any other/unknown state is treated as still in flight -- never as success.
      return { status: 'BROADCASTING' }
    },
  }
}
