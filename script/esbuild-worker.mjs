// Bundling the embedding worker, and pinning what it downloads.
//
// Shared by the plugin build and the test build, so both ship the same worker.
//
// `import source from "worker:./worker/embed-worker.ts"` bundles that file on
// its own, as a browser worker, and hands its source over as a string: a plugin
// is one `main.js` and has no URL a worker could be started from, so it is
// started from a blob of this text instead.
import esbuild from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

/**
 * ONNX Runtime's WebAssembly binary: where the worker fetches it, and the hash
 * it must match.
 *
 * Computed from the copy npm installed rather than written down, so updating
 * transformers.js — which pins onnxruntime-web exactly — moves the URL and the
 * hash together and they cannot disagree. jsDelivr serves npm's tarballs
 * byte for byte, which is what makes a hash taken here valid for its URL.
 *
 * The CPU-only build (`ort-wasm-simd-threaded.wasm`, 13.6 MB), not the WebGPU
 * one transformers.js defaults to (26 MB): see the alias below.
 */
export function onnxRuntime() {
    // Resolved from transformers.js, so it is the copy it would load.
    const fromTransformers = createRequire(require.resolve("@huggingface/transformers"));
    const dist = dirname(fromTransformers.resolve("onnxruntime-web/wasm"));
    const { version } = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8"));
    const file = "ort-wasm-simd-threaded.wasm";
    const bytes = readFileSync(join(dist, file));
    return {
        url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/${file}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
    };
}

/** The `define` entry the plugin reads the runtime pin from. */
export function runtimeDefine() {
    return { GNOSIS_ORT_RUNTIME: JSON.stringify(onnxRuntime()) };
}

/** Resolve `worker:<path>` to that file's bundled source, as text. */
export function workerPlugin({ minify }) {
    return {
        name: "gnosis-worker",
        setup(build) {
            build.onResolve({ filter: /^worker:/ }, (args) => ({
                path: resolve(args.resolveDir, args.path.slice("worker:".length)),
                namespace: "gnosis-worker",
            }));
            build.onLoad({ filter: /.*/, namespace: "gnosis-worker" }, async (args) => {
                const result = await esbuild.build({
                    entryPoints: [args.path],
                    bundle: true,
                    write: false,
                    metafile: true,
                    format: "iife",
                    platform: "browser",
                    target: "es2022",
                    minify,
                    logLevel: "warning",
                    // transformers.js imports ONNX Runtime's WebGPU build, which
                    // only runs the 26 MB asyncify binary. The plain wasm build
                    // runs the 13.6 MB one and bundles its own loader, so no
                    // ONNX Runtime JavaScript is ever fetched — only the binary,
                    // which the worker verifies by hash.
                    alias: { "onnxruntime-web/webgpu": "onnxruntime-web/wasm" },
                    define: {
                        // ONNX Runtime locates its files from `import.meta.url`,
                        // which an IIFE does not have. The binary is handed over
                        // directly, so the path is never taken.
                        "import.meta.url": '"gnosis://worker"',
                    },
                });
                return {
                    contents: result.outputFiles[0].text,
                    loader: "text",
                    watchFiles: Object.keys(result.metafile?.inputs ?? {}),
                };
            });
        },
    };
}
