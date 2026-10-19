//! The embedding worker: transformers.js, off the main thread.
//!
//! A worker for two reasons. Inference is tens of milliseconds per query and
//! far more per indexing batch, which on the main thread is typing that
//! stutters. And it is the one context in Obsidian where transformers.js can
//! be made to take its web path at all — see `web-env.ts`.
//!
//! Bundled twice, against ONNX Runtime's CPU build and its WebGPU build (see
//! `script/esbuild-worker.mjs`); the plugin starts the one for the device it
//! chose, and tells it which runtime binary to load.
//!
//! What this downloads, and nothing else, is what the consent prompt states:
//! the model's files from Hugging Face at a pinned revision, and ONNX
//! Runtime's WebAssembly binary from jsDelivr, verified against a hash fixed at
//! build time. ONNX Runtime's JavaScript is bundled rather than fetched, so no
//! remote code runs. Notes never cross this boundary except as text to embed,
//! and nothing here sends anything anywhere.

import "./web-env.js";
import { RUNTIME_CACHE } from "../model-store.js";
import { env, pipeline } from "@huggingface/transformers";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import type { Done, LoadRequest, Progress, Request, Response, RuntimeSpec } from "./protocol.js";

interface Loaded {
    extractor: FeatureExtractionPipeline;
    pooling: "cls" | "mean";
}

let loaded: Loaded | null = null;

function post(message: Response, transfer: Transferable[] = []): void {
    (self as unknown as Worker).postMessage(message, transfer);
}

function hex(buffer: ArrayBuffer): string {
    return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read a response body, reporting bytes as they arrive. */
async function readWithProgress(
    response: globalThis.Response,
    report: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
    const total = Number(response.headers.get("content-length") ?? 0);
    const reader = response.body?.getReader();
    if (!reader) {
        return new Uint8Array(await response.arrayBuffer());
    }
    const parts: Uint8Array[] = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        parts.push(value);
        received += value.byteLength;
        report(received, total);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }
    return bytes;
}

/**
 * ONNX Runtime's `.wasm`, from the cache or the network, verified.
 *
 * Verified *before* it is cached, so a corrupted or substituted download is
 * never kept, and again on every read, because a cache is storage and storage
 * can be tampered with. A mismatch is an error, not a retry: it means the
 * pinned file is not what is being served.
 */
async function runtimeBinary(runtime: RuntimeSpec, onProgress: (p: Progress) => void, id: number): Promise<Uint8Array> {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(runtime.url);
    let bytes: Uint8Array;
    if (cached) {
        bytes = new Uint8Array(await cached.arrayBuffer());
    } else {
        const response = await fetch(runtime.url);
        if (!response.ok) {
            throw new Error(`downloading ONNX Runtime from ${runtime.url} failed: HTTP ${response.status}`);
        }
        bytes = await readWithProgress(response, (got, total) =>
            onProgress({ id, type: "progress", file: "onnxruntime-web.wasm", loaded: got, total }),
        );
    }
    const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
    if (digest !== runtime.sha256) {
        await cache.delete(runtime.url);
        throw new Error(
            `ONNX Runtime from ${runtime.url} does not match the pinned hash ` +
                `(got ${digest}, expected ${runtime.sha256}) — refusing to run it`,
        );
    }
    if (!cached) {
        // With its length, so the settings tab can say how much is held
        // without reading 14 MB to find out.
        await cache.put(
            runtime.url,
            new globalThis.Response(bytes, { headers: { "content-length": String(bytes.byteLength) } }),
        );
    }
    return bytes;
}

async function load(request: LoadRequest): Promise<void> {
    const onnx = env.backends.onnx as {
        wasm?: { wasmBinary?: Uint8Array; wasmPaths?: unknown; numThreads?: number };
    };
    if (onnx.wasm === undefined) {
        throw new Error("transformers.js did not set up its WebAssembly backend");
    }
    onnx.wasm.wasmBinary = await runtimeBinary(request.runtime, post, request.id);
    // transformers.js points this at jsDelivr by default, and would download
    // the binary a second time, unverified.
    onnx.wasm.wasmPaths = undefined;
    // Threads need a cross-origin-isolated page, which Obsidian is not; one
    // thread is what ONNX Runtime would fall back to, said explicitly.
    onnx.wasm.numThreads = 1;

    env.allowLocalModels = false;
    env.useBrowserCache = true;

    const extractor = await pipeline("feature-extraction", request.repo, {
        revision: request.revision,
        dtype: request.dtype,
        device: request.device,
        progress_callback: (info) => {
            if (info.status === "progress") {
                post({ id: request.id, type: "progress", file: info.file, loaded: info.loaded, total: info.total });
            }
        },
    });
    loaded = { extractor, pooling: request.pooling };
}

async function embed(id: number, texts: string[]): Promise<Done> {
    if (loaded === null) {
        throw new Error("the embedder was asked to embed before a model was loaded");
    }
    // `normalize` because gnosis's stored vectors are unit length — fastembed
    // normalizes — and its dense score is a dot product that assumes it.
    const output = await loaded.extractor(texts, { pooling: loaded.pooling, normalize: true });
    const dim = output.dims.at(-1) ?? 0;
    const vectors = Float32Array.from(output.data as Float32Array);
    return { id, type: "done", vectors, dim };
}

self.onmessage = (event: MessageEvent<Request>) => {
    const request = event.data;
    const run = async (): Promise<void> => {
        if (request.type === "load") {
            await load(request);
            post({ id: request.id, type: "done" });
        } else {
            const done = await embed(request.id, request.texts);
            post(done, done.vectors ? [done.vectors.buffer] : []);
        }
    };
    run().catch((error: unknown) => {
        post({
            id: request.id,
            type: "error",
            message: error instanceof Error ? error.message : String(error),
        });
    });
};
