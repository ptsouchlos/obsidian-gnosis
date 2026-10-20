// Bundle the tests with Obsidian's API swapped for the stub.
//
// The plugin imports `obsidian`, which has no runtime at all outside the app —
// the npm package is type definitions. Aliasing it at bundle time is what lets
// the plugin's real code run under node, against the real WebAssembly module
// and a real artifact on disk.
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runtimeDefine, workerPlugin } from "../script/esbuild-worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const vault = join(here, "fixtures", "vault");

// The stub, compiled on its own so the bundle test and the shipped `main.js`
// can share one instance of it: `test/bundle.test.cjs` requires this file and
// hands it to `main.js` in place of `obsidian`, which is how a test can read
// the notices a bundled, minified plugin raised.
await esbuild.build({
    entryPoints: ["test/stubs/obsidian.ts"],
    bundle: true,
    outfile: ".test-build/obsidian-stub.cjs",
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "warning",
});

await esbuild.build({
    entryPoints: [
        "test/plugin.test.ts",
        "test/semantic.test.ts",
        "test/build.test.ts",
        "test/parity.test.ts",
        "test/image-parity.test.ts",
        "test/real-vault.test.ts",
        "test/layout.test.ts",
        "test/diagnostics.test.ts",
    ],
    bundle: true,
    outdir: ".test-build",
    outExtension: { ".js": ".cjs" },
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "warning",
    sourcemap: "inline",
    loader: { ".wasm": "binary" },
    alias: { obsidian: "./test/stubs/obsidian.ts" },
    // Loaded from node_modules at run time, as its node build: it carries
    // ONNX Runtime's native addon, which cannot be bundled.
    external: ["@huggingface/transformers"],
    plugins: [workerPlugin({ minify: false })],
    define: {
        // The same inert value the plugin bundle uses, for the same reason.
        // It is why the fixture path is injected rather than derived from
        // `import.meta.url` in the test itself.
        "import.meta.url": '"gnosis://inlined"',
        GNOSIS_TEST_VAULT: JSON.stringify(vault),
        ...runtimeDefine(),
    },
});
