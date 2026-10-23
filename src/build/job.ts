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

import { Builder, contentHashBytes } from "../../vendor/gnosis-wasm/gnosis_wasm.js";
import type { RawArtifact } from "../artifact.js";
import type { ImageVectors } from "../embedder.js";

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
    /**
     * Build the image space too: images become documents and every document
     * gets a title proxy, as `gnosis index` does with `[embed.image]` on.
     */
    image?: ImageSpec;
}

/** The image space a build records: CLIP's two towers, which share an id. */
export interface ImageSpec {
    /** The vision model's id, as the manifest will record the space's model. */
    model: string;
    /** The text tower's id: what queries the space and embeds the title proxies. */
    queryId: string;
    dim: number;
}

/** One note, read lazily: most notes in an incremental build are reused. */
export interface Note {
    path: string;
    /** Milliseconds, as Obsidian reports it. */
    mtime: number;
    read(): Promise<string>;
}

/** One image file, read lazily: most of an incremental build is reused. */
export interface ImageFile {
    path: string;
    /** Milliseconds, as Obsidian reports it. */
    mtime: number;
    read(): Promise<Uint8Array>;
}

export interface BuildProgress {
    notesDone: number;
    notesTotal: number;
    imagesDone: number;
    imagesTotal: number;
    /** Chunks embedded in this run — the slow part, and what the estimate uses. */
    chunksEmbedded: number;
    notesReused: number;
    elapsedMs: number;
}

export interface BuildInput {
    spec: BuildSpec;
    notes: Note[];
    /** Image files, when the spec has an image space. */
    images?: ImageFile[];
    /** What to start from: a checkpoint, the live artifact, or nothing. */
    base: RawArtifact | null;
    /** Unit vectors for exactly these strings, in order. */
    embed(texts: string[]): Promise<Float32Array[]>;
    /** Vision-tower vectors for image files, with the ones that would not decode. */
    embedImages?(images: Uint8Array[]): Promise<ImageVectors>;
    /** CLIP text-tower vectors for titles: every document's title proxy. */
    embedTitles?(titles: string[]): Promise<Float32Array[]>;
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
    /** Images per vision call, and titles per text-tower call. */
    imageBatch?: number;
    titleBatch?: number;
}

/** A file the build left out because it would not decode. */
export interface SkippedFile {
    path: string;
    message: string;
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
    /** Images embedded in this run, and carried over unchanged. */
    imagesEmbedded: number;
    imagesReused: number;
    /** Images that would not decode and are not in the index, as `gnosis index` skips them. */
    skipped: SkippedFile[];
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
        : Builder.fromArtifact(spec, base.manifestJson, base.shards);
}

