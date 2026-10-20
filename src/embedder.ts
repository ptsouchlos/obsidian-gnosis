//! Embedding a query in the index's own vector space.
//!
//! Everything that decides *how* a query is embedded comes from the index:
//! the model id (which picks the files to download), the pooling and the query
//! prefix. The prefix is the subtle one — bge-small wants an instruction before
//! every query, E5 wants `query: `, and an index can be built with neither — and
//! getting it wrong produces a perfectly healthy vector that ranks worse. So it
//! is read from the manifest and never inferred here.

import workerSource from "worker:./worker/embed-worker.ts";
import gpuWorkerSource from "worker-gpu:./worker/embed-worker.ts";
import { queryModelFor, type QueryModel } from "./models.js";
import type { Device, EmbedImagesRequest, EmbedRequest, LoadRequest, Response } from "./worker/protocol.js";
import type { SpaceInfo } from "./types.js";

export type { Device } from "./worker/protocol.js";

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

/**
 * Something that turns the bytes of image files into unit vectors, with the
 * files that would not decode left out of them.
 */
export interface ImageEmbedder {
    embedImages(images: Uint8Array[]): Promise<ImageVectors>;
    dispose(): void;
}

export interface ImageVectors {
    /** One per image, in order; a file that failed has a zero vector. */
    vectors: Float32Array[];
    /** The files that would not decode, by position, and why. */
    failed: Map<number, string>;
}

/** Starts the vision tower on a device; swapped out in tests. */
export type VisionFactory = (
    model: QueryModel,
    onProgress: (progress: DownloadProgress) => void,
    device: Device,
) => Promise<ImageEmbedder>;

/** Starts an embedder for a model on a device; swapped out in tests. */
export type EmbedderFactory = (
    model: QueryModel,
    pooling: "cls" | "mean",
    onProgress: (progress: DownloadProgress) => void,
    device: Device,
) => Promise<TextEmbedder>;

/** An ONNX Runtime `.wasm`: URL, pinned hash and size, fixed at build time. */
export interface Runtime {
    url: string;
    sha256: string;
    bytes: number;
}

declare const GNOSIS_ORT_RUNTIME: Runtime;
declare const GNOSIS_ORT_GPU_RUNTIME: Runtime;
/** The CPU build, 13.6 MB, and the WebGPU build, 25.6 MB, each for its own worker. */
export const RUNTIMES: Readonly<Record<Device, Runtime>> = {
    wasm: GNOSIS_ORT_RUNTIME,
    webgpu: GNOSIS_ORT_GPU_RUNTIME,
};

/**
 * Chunks per model call while building. The GPU was measured fastest at 64
 * (332 chunks/s, against 273 at 16); the CPU keeps the CLI's 16.
 */
export const BATCH_CHUNKS: Readonly<Record<Device, number>> = { wasm: 16, webgpu: 64 };

/**
 * CPU threads for the model: half the logical cores. Measured in Obsidian on
 * 24: 2.7 chunks/s on one, 18 on eight, 19 on twelve, 22 on sixteen and 14 on
 * all 24, where they compete with Obsidian itself. Half leaves the other half
 * for the app while a build runs.
 */
export function cpuThreads(): number {
    const cores = typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency || 1;
    return Math.max(1, Math.floor(cores / 2));
}

/**
 * Whether this device has a WebGPU adapter. False on Linux unless Obsidian
 * was started with WebGPU flags: Chromium leaves it off there.
 */
export async function webgpuAdapter(): Promise<boolean> {
    try {
        const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
        return gpu !== undefined && (await gpu.requestAdapter()) !== null;
    } catch {
        return false;
    }
}

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

/** The embedder that ships: transformers.js in a worker, built for `device`. */
export const startWorkerEmbedder: EmbedderFactory = async (model, pooling, onProgress, device) => {
    const embedder = new WorkerEmbedder(device === "webgpu" ? gpuWorkerSource : workerSource, onProgress);
    const runtime = RUNTIMES[device];
    try {
        await embedder.request({
            type: "load",
            repo: model.repo,
            revision: model.revision,
            dtype: model.dtype,
            subfolder: model.subfolder,
            architecture: model.architecture,
            pooling,
            runtime: { url: runtime.url, sha256: runtime.sha256 },
            device,
            // The GPU worker's build bundles its loader and runs one thread.
            threads: device === "wasm" ? cpuThreads() : 1,
        });
    } catch (error) {
        embedder.dispose();
        throw error;
    }
    return embedder;
};

/** The vision tower: CLIP's image encoder, in a worker, built for `device`. */
export const startWorkerVision: VisionFactory = async (model, onProgress, device) => {
    const embedder = new WorkerEmbedder(device === "webgpu" ? gpuWorkerSource : workerSource, onProgress);
    const runtime = RUNTIMES[device];
    try {
        await embedder.request({
            type: "load",
            repo: model.repo,
            revision: model.revision,
            dtype: model.dtype,
            subfolder: model.subfolder,
            architecture: model.architecture,
            pooling: model.pooling,
            runtime: { url: runtime.url, sha256: runtime.sha256 },
            device,
            threads: device === "wasm" ? cpuThreads() : 1,
        });
    } catch (error) {
        embedder.dispose();
        throw error;
    }
    return embedder;
};

/** A request before the client numbers it. */
type Unsent = Omit<LoadRequest, "id"> | Omit<EmbedRequest, "id"> | Omit<EmbedImagesRequest, "id">;

interface Pending {
    resolve: (response: Response & { type: "done" }) => void;
    reject: (error: Error) => void;
}

class WorkerEmbedder implements TextEmbedder, ImageEmbedder {
    private readonly worker: Worker;
    private readonly url: string;
    private readonly pending = new Map<number, Pending>();
    private next = 1;

    constructor(
        source: string,
        private readonly onProgress: (progress: DownloadProgress) => void,
    ) {
        // From a blob, because a plugin ships as one `main.js` and has no URL
        // of its own to point a worker at.
        this.url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
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

    async embedImages(images: Uint8Array[]): Promise<ImageVectors> {
        const done = await this.request({ type: "embedImages", images });
        const { vectors, dim, failed } = done;
        if (vectors === undefined || dim === undefined) {
            throw new Error("the embedding worker returned no vectors");
        }
        const out: Float32Array[] = [];
        for (let i = 0; i < images.length; i++) {
            out.push(dim === 0 ? new Float32Array(0) : vectors.subarray(i * dim, (i + 1) * dim));
        }
        return { vectors: out, failed: new Map((failed ?? []).map((f) => [f.index, f.message])) };
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
