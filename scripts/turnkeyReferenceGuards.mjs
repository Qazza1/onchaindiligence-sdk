// Pure configuration + safety guards for the Turnkey reference runner. No I/O, no secrets.
export const BASE_NETWORK = 'eip155:8453'
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** Money can move ONLY when TURNKEY_REFERENCE_EXECUTE is exactly the string "true". Anything else is readiness. */
export function resolveRunMode(env) {
  return env.TURNKEY_REFERENCE_EXECUTE === 'true' ? 'execute' : 'readiness'
}

export function assertMayExecute(mode) {
  if (mode !== 'execute') throw new Error('refusing to sign or submit: set TURNKEY_REFERENCE_EXECUTE=true to run execution mode')
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const AMOUNT = /^(0|[1-9]\d*)(\.\d{1,6})?$/

/** The proposed payment comes from configuration only -- recipient and amount have no defaults. */
export function loadPaymentConfig(env) {
  const errors = []
  const network = env.TURNKEY_REFERENCE_NETWORK || BASE_NETWORK
  const asset = env.TURNKEY_REFERENCE_ASSET || BASE_USDC
  const recipient = env.TURNKEY_REFERENCE_RECIPIENT
  const amount = env.TURNKEY_REFERENCE_AMOUNT
  const wallet = env.TURNKEY_WALLET_ADDRESS
  if (network !== BASE_NETWORK) errors.push(`TURNKEY_REFERENCE_NETWORK must be ${BASE_NETWORK} (Base mainnet)`)
  if (asset.toLowerCase() !== BASE_USDC.toLowerCase()) errors.push('TURNKEY_REFERENCE_ASSET must be canonical Base USDC')
  if (!recipient || !ADDRESS.test(recipient)) errors.push('TURNKEY_REFERENCE_RECIPIENT must be an approved 0x address (no default)')
  if (!amount || !AMOUNT.test(amount) || Number(amount) <= 0) errors.push('TURNKEY_REFERENCE_AMOUNT must be a positive decimal with at most 6 places (no default)')
  if (!wallet || !ADDRESS.test(wallet)) errors.push('TURNKEY_WALLET_ADDRESS must be the Turnkey wallet 0x address')
  if (errors.length) throw new Error(errors.join('; '))
  return { network, asset: BASE_USDC, recipient, amount, wallet }
}

export function missingCredentials(env) {
  return ['TURNKEY_API_PUBLIC_KEY', 'TURNKEY_API_PRIVATE_KEY', 'TURNKEY_ORGANIZATION_ID', 'OCD_API_KEY'].filter((n) => !env[n])
}
