//! Building an index from inside the vault.
//!
//! Everything that decides what the index *contains* — parsing, chunk
//! boundaries, the embedding inputs, content hashes, shard layout — happens in
//! gnosis's `Builder`, the code the CLI runs, so an index built here is the
//! index `gnosis index` would build. This file only drives it: read a note,
//! hand it over, embed what comes back, repeat.
//!
//! The shape follows from the measurement that motivated it: embedding a vault
//! in a browser takes minutes to an hour, so the job has to be incremental,
//! resumable and cancelable, and must never leave a half-built index where a
//! working one was.
//!
//! - **Incremental** for free: the builder starts from the previous artifact
//!   and reuses, by content hash, every note that has not changed — its chunks
//!   *and* its vectors.
//! - **Resumable** by the same mechanism: every so often the job finishes what
//!   it has into a complete artifact and saves it as a checkpoint. A resumed
//!   build starts from that checkpoint, and everything it already embedded is
//!   simply reused.
//! - **Cancelable** without loss: canceling finishes the batch in flight,
//!   checkpoints, and returns. The live index is not touched — writing it is
//!   the caller's step, after a build that completed.

import { Builder } from "../../vendor/gnosis-wasm/gnosis_wasm.js";
import type { RawArtifact } from "../artifact.js";

/** What `Builder.create` takes, as the plugin fills it in. */
export interface BuildSpec {
    model: string;
    pooling: "cls" | "mean";
    dim: number;
    queryPrefix: string;
    documentPrefix: string;
    /** The vault's name, as the CLI labels a vault by its folder name. */
    root: string;
    quantization?: "f32" | "f16" | "i8";
    compression?: "none" | "deflate";
    /** Notes per shard; gnosis's default, the CLI's, is 256. */
    shardDocs?: number;
}

/** One note, read lazily: most notes in an incremental build are reused. */
export interface Note {
    path: string;
    /** Milliseconds, as Obsidian reports it. */
    mtime: number;
    read(): Promise<string>;
}

export interface BuildProgress {
    notesDone: number;
    notesTotal: number;
    /** Chunks embedded in this run — the slow part, and what the estimate uses. */
    chunksEmbedded: number;
    notesReused: number;
    elapsedMs: number;
}

export interface BuildInput {
    spec: BuildSpec;
    notes: Note[];
    /** What to start from: a checkpoint, the live artifact, or nothing. */
    base: RawArtifact | null;
    /** Unit vectors for exactly these strings, in order. */
    embed(texts: string[]): Promise<Float32Array[]>;
    /** Keep a complete artifact of what is done so far. */
    checkpoint(artifact: RawArtifact): Promise<void>;
    signal: AbortSignal;
    onProgress(progress: BuildProgress): void;
    /** Milliseconds; injected so tests can drive checkpoint timing. */
    now(): number;
    /** Give the main thread back between batches. */
    yieldToUi(): Promise<void>;
    /** How often to checkpoint. A minute bounds what closing Obsidian loses. */
    checkpointEveryMs?: number;
    /** Chunks per model call: the CLI's own `batch_size`. */
    batchChunks?: number;
}

export interface BuildResult {
    /**
     * Complete — every shard present, not just the ones that changed. Null
     * only for a build canceled before it reached its first note.
     */
    artifact: RawArtifact | null;
    documents: number;
    chunks: number;
    chunksEmbedded: number;
    notesReused: number;
    /** True if the signal stopped it; `artifact` is then a checkpoint, not a build. */
    canceled: boolean;
}

/** What `Builder.finish` hands back. */
interface Finished {
    manifest: string;
    documents: number;
    chunks: number;
    unchanged: string[];
    shards: Map<string, Uint8Array>;
}

interface Queued {
    path: string;
    texts: string[];
}

/**
 * Fill in shards `finish` left out because their bytes did not change.
 *
 * They are the base's shards of the same name, and the result has to carry
 * them: a checkpoint, or the artifact handed to the writer, must be complete
 * on its own.
 */
function complete(finished: Finished, base: RawArtifact | null): RawArtifact {
    const manifest = JSON.parse(finished.manifest) as { shards: { name: string }[] };
    const shards = new Map<string, Uint8Array>();
    for (const { name } of manifest.shards) {
        const body = finished.shards.get(name) ?? base?.shards.get(name);
        if (body === undefined) {
            throw new Error(`the build lost shard '${name}': neither rewritten nor in the artifact it reused`);
        }
        shards.set(name, body);
    }
    return { manifestJson: finished.manifest, shards };
}

function open(spec: BuildSpec, base: RawArtifact | null): Builder {
    return base === null
        ? Builder.create(spec)
        : Builder.fromArtifact(spec, base.manifestJson, base.shards as unknown as Map<unknown, unknown>);
}

