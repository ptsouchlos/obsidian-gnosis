// Bundle the plugin into the single `main.js` Obsidian loads.
//
// The community-plugin channel ships exactly three files — main.js,
// manifest.json, styles.css — so the WebAssembly module is inlined into the
// bundle rather than fetched. esbuild's `binary` loader turns the `.wasm` into
// a Uint8Array the glue can instantiate directly, which also means the plugin
// never reaches the network and works offline, as a local-first tool should.
import esbuild from "esbuild";
import builtins from "builtin-modules";

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
    },
});

if (production) {
    await context.rebuild();
    await context.dispose();
} else {
    await context.watch();
}
