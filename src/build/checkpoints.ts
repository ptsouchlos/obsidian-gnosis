//! Where an unfinished build keeps its progress.
//!
//! In IndexedDB, deliberately not in the vault: a checkpoint is half an index,
//! and a vault folder would have every file syncer upload each one to every
//! other device. IndexedDB is this device's alone. It is shared by every vault
//! Obsidian opens, so entries are keyed by vault.

import type { RawArtifact } from "../artifact.js";

/** A checkpoint, tagged with the build it belongs to. */
export interface Checkpoint {
    /**
     * What the build was making — model, pooling, prefixes, root. A checkpoint
     * for a different spec is not resumed: its vectors are in another space.
     */
    specKey: string;
    artifact: RawArtifact;
    savedAt: number;
}

export interface CheckpointStore {
    load(vault: string): Promise<Checkpoint | null>;
    save(vault: string, checkpoint: Checkpoint): Promise<void>;
    clear(vault: string): Promise<void>;
}

/** For tests, and wherever IndexedDB is missing. */
export class MemoryCheckpoints implements CheckpointStore {
    readonly saved = new Map<string, Checkpoint>();

    async load(vault: string): Promise<Checkpoint | null> {
        return this.saved.get(vault) ?? null;
    }

    async save(vault: string, checkpoint: Checkpoint): Promise<void> {
        this.saved.set(vault, checkpoint);
    }

    async clear(vault: string): Promise<void> {
        this.saved.delete(vault);
    }
}

const DATABASE = "gnosis-build";
const STORE = "checkpoints";

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
}

export class IndexedDbCheckpoints implements CheckpointStore {
    private db: Promise<IDBDatabase> | null = null;

    private open(): Promise<IDBDatabase> {
        this.db ??= new Promise((resolve, reject) => {
            const req = indexedDB.open(DATABASE, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error ?? new Error("could not open IndexedDB"));
        });
        return this.db;
    }

    private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
        return (await this.open()).transaction(STORE, mode).objectStore(STORE);
    }

    async load(vault: string): Promise<Checkpoint | null> {
        // A `Map` of `Uint8Array`s survives structured cloning as it is.
        const found = (await request((await this.store("readonly")).get(vault))) as Checkpoint | undefined;
        return found ?? null;
    }

    async save(vault: string, checkpoint: Checkpoint): Promise<void> {
        await request((await this.store("readwrite")).put(checkpoint, vault));
    }

    async clear(vault: string): Promise<void> {
        await request((await this.store("readwrite")).delete(vault));
    }
}
