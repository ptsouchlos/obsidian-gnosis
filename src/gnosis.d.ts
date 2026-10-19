// esbuild's `binary` loader hands a `.wasm` import over as a `Uint8Array`.
declare module "*.wasm" {
    const bytes: Uint8Array;
    export default bytes;
}

// `worker:<path>` is bundled on its own by `script/esbuild-worker.mjs` and
// handed over as source text, which the plugin starts from a blob: a plugin
// ships as one `main.js` and has no URL to point a worker at.
declare module "worker:*" {
    const source: string;
    export default source;
}

// The same, bundled against ONNX Runtime's WebGPU build rather than its CPU one.
declare module "worker-gpu:*" {
    const source: string;
    export default source;
}
