/**
 * nodeFilePayboxRequestStore.ts — a real, restart-surviving, single-machine
 * PayBoxRequestStore for Node (D2.6 live reference preparation).
 *
 * Storage: one JSON file per clientSubmissionKey under `directory`, named
 * `<clientSubmissionKey>.json` — same layout discipline as
 * nodeFileRecoveryStore.ts.
 *
 * ATOMIC CLAIM, GENUINELY CROSS-PROCESS: `claim()` creates the file with
 * Node's `'wx'` flag (`O_WRONLY|O_CREAT|O_EXCL` at the OS level) — the
 * filesystem itself guarantees that of two processes racing to create the
 * SAME path, exactly one `open()` call succeeds and the other fails with
 * `EEXIST`. This is a STRONGER guarantee than nodeFileRecoveryStore.ts's own
 * in-process lock queue (which that file's own header honestly documents as
 * "NOT a multi-process/multi-machine lock") — PayBoxRequestStore.claim()'s
 * own contract specifically requires genuine cross-process atomicity (D2.6
 * review fix #3: "exactly one claimant may call pay_x402"), so this
 * implementation earns that requirement at the filesystem level rather than
 * only within one Node process.
 *
 * `set()` (used only by the winning claimant, to record the real
 * `payboxRequestId` once known, and later `transactionHash`) uses the same
 * write-to-temp-then-rename pattern as nodeFileRecoveryStore.ts so a crash
 * mid-write can never leave a half-written, corrupt record.
 *
 * Single-machine, shared-filesystem scope only (same as
 * NodeFileRecoveryStore) — a multi-machine deployment needs a real database
 * with a native atomic insert-if-absent (e.g. `INSERT ... ON CONFLICT DO
 * NOTHING`) instead.
 */
import { mkdir, readFile, writeFile, rename, open as openFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
/** Matches the shape onchaindiligence-mcp/onchaindiligence-sdk generate for clientSubmissionKey (operationId:timestamp:random, see client.ts's claimSubmissionSlot) -- rejected characters could otherwise be used to escape `directory`. */
function isValidClientSubmissionKey(key) {
    return /^[A-Za-z0-9_:.-]{1,200}$/.test(key);
}
export class NodeFilePayboxRequestStore {
    directory;
    constructor(directory) {
        this.directory = directory;
    }
    pathFor(clientSubmissionKey) {
        if (!isValidClientSubmissionKey(clientSubmissionKey)) {
            throw new TypeError(`invalid clientSubmissionKey for file storage: ${clientSubmissionKey}`);
        }
        // ':' is valid in a clientSubmissionKey but not portable in a filename on
        // every filesystem -- encode it rather than reject otherwise-valid keys.
        const safeName = encodeURIComponent(clientSubmissionKey);
        return join(this.directory, `${safeName}.json`);
    }
    async get(clientSubmissionKey) {
        try {
            const text = await readFile(this.pathFor(clientSubmissionKey), 'utf8');
            return JSON.parse(text);
        }
        catch (err) {
            if (err?.code === 'ENOENT')
                return null;
            throw err;
        }
    }
    async set(record) {
        await mkdir(this.directory, { recursive: true });
        const finalPath = this.pathFor(record.clientSubmissionKey);
        const tempPath = join(this.directory, `.${encodeURIComponent(record.clientSubmissionKey)}.${randomBytes(4).toString('hex')}.tmp`);
        await writeFile(tempPath, JSON.stringify(record, null, 2), 'utf8');
        await rename(tempPath, finalPath); // atomic on the same filesystem
    }
    async claim(clientSubmissionKey, placeholder) {
        await mkdir(this.directory, { recursive: true });
        const finalPath = this.pathFor(clientSubmissionKey);
        let handle;
        try {
            // 'wx' = O_WRONLY | O_CREAT | O_EXCL -- the OS guarantees exactly one
            // concurrent caller (in this process or another) wins this open().
            handle = await openFile(finalPath, 'wx');
        }
        catch (err) {
            if (err?.code === 'EEXIST') {
                const existing = await this.get(clientSubmissionKey);
                if (existing)
                    return { claimed: false, record: existing };
                // TOCTOU sliver: the file existed a moment ago (EEXIST) but is
                // unreadable/gone now -- this store never deletes records, so this
                // should not happen in practice; retry once rather than fail closed
                // on a transient race.
                return this.claim(clientSubmissionKey, placeholder);
            }
            throw err;
        }
        try {
            await handle.writeFile(JSON.stringify(placeholder, null, 2), 'utf8');
        }
        finally {
            await handle.close();
        }
        return { claimed: true, record: { ...placeholder } };
    }
}
