import type { Account } from 'viem';
import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js';
export declare const BASE_NETWORK = "eip155:8453";
export declare const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** The subset of viem's PublicClient resume() actually calls -- narrowed so tests can inject a minimal fake instead of a real RPC connection. */
export interface MinimalResumeClient {
    getTransactionReceipt: (args: {
        hash: `0x${string}`;
    }) => Promise<unknown>;
}
export interface X402ExecutorOptions {
    /** A viem account that signs the EIP-3009 payment authorization. Never logged, never persisted by this class. */
    account: Account;
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
    private readonly account;
    private readonly fetchImpl;
    private readonly rpcUrl;
    private readonly injectedPublicClient?;
    constructor(options: X402ExecutorOptions);
    prepare(context: PrepareContext): Promise<PrepareResult>;
    submit(prepared: PrepareResult): Promise<ExecutionResult>;
    resume(prepared: PrepareResult, priorOutcome?: ExecutionResult): Promise<ExecutionResult>;
}
