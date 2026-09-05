import type { CommerceExecutor, PrepareContext, PrepareResult, ExecutionResult, ExecutorRecoveryMode } from './executor.js';
export type MockOutcomeScript = {
    kind: 'success';
    transactionHash?: string;
} | {
    kind: 'ambiguous-then-success';
    transactionHash?: string;
} | {
    kind: 'manual-recovery';
};
export interface MockExecutorOptions {
    recoveryMode?: ExecutorRecoveryMode;
    /** What submit()/resume() should do. Defaults to an immediate success. */
    script?: MockOutcomeScript;
}
/**
 * A minimal, fully in-memory executor. `prepare()` just records the frozen
 * action; `submit()` follows the configured script exactly once; `resume()`
 * only ever returns what submit() already committed to (or manual recovery,
 * for a 'manual' script) — it never invents a new outcome.
 */
export declare class MockCommerceExecutor implements CommerceExecutor {
    readonly id = "mock-executor";
    readonly version = "v1";
    readonly recoveryMode: ExecutorRecoveryMode;
    private readonly script;
    private readonly submittedOnce;
    private readonly outcomes;
    constructor(options?: MockExecutorOptions);
    prepare(context: PrepareContext): Promise<PrepareResult>;
    submit(prepared: PrepareResult): Promise<ExecutionResult>;
    resume(prepared: PrepareResult): Promise<ExecutionResult>;
}
