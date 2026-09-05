import { type CommerceRecoveryStore, type CommerceRecoveryRecord } from './recoveryStore.js';
export declare class NodeFileRecoveryStore implements CommerceRecoveryStore {
    private readonly directory;
    private queue;
    constructor(directory: string);
    private pathFor;
    /** Serializes all reads+writes for this store instance so create/update's read-then-write is never interleaved with another call in the same process. */
    private locked;
    private readRaw;
    private writeRaw;
    create(record: Omit<CommerceRecoveryRecord, 'version' | 'createdAt' | 'updatedAt'>): Promise<CommerceRecoveryRecord>;
    load(operationId: string): Promise<CommerceRecoveryRecord | null>;
    update(operationId: string, patch: Partial<Omit<CommerceRecoveryRecord, 'operationId' | 'version'>>, expectedVersion: number): Promise<CommerceRecoveryRecord>;
    findByClientSubmissionKey(clientSubmissionKey: string): Promise<CommerceRecoveryRecord | null>;
    /** Test/example convenience: not part of the interface. */
    _deleteForTests(operationId: string): Promise<void>;
}