export async function runBuild(input: BuildInput): Promise<BuildResult> {
    const every = input.checkpointEveryMs ?? 60_000;
    const batchChunks = input.batchChunks ?? 16;
    const started = input.now();
    // Sorted so a resumed build walks the vault in the same order, which keeps
    // its progress report meaningful. The artifact itself does not depend on it.
    const notes = [...input.notes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (notes.length === 0) {
        throw new Error("the vault has no notes to index");
    }

    let base = input.base;
    let builder: Builder | null = open(input.spec, base);
    let lastCheckpoint = started;
    let chunksEmbedded = 0;
    let notesReused = 0;
    let done = 0;
    /** Notes already in the builder, which a checkpoint has to re-add. */
    let added: Note[] = [];
    let queue: Queued[] = [];
    let queuedChunks = 0;

    const report = () =>
        input.onProgress({
            notesDone: done,
            notesTotal: notes.length,
            chunksEmbedded,
            notesReused,
            elapsedMs: input.now() - started,
        });

    /** Embed everything queued, in model-sized calls, and hand the vectors over. */
    const flush = async () => {
        while (queue.length > 0) {
            // Whole notes per call, up to the batch size — a note's vectors go
            // to the builder in one piece, so it is never half-supplied.
            const batch: Queued[] = [];
            let size = 0;
            while (queue.length > 0 && (batch.length === 0 || size + queue[0]!.texts.length <= batchChunks)) {
                const next = queue.shift()!;
                batch.push(next);
                size += next.texts.length;
            }
            const vectors = await input.embed(batch.flatMap((q) => q.texts));
            let offset = 0;
            for (const queued of batch) {
                const own = vectors.slice(offset, offset + queued.texts.length);
                offset += queued.texts.length;
                const flat = new Float32Array(own.reduce((n, v) => n + v.length, 0));
                let at = 0;
                for (const v of own) {
                    flat.set(v, at);
                    at += v.length;
                }
                builder!.setVectors(queued.path, flat);
                done++;
            }
            chunksEmbedded += size;
            report();
            await input.yieldToUi();
        }
        queuedChunks = 0;
    };

    /** Finish the builder into a complete artifact. It is consumed and freed. */
    const finishBuilder = (): { artifact: RawArtifact; documents: number; chunks: number } => {
        const finished = builder!.finish(Date.now() / 1000) as Finished;
        builder!.free();
        builder = null;
        return { artifact: complete(finished, base), documents: finished.documents, chunks: finished.chunks };
    };

    /**
     * Keep a complete artifact of everything so far, and carry on from it.
     *
     * The next builder starts from the checkpoint and has every note done so
     * far re-added — a read and a hash per note, since each comes back reused.
     */
    const checkpointAndContinue = async () => {
        const { artifact } = finishBuilder();
        await input.checkpoint(artifact);
        base = artifact;
        builder = open(input.spec, base);
        for (const note of added) {
            const again = builder.addDocument(note.path, await note.read(), note.mtime) as { reused: boolean };
            if (!again.reused) {
                // A note edited while the build ran. Rather than mix two
                // versions of it, stop: the next build picks it up.
                throw new Error(`${note.path} changed during the build — run it again`);
            }
        }
        lastCheckpoint = input.now();
    };

    try {
        for (const note of notes) {
            if (input.signal.aborted) {
                break;
            }
            const result = builder!.addDocument(note.path, await note.read(), note.mtime) as {
                reused: boolean;
                texts: string[];
            };
            added.push(note);
            if (result.reused) {
                notesReused++;
                done++;
                if (notesReused % 200 === 0) {
                    report();
                    await input.yieldToUi();
                }
                continue;
            }
            queue.push({ path: note.path, texts: result.texts });
            queuedChunks += result.texts.length;
            if (queuedChunks >= batchChunks) {
                await flush();
                if (input.now() - lastCheckpoint >= every && !input.signal.aborted) {
                    await checkpointAndContinue();
                }
            }
        }
        // Canceled or not, what is queued is finished: it is at most one
        // batch, and a builder with notes still waiting for vectors cannot be
        // finished at all.
        await flush();
        report();

        const canceled = input.signal.aborted;
        if (canceled && added.length === 0) {
            // Stopped before the first note: nothing new to keep.
            return { artifact: null, documents: 0, chunks: 0, chunksEmbedded, notesReused, canceled };
        }
        const { artifact, documents, chunks } = finishBuilder();
        if (canceled) {
            await input.checkpoint(artifact);
        }
        return { artifact, documents, chunks, chunksEmbedded, notesReused, canceled };
    } finally {
        added = [];
        queue = [];
        builder?.free();
    }
}