export async function runBuild(input: BuildInput): Promise<BuildResult> {
    const every = input.checkpointEveryMs ?? 60_000;
    const batchChunks = input.batchChunks ?? 16;
    const imageBatch = input.imageBatch ?? 8;
    const titleBatch = input.titleBatch ?? 32;
    const started = input.now();
    // Sorted so a resumed build walks the vault in the same order, which keeps
    // its progress report meaningful. The artifact itself does not depend on it.
    const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const notes = [...input.notes].sort(byPath);
    const images = input.spec.image === undefined ? [] : [...(input.images ?? [])].sort(byPath);
    if (notes.length === 0) {
        throw new Error("the vault has no notes to index");
    }
    if (input.spec.image !== undefined && input.embedTitles === undefined) {
        throw new Error("a build with an image space needs the text tower to embed titles with");
    }
    if (images.length > 0 && input.embedImages === undefined) {
        throw new Error("a build with images needs the vision tower to embed them with");
    }

    let base = input.base;
    let builder: Builder | null = open(input.spec, base);
    let lastCheckpoint = started;
    let chunksEmbedded = 0;
    let notesReused = 0;
    let imagesEmbedded = 0;
    let imagesReused = 0;
    let done = 0;
    let imagesDone = 0;
    /** Notes and images already in the builder, which a checkpoint has to re-add. */
    let added: Note[] = [];
    let addedImages: ImageFile[] = [];
    let queue: Queued[] = [];
    let queuedChunks = 0;
    /** Images waiting for the vision tower, with their bytes. */
    let imageQueue: { file: ImageFile; bytes: Uint8Array }[] = [];
    /** Documents waiting for a title-proxy vector. */
    let titles: { path: string; title: string }[] = [];
    const skipped: SkippedFile[] = [];

    const report = () =>
        input.onProgress({
            notesDone: done,
            notesTotal: notes.length,
            imagesDone,
            imagesTotal: images.length,
            chunksEmbedded,
            notesReused,
            elapsedMs: input.now() - started,
        });

    /** Embed the queued notes' chunks, in model-sized calls, and hand the vectors over. */
    const flushText = async () => {
        while (queue.length > 0) {
            // Whole notes per call, up to the batch size — a note's vectors go
            // to the builder in one piece, so it is never half-supplied.
            const batch: Queued[] = [];
            let size = 0;
            while (queue.length > 0 && (batch.length === 0 || size + queue[0].texts.length <= batchChunks)) {
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

    /** Embed the queued images; one that will not decode is dropped, as the CLI skips it. */
    const flushImages = async () => {
        while (imageQueue.length > 0) {
            const batch = imageQueue.splice(0, imageBatch);
            const { vectors, failed } = await input.embedImages!(batch.map((b) => b.bytes));
            batch.forEach(({ file }, i) => {
                const message = failed.get(i);
                if (message === undefined) {
                    builder!.setImageVector(file.path, vectors[i]);
                    imagesEmbedded++;
                } else {
                    builder!.removeDocument(file.path);
                    skipped.push({ path: file.path, message });
                    addedImages = addedImages.filter((a) => a.path !== file.path);
                    titles = titles.filter((t) => t.path !== file.path);
                }
                imagesDone++;
            });
            report();
            await input.yieldToUi();
        }
    };

    /** Embed the queued titles with the text tower: every document's proxy. */
    const flushTitles = async () => {
        while (titles.length > 0) {
            const batch = titles.splice(0, titleBatch);
            const vectors = await input.embedTitles!(batch.map((t) => t.title));
            batch.forEach(({ path }, i) => builder!.setTitleVector(path, vectors[i]));
            await input.yieldToUi();
        }
    };

    /** Everything queued, so that no document is waiting for vectors. */
    const flush = async () => {
        await flushText();
        await flushImages();
        await flushTitles();
    };

    /** Whether enough is queued for a call to be worth making. */
    const full = () => queuedChunks >= batchChunks || imageQueue.length >= imageBatch || titles.length >= titleBatch;

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
     * The next builder starts from the checkpoint and has every note and image
     * done so far re-added — a read and a hash each, since each comes back
     * reused.
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
        for (const image of addedImages) {
            const hash = contentHashBytes(await image.read());
            const again = builder.addImage(image.path, hash, image.mtime) as { reused: boolean };
            if (!again.reused) {
                throw new Error(`${image.path} changed during the build — run it again`);
            }
        }
        lastCheckpoint = input.now();
    };

    /** Checkpoint if it is time, after a flush has left nothing waiting. */
    const maybeCheckpoint = async () => {
        if (input.now() - lastCheckpoint >= every && !input.signal.aborted) {
            await checkpointAndContinue();
        }
    };

    try {
        for (const note of notes) {
            if (input.signal.aborted) {
                break;
            }
            const result = builder.addDocument(note.path, await note.read(), note.mtime) as {
                reused: boolean;
                texts: string[];
                title?: string;
            };
            added.push(note);
            // Owed even to a reused note, when the index it came from had no
            // image space and so no proxies.
            if (result.title !== undefined) {
                titles.push({ path: note.path, title: result.title });
            }
            if (result.reused) {
                notesReused++;
                done++;
                if (notesReused % 200 === 0) {
                    report();
                    await input.yieldToUi();
                }
                if (full()) {
                    await flush();
                    await maybeCheckpoint();
                }
                continue;
            }
            queue.push({ path: note.path, texts: result.texts });
            queuedChunks += result.texts.length;
            if (full()) {
                await flush();
                await maybeCheckpoint();
            }
        }
        for (const image of images) {
            if (input.signal.aborted) {
                break;
            }
            const bytes = await image.read();
            const result = builder.addImage(image.path, contentHashBytes(bytes), image.mtime) as {
                reused: boolean;
                title?: string;
            };
            addedImages.push(image);
            if (result.title !== undefined) {
                titles.push({ path: image.path, title: result.title });
            }
            if (result.reused) {
                imagesReused++;
                imagesDone++;
            } else {
                imageQueue.push({ file: image, bytes });
            }
            if (full()) {
                await flush();
                await maybeCheckpoint();
            } else if (result.reused && imagesReused % 200 === 0) {
                report();
                await input.yieldToUi();
            }
        }
        // Canceled or not, what is queued is finished: it is at most one
        // batch, and a builder with documents still waiting for vectors cannot
        // be finished at all.
        await flush();
        report();

        const canceled = input.signal.aborted;
        if (canceled && added.length + addedImages.length === 0) {
            // Stopped before the first document: nothing new to keep.
            return {
                artifact: null,
                documents: 0,
                chunks: 0,
                chunksEmbedded,
                notesReused,
                imagesEmbedded,
                imagesReused,
                skipped,
                canceled,
            };
        }
        const { artifact, documents, chunks } = finishBuilder();
        if (canceled) {
            await input.checkpoint(artifact);
        }
        return { artifact, documents, chunks, chunksEmbedded, notesReused, imagesEmbedded, imagesReused, skipped, canceled };
    } finally {
        added = [];
        addedImages = [];
        queue = [];
        imageQueue = [];
        titles = [];
        builder?.free();
    }
}
