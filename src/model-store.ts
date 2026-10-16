//! What this device holds of a model, and removing exactly that.
//!
//! The model's files live in transformers.js's Cache Storage, which is
//! Obsidian's, not the plugin's: every plugin in every vault shares it, and
//! other plugins keep their own models there too (measured on a real install:
//! Seek's and another plugin's, beside this one's). So nothing here clears a
//! cache wholesale. It removes the entries under this model's own repository,
//! and the runtime from the cache only Gnosis writes.

import type { QueryModel } from "./models.js";

/** transformers.js's `env.cacheKey`, which the worker leaves at its default. */
const MODEL_CACHE = "transformers-cache";
/**
 * The worker's own cache for ONNX Runtime's `.wasm`, verified before it is
 * kept, so a second session downloads nothing.
 */
export const RUNTIME_CACHE = "gnosis-onnxruntime";

export interface Held {
    /** Bytes of this model's files on this device. */
    modelBytes: number;
    /** Whether the model's weights — the file that matters — are among them. */
    modelComplete: boolean;
    runtimeBytes: number;
}

export interface ModelStore {
    held(model: QueryModel, runtimeUrl: string): Promise<Held>;
    /** Remove this model's files and the runtime. Returns the bytes freed. */
    remove(model: QueryModel, runtimeUrl: string): Promise<number>;
}

/** Every URL transformers.js fetches for a repository starts with this. */
export function repoPrefix(model: QueryModel): string {
    return `https://huggingface.co/${model.repo}/resolve/`;
}

/** The weights, as transformers.js names them for `dtype: "fp32"`. */
export function weightsUrl(model: QueryModel): string {
    return `${repoPrefix(model)}${model.revision}/onnx/model.onnx`;
}

async function size(response: Response): Promise<number> {
    const header = response.headers.get("content-length");
    if (header !== null && /^\d+$/.test(header)) {
        return Number(header);
    }
    return (await response.arrayBuffer()).byteLength;
}

export class BrowserModelStore implements ModelStore {
    async held(model: QueryModel, runtimeUrl: string): Promise<Held> {
        const held: Held = { modelBytes: 0, modelComplete: false, runtimeBytes: 0 };
        // `has` first: `open` would create an empty cache just to look in it.
        if (await caches.has(MODEL_CACHE)) {
            const cache = await caches.open(MODEL_CACHE);
            const prefix = repoPrefix(model);
            const weights = weightsUrl(model);
            for (const request of await cache.keys()) {
                if (!request.url.startsWith(prefix)) {
                    continue;
                }
                const response = await cache.match(request);
                if (response !== undefined) {
                    held.modelBytes += await size(response);
                    held.modelComplete ||= request.url === weights;
                }
            }
        }
        if (await caches.has(RUNTIME_CACHE)) {
            const runtime = await (await caches.open(RUNTIME_CACHE)).match(runtimeUrl);
            if (runtime !== undefined) {
                held.runtimeBytes = await size(runtime);
            }
        }
        return held;
    }

    async remove(model: QueryModel, runtimeUrl: string): Promise<number> {
        const { modelBytes, runtimeBytes } = await this.held(model, runtimeUrl);
        if (await caches.has(MODEL_CACHE)) {
            const cache = await caches.open(MODEL_CACHE);
            const prefix = repoPrefix(model);
            for (const request of await cache.keys()) {
                if (request.url.startsWith(prefix)) {
                    await cache.delete(request);
                }
            }
        }
        if (await caches.has(RUNTIME_CACHE)) {
            await (await caches.open(RUNTIME_CACHE)).delete(runtimeUrl);
        }
        return modelBytes + runtimeBytes;
    }
}

/** For tests: a model either held at its stated size, or not. */
export class MemoryModelStore implements ModelStore {
    readonly held_ = new Set<string>();

    async held(model: QueryModel): Promise<Held> {
        const has = this.held_.has(model.repo);
        return { modelBytes: has ? model.downloadBytes : 0, modelComplete: has, runtimeBytes: has ? 14_300_000 : 0 };
    }

    async remove(model: QueryModel): Promise<number> {
        const freed = this.held_.has(model.repo) ? model.downloadBytes + 14_300_000 : 0;
        this.held_.delete(model.repo);
        return freed;
    }
}
