// Bundle the plugin into the single `main.js` Obsidian loads.
//
// The community-plugin channel ships exactly three files — main.js,
// manifest.json, styles.css — so the WebAssembly module is inlined into the
// bundle rather than fetched. esbuild's `binary` loader turns the `.wasm` into
// a Uint8Array the glue can instantiate directly, so search and related notes
// work offline. The embedding worker is inlined the same way, as source text
// (`script/esbuild-worker.mjs`): the only thing fetched at run time is what the
// reader consents to for semantic search, and none of it is JavaScript.
import esbuild from "esbuild";
import builtins from "builtin-modules";
import { runtimeDefine, workerPlugin } from "./script/esbuild-worker.mjs";

const production = process.argv[2] === "production";

const context = await esbuild.context({
    entryPoints: ["src/main.ts"],
    bundle: true,
    outfile: "main.js",
    format: "cjs",
    target: "es2022",
    platform: "browser",
    logLevel: "info",
    sourcemap: production ? false : "inline",
    minify: production,
    treeShaking: true,
    loader: { ".wasm": "binary" },
    plugins: [workerPlugin({ minify: production })],
    // Obsidian provides these at runtime; bundling them would ship a second
    // copy of the editor.
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
    define: {
        // wasm-pack's `web` glue reads `import.meta.url` to find its `.wasm`
        // next to itself. That path is never taken here — the bytes are passed
        // in explicitly — but `import.meta` does not exist in a CommonJS
        // bundle, so it is defined to something inert rather than left to
        // throw if the fallback is ever reached.
        "import.meta.url": '"gnosis://inlined"',
        ...runtimeDefine(),
    },
});

if (production) {
    await context.rebuild();
    await context.dispose();
} else {
    await context.watch();
}
