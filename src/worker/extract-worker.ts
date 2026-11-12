//! The PDF extraction worker: `pdf-extract`, one file per worker.
//!
//! Off the main thread because a large PDF's parse and text walk take seconds,
//! which on the main thread would be a frozen UI. One file per worker, and a
//! fresh worker per file, because the extract bundle's `wasm-release` profile
//! has `panic = "abort"`: a malformed PDF that panics traps the whole wasm
//! instance, and a trapped instance cannot serve the next file. A worker the
//! host starts for one file has nothing left to lose.
//!
//! The wasm is inlined with the `binary` loader, as the query client's module
//! is, so extraction downloads nothing and runs offline. Nothing crosses this
//! boundary except the file's bytes in and its title and page texts out, and
//! nothing here sends anything anywhere.

import init, { extractPdf } from "../../vendor/gnosis-extract/gnosis_extract.js";
import wasmBytes from "../../vendor/gnosis-extract/gnosis_extract_bg.wasm";
import type { ExtractRequest, Response } from "./extract-protocol.js";

/**
 * Instantiate the module at load, without waiting for it: the host posts its
 * single request as soon as the worker is up, and awaiting `init` here would
 * leave `onmessage` unset until the first (and only) message had already
 * arrived. `onmessage` awaits this instead.
 */
const ready = init({ module_or_path: wasmBytes });

self.onmessage = async (event: MessageEvent<ExtractRequest>) => {
    const { id, bytes } = event.data;
    try {
        await ready;
        // The glue types the result as `unknown`; its shape is the contract
        // in the extract bundle's docs, checked here so both sides share it.
        const { title, pages } = extractPdf(bytes) as {
            title: string;
            pages: { page: number; text: string }[];
        };
        post({ id, type: "done", title, pages });
    } catch (error) {
        // A rejection from the glue (not a PDF, no text anywhere) and a
        // trap-surface failure both land here, as one `error` per the protocol.
        post({ id, type: "error", message: error instanceof Error ? error.message : String(error) });
    }
};

function post(message: Response): void {
    (self as unknown as Worker).postMessage(message);
}
