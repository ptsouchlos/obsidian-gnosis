//! The plugin's PDF extraction: `pdf-extract` in a worker, one file per worker.
//!
//! The worker is one-shot — a fresh one per file, killed when its one file is
//! done, failed or hung — because the extract bundle's `wasm-release` profile
//! aborts on panic: a malformed PDF that traps the wasm instance cannot serve
//! the next file, and a worker the host started for one file has nothing left
//! to lose. The host's only other job is a timeout, because a parse that is
//! running takes seconds while a parse that is hung takes forever, and a build
//! cannot wait for the second.
//!
//! The wasm is inlined in the worker, as the query client's module is in
//! `main.js`, so extraction downloads nothing and runs offline. Nothing
//! crosses this boundary except the file's bytes in and its title and page
//! texts out, and nothing here sends anything anywhere.

import workerSource from "worker:./worker/extract-worker.ts";
import type { Response } from "./worker/extract-protocol.js";

/** A PDF's title and per-page text, in document order, as `setPdfPages` wants. */
export interface Extracted {
    /** Empty when the PDF has no metadata title; the caller substitutes the file stem. */
    title: string;
    pages: { page: number; text: string }[];
}

/**
 * How long one PDF may take before its worker is killed and the file skipped.
 *
 * A parse that is running takes seconds; this is what separates a parse that
 * is hung from one that is slow. The value comes from the build measurements
 * in the plan's step 3e.
 */
export const PDF_EXTRACT_TIMEOUT_MS = 60_000;

/**
 * Extract one PDF's title and per-page text.
 *
 * Rejects for the per-file skips — the bytes are not a readable PDF, the PDF
 * has no text anywhere — and when the worker fails or hangs; the caller drops
 * the file from the build either way, which is what the plan calls respawning:
 * the next file simply gets its own fresh worker.
 */
export async function extractPdfFile(bytes: Uint8Array): Promise<Extracted> {
    // From a blob, like the embedder: a plugin ships as one `main.js` and has
    // no URL of its own to point a worker at.
    const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    const worker = new Worker(url);
    try {
        return await new Promise<Extracted>((resolve, reject) => {
            let timer: number | undefined;
            worker.onmessage = (event: MessageEvent<Response>) => {
                window.clearTimeout(timer);
                const response = event.data;
                if (response.type === "error") {
                    reject(new Error(response.message));
                } else {
                    resolve({ title: response.title, pages: response.pages });
                }
            };
            worker.onerror = (event) => {
                window.clearTimeout(timer);
                reject(new Error(`the extraction worker failed: ${event.message}`));
            };
            timer = window.setTimeout(
                () => reject(new Error(`the extraction worker hung; killed after ${PDF_EXTRACT_TIMEOUT_MS} ms`)),
                PDF_EXTRACT_TIMEOUT_MS,
            );
            // The one request; the id is fixed because the worker is one-shot.
            worker.postMessage({ id: 1, type: "extract", bytes });
        });
    } finally {
        // Whether it answered, failed or hung, the worker is one file done and
        // has nothing left to say.
        worker.terminate();
        URL.revokeObjectURL(url);
    }
}
