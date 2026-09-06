import type { PayBoxRequestStore, PayBoxRequestRecord } from './payboxExecutor.js';
export declare class NodeFilePayboxRequestStore implements PayBoxRequestStore {
    private readonly directory;
    constructor(directory: string);
    private pathFor;
    get(clientSubmissionKey: string): Promise<PayBoxRequestRecord | null>;
    set(record: PayBoxRequestRecord): Promise<void>;
    claim(clientSubmissionKey: string, placeholder: PayBoxRequestRecord): Promise<{
        claimed: boolean;
        record: PayBoxRequestRecord;
    }>;
}
