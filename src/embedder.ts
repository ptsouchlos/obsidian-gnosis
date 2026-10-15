//! Embedding a query in the index's own vector space.
//!
//! Everything that decides *how* a query is embedded comes from the index:
//! the model id (which picks the files to download), the pooling and the query
//! prefix. The prefix is the subtle one — bge-small wants an instruction before
//! every query, E5 wants `query: `, and an index can be built with neither — and
//! getting it wrong produces a perfectly healthy vector that ranks worse. So it
//! is read from the manifest and never inferred here.

import workerSource from "worker:./worker/embed-worker.ts";
import { queryModelFor, type QueryModel } from "./models.js";
import type { EmbedRequest, LoadRequest, Response } from "./worker/protocol.js";
import type { SpaceInfo } from "./types.js";

/** Bytes downloaded so far, for a progress report. */
export interface DownloadProgress {
    file: string;
    loaded: number;
    total: number;
}

/** Something that turns text into unit vectors of one fixed dimension. */
export interface TextEmbedder {
    embed(texts: string[]): Promise<Float32Array[]>;
    dispose(): void;
}

/** Starts an embedder for a model; swapped out in tests. */
export type EmbedderFactory = (
    model: QueryModel,
    pooling: "cls" | "mean",
    onProgress: (progress: DownloadProgress) => void,
) => Promise<TextEmbedder>;

/** ONNX Runtime's `.wasm`: URL, pinned hash and size, fixed at build time. */
declare const GNOSIS_ORT_RUNTIME: { url: string; sha256: string; bytes: number };
export const RUNTIME = GNOSIS_ORT_RUNTIME;

/** Why semantic search cannot run on this index, or null if it can. */
export function unsupportedReason(space: SpaceInfo): string | null {
    if (queryModelFor(space.queryModel) === null) {
        return `semantic search does not support '${space.queryModel}' yet — lexical search and related notes still work`;
    }
    if (space.pooling !== "cls" && space.pooling !== "mean") {
        return `the index records pooling '${space.pooling}', which this plugin does not know`;
    }
    return null;
}

/**
 * The vectors `Index.search` takes for `query`: one per space searched.
 *
 * Only the text space for now. The image space needs CLIP's text tower, a
 * second model, and a space that is not given a vector is simply not searched
 * — which is the honest behavior rather than a silently partial one.
 */
export async function queryVectors(
    embedder: TextEmbedder,
    space: SpaceInfo,
    query: string,
): Promise<Map<string, Float32Array>> {
    const [vector] = await embedder.embed([`${space.queryPrefix}${query}`]);
    if (vector === undefined || vector.length !== space.dim) {
        throw new Error(
            `the embedder produced a ${vector?.length ?? 0}d vector for an index of ${space.dim}d — ` +
                `it is not the model the index was built with`,
        );
    }
    return new Map([[space.space, vector]]);
}

/** The embedder that ships: transformers.js in a worker. */
export const startWorkerEmbedder: EmbedderFactory = async (model, pooling, onProgress) => {
    const embedder = new WorkerEmbedder(onProgress);
    try {
        await embedder.request({
            type: "load",
            repo: model.repo,
            revision: model.revision,
            dtype: model.dtype,
            pooling,
            runtime: { url: RUNTIME.url, sha256: RUNTIME.sha256 },
        });
    } catch (error) {
        embedder.dispose();
        throw error;
    }
    return embedder;
};

/** A request before the client numbers it. */
type Unsent = Omit<LoadRequest, "id"> | Omit<EmbedRequest, "id">;

interface Pending {
    resolve: (response: Response & { type: "done" }) => void;
    reject: (error: Error) => void;
}

class WorkerEmbedder implements TextEmbedder {
    private readonly worker: Worker;
    private readonly url: string;
    private readonly pending = new Map<number, Pending>();
    private next = 1;

    constructor(private readonly onProgress: (progress: DownloadProgress) => void) {
        // From a blob, because a plugin ships as one `main.js` and has no URL
        // of its own to point a worker at.
        this.url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
        this.worker = new Worker(this.url);
        this.worker.onmessage = (event: MessageEvent<Response>) => this.receive(event.data);
        this.worker.onerror = (event) => {
            const error = new Error(`the embedding worker failed: ${event.message}`);
            for (const pending of this.pending.values()) {
                pending.reject(error);
            }
            this.pending.clear();
        };
    }

    request(message: Unsent): Promise<Response & { type: "done" }> {
        const id = this.next++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ ...message, id });
        });
    }

    async embed(texts: string[]): Promise<Float32Array[]> {
        const done = await this.request({ type: "embed", texts });
        const { vectors, dim } = done;
        if (vectors === undefined || dim === undefined || dim === 0) {
            throw new Error("the embedding worker returned no vectors");
        }
        const out: Float32Array[] = [];
        for (let i = 0; i < texts.length; i++) {
            out.push(vectors.subarray(i * dim, (i + 1) * dim));
        }
        return out;
    }

    dispose(): void {
        this.worker.terminate();
        URL.revokeObjectURL(this.url);
        const error = new Error("the embedder was shut down");
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }

    private receive(message: Response): void {
        if (message.type === "progress") {
            this.onProgress({ file: message.file, loaded: message.loaded, total: message.total });
            return;
        }
        const pending = this.pending.get(message.id);
        if (pending === undefined) {
            return;
        }
        this.pending.delete(message.id);
        if (message.type === "error") {
            pending.reject(new Error(message.message));
        } else {
            pending.resolve(message);
        }
    }
}
