import { toClientEvmSigner, type ClientEvmSigner } from '@x402/evm';
import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js';
export type { ClientEvmSigner };
export { toClientEvmSigner };
export declare const BASE_NETWORK = "eip155:8453";
export declare const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** The subset of viem's PublicClient resume() actually calls -- narrowed so tests can inject a minimal fake instead of a real RPC connection. */
export interface MinimalResumeClient {
    getTransactionReceipt: (args: {
        hash: `0x${string}`;
    }) => Promise<unknown>;
}
export interface X402ExecutorOptions {
    /**
     * Signs the EIP-3009 payment authorization. Never logged, never persisted
     * by this class. `@x402/evm`'s own ExactEvmScheme wants exactly this
     * shape (address + signTypedData), NOT a full viem Account/WalletClient --
     * that's deliberate: it's the one interface both a Node private-key
     * signer (`toClientEvmSigner(privateKeyToAccount(pk))`, re-exported from
     * this module) and a browser injected-wallet signer (hand-built around
     * `walletClient.signTypedData`, since an injected wallet's viem account has
     * no signing methods of its own) can equally satisfy.
     */
    signer: ClientEvmSigner;
    /** Base RPC used ONLY for read-only resume confirmation. Defaults to the public Base RPC. */
    rpcUrl?: string;
    fetch?: typeof globalThis.fetch;
    /** Test seam: inject a fake read-only client instead of connecting to rpcUrl. */
    publicClient?: MinimalResumeClient;
}
export declare class X402BaseUsdcExecutor implements CommerceExecutor {
    readonly id = "x402-base-usdc-exact";
    readonly version = "v1";
    readonly recoveryMode: ExecutorRecoveryMode;
    private readonly signer;
    private readonly fetchImpl;
    private readonly rpcUrl;
    private readonly injectedPublicClient?;
    constructor(options: X402ExecutorOptions);
    prepare(context: PrepareContext): Promise<PrepareResult>;
    submit(prepared: PrepareResult): Promise<ExecutionResult>;
    resume(prepared: PrepareResult, priorOutcome?: ExecutionResult): Promise<ExecutionResult>;
}
