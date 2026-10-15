// The file the plugin actually ships, loaded the way Obsidian loads it.
//
// Everything else here tests the TypeScript sources. This tests `main.js`:
// bundled, minified, CommonJS, with the WebAssembly module inlined as bytes.
// That is where a whole class of problem lives that the sources cannot show —
// a bundler format mistake, an `import.meta` that does not exist in CJS, a
// `.wasm` that never made it into the bundle — and each one would appear to a
// reader as a plugin that fails to load.
//
// Plain CommonJS on purpose: the point is to require the artifact as-is, so
// nothing here may be bundled along with it.

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

// Compiled by `test/build.mjs` into the build directory beside this one.
const stub = require(join(__dirname, "..", ".test-build", "obsidian-stub.cjs"));
const MAIN = join(__dirname, "..", "main.js");
const VAULT = join(__dirname, "fixtures", "vault");

/** Load `main.js` with `obsidian` resolved to the stub, as the app resolves it. */
function requirePlugin() {
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
        return request === "obsidian" ? stub : load.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve(MAIN)];
        return require(MAIN);
    } finally {
        Module._load = load;
    }
}

async function waitFor(what, done, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}: ${JSON.stringify(stub.notices)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const options = existsSync(MAIN) ? {} : { skip: "run `npm run build` first" };

test("the built bundle loads and searches a vault", options, async () => {
    // Obsidian takes the default export of the CommonJS bundle, which is what
    // `export default class` compiles to — the same shape the official sample
    // plugin ships. Reading it the same way here is part of what is being
    // checked: a bundle that exported something else would load in this test
    // and not in the app.
    const exported = requirePlugin();
    const GnosisPlugin = exported.default ?? exported;
    assert.equal(typeof GnosisPlugin, "function", "main.js must export the plugin class");

    stub.notices.length = 0;
    stub.openedModals.length = 0;
    const app = new stub.App(VAULT);
    const plugin = new GnosisPlugin(app, { id: "gnosis", version: "0.0.0-test" });
    await plugin.onload();

    // The inlined `.wasm` instantiating at all is the thing being proven here.
    const lines = await plugin.describeIndex();
    assert.match(lines[0], /^4 documents, 6 chunks$/, `got ${JSON.stringify(lines)}`);

    plugin.commands.get("search").callback();
    await waitFor("the search modal", () => stub.openedModals.length > 0);
    const hits = stub.openedModals.at(-1).type("baker's percentages");
    assert.equal(hits[0].path, "notes/hydration.md");

    plugin.onunload();
});
