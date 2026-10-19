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
 * An ONNX Runtime WebAssembly binary: where the worker fetches it, and the
 * hash it must match.
 *
 * Computed from the copy npm installed rather than written down, so updating
 * transformers.js — which pins onnxruntime-web exactly — moves the URL and the
 * hash together and they cannot disagree. jsDelivr serves npm's tarballs
 * byte for byte, which is what makes a hash taken here valid for its URL.
 *
 * Two of them. The CPU build (`ort-wasm-simd-threaded.wasm`, 13.6 MB) is what
 * most machines run. The WebGPU build (`.asyncify.wasm`, 25.6 MB) is
 * downloaded only where the GPU is used: each pairs with its own ONNX Runtime
 * JavaScript, so each has its own worker bundle (see the alias below).
 */
export function onnxRuntime(file = "ort-wasm-simd-threaded.wasm") {
    // Resolved from transformers.js, so it is the copy it would load.
    const fromTransformers = createRequire(require.resolve("@huggingface/transformers"));
    const dist = dirname(fromTransformers.resolve("onnxruntime-web/wasm"));
    const { version } = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8"));
    const bytes = readFileSync(join(dist, file));
    return {
        url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/${file}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
    };
}

/** The `define` entries the plugin reads the runtime pins from. */
export function runtimeDefine() {
    return {
        GNOSIS_ORT_RUNTIME: JSON.stringify(onnxRuntime()),
        GNOSIS_ORT_GPU_RUNTIME: JSON.stringify(onnxRuntime("ort-wasm-simd-threaded.asyncify.wasm")),
    };
}

/**
 * Resolve `worker:<path>` to that file's bundled source, as text, against ONNX
 * Runtime's CPU build, and `worker-gpu:<path>` the same against its WebGPU
 * build.
 */
export function workerPlugin({ minify }) {
    return {
        name: "gnosis-worker",
        setup(build) {
            build.onResolve({ filter: /^worker(-gpu)?:/ }, (args) => {
                const gpu = args.path.startsWith("worker-gpu:");
                return {
                    path: resolve(args.resolveDir, args.path.slice(gpu ? "worker-gpu:".length : "worker:".length)),
                    namespace: gpu ? "gnosis-worker-gpu" : "gnosis-worker",
                };
            });
            build.onLoad({ filter: /.*/, namespace: "gnosis-worker-gpu" }, (args) => bundleWorker(args.path, { minify, gpu: true }));
            build.onLoad({ filter: /.*/, namespace: "gnosis-worker" }, (args) => bundleWorker(args.path, { minify, gpu: false }));
        },
    };
}

async function bundleWorker(path, { minify, gpu }) {
    const result = await esbuild.build({
        entryPoints: [path],
        bundle: true,
        write: false,
        metafile: true,
        format: "iife",
        platform: "browser",
        target: "es2022",
        minify,
        logLevel: "warning",
        // transformers.js imports ONNX Runtime's WebGPU build, which only runs
        // the 25.6 MB asyncify binary. The CPU worker swaps in the plain wasm
        // build, which runs the 13.6 MB one. Either way the build bundles its
        // own loader, so no ONNX Runtime JavaScript is ever fetched — only the
        // binary, which the worker verifies by hash.
        alias: gpu ? {} : { "onnxruntime-web/webgpu": "onnxruntime-web/wasm" },
        define: {
            // ONNX Runtime locates its files from `import.meta.url`, which an
            // IIFE does not have. The binary is handed over directly, so the
            // path is never taken.
            "import.meta.url": '"gnosis://worker"',
        },
    });
    return {
        contents: result.outputFiles[0].text,
        loader: "text",
        watchFiles: Object.keys(result.metafile?.inputs ?? {}),
    };
}
