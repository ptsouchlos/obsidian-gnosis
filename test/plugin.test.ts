//! The plugin, driven end to end against a real artifact.
//!
//! Obsidian's API is stubbed (`test/stubs/obsidian.ts`) but nothing else is:
//! this loads the actual WebAssembly module, reads an actual artifact written
//! by gnosis's own shard writer, and runs the plugin's own commands. What it
//! proves is the part only the plugin can get wrong — reading the artifact out
//! of the vault, wiring the commands, resolving a hit back to a file, and
//! saying something useful when any of that fails.

import assert from "node:assert/strict";
import test from "node:test";

// Imported by path rather than as `obsidian`: the plugin's own import is
// aliased to this same file at bundle time, so both sides share one module
// instance, and the test type-checks against the stub it actually drives.
import { App, TFile, notices, openedModals } from "./stubs/obsidian.js";
import GnosisPlugin from "../src/main.js";
import type { Hit } from "../src/types.js";

/** The fixture vault's absolute path, injected by `test/build.mjs`. */
declare const GNOSIS_TEST_VAULT: string;
const VAULT = GNOSIS_TEST_VAULT;

/** A fresh plugin over the fixture vault, loaded as Obsidian loads it. */
async function load(settings?: { artifactDir?: string }) {
    notices.length = 0;
    openedModals.length = 0;
    const app = new App(VAULT);
    const plugin = new GnosisPlugin(app as never, { id: "gnosis", version: "0.0.0-test" } as never);
    await plugin.onload();
    if (settings?.artifactDir !== undefined) {
        plugin.settings.artifactDir = settings.artifactDir;
    }
    return { app, plugin };
}

/** The element `renderSuggestion` writes into, recording what it was given. */
function fakeEl(): { texts: string[]; createEl: (tag: string, o?: { text?: string }) => unknown } {
    const texts: string[] = [];
    const el = {
        texts,
        createEl(_tag: string, o?: { text?: string }) {
            if (o?.text !== undefined) {
                texts.push(o.text);
            }
            return el;
        },
    };
    return el;
}

function run(plugin: GnosisPlugin, id: string): void {
    const command = (plugin as never as { commands: Map<string, { callback?: () => void; checkCallback?: (c: boolean) => boolean }> }).commands.get(id);
    assert.ok(command, `no command '${id}' was registered`);
    if (command.callback) {
        command.callback();
    } else {
        assert.equal(command.checkCallback!(false), true, `command '${id}' refused to run`);
    }
}

/**
 * Wait for something the plugin does asynchronously.
 *
 * Opening the index is lazy: a command returns immediately and the modal (or
 * the notice explaining why there is none) appears once the artifact has been
 * read. Polling for the outcome is what makes that testable without the
 * plugin having to hand out promises it has no other reason to expose.
 */
async function waitFor(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

const aModal = () => waitFor("a modal to open", () => openedModals.length > 0);
const aNotice = () => waitFor("a notice", () => notices.length > 0);

test("the plugin registers its commands", async () => {
    const { plugin } = await load();
    const ids = [...(plugin as never as { commands: Map<string, unknown> }).commands.keys()];
    assert.deepEqual(ids.sort(), ["build-index", "cancel-build", "index-info", "related", "search"]);
});

test("the index describes itself from the artifact in the vault", async () => {
    const { plugin } = await load();
    const lines = await plugin.describeIndex();
    assert.match(lines[0]!, /^4 documents, 6 chunks$/);
    assert.ok(
        lines.some((l) => l.startsWith("text: bge-small-en-v1.5 (cls, 4d)")),
        `expected the text space's query model and pooling, got ${JSON.stringify(lines)}`,
    );
    assert.ok(
        lines.some((l) => l.startsWith("image: clip-vit-b-32-text")),
        "a text query against the image space goes through CLIP's text tower",
    );
});

test("lexical search ranks the vault with no model at all", async () => {
    const { plugin } = await load();
    run(plugin, "search");
    await aModal();

    const modal = openedModals.at(-1)!;
    assert.deepEqual(modal.type(""), [], "an empty query ranks nothing");

    const hits = modal.type("baker's percentages") as Hit[];
    assert.equal(hits[0]?.path, "notes/hydration.md", `got ${JSON.stringify(hits.map((h) => h.path))}`);
    assert.ok(hits[0]!.score > 0);
});

test("choosing a result opens that note", async () => {
    const { app, plugin } = await load();
    run(plugin, "search");
    await aModal();

    const modal = openedModals.at(-1)!;
    const hits = modal.type("baker's percentages") as Hit[];
    modal.choose(hits[0]!);
    assert.deepEqual(app.workspace.opened, ["notes/hydration.md"]);
});

test("a result renders its title, locator and snippet", async () => {
    const { plugin } = await load();
    run(plugin, "search");
    await aModal();

    const modal = openedModals.at(-1)!;
    const hits = modal.type("baker's percentages") as Hit[];
    const el = fakeEl();
    modal.renderSuggestion(hits[0]!, el as never);
    assert.deepEqual(el.texts.slice(0, 2), ["Hydration", "Hydration"]);
    assert.match(el.texts[2]!, /Baker's percentages/);
});

test("choosing a result whose note is gone says so instead of doing nothing", async () => {
    const { app, plugin } = await load();
    run(plugin, "search");
    await aModal();

    // `work/planner.md` is in the artifact and not in the fixture vault — the
    // state any vault reaches when a note is deleted after an export.
    const modal = openedModals.at(-1)!;
    const hits = modal.type("cardinality") as Hit[];
    const gone = hits.find((h) => h.path === "work/planner.md");
    assert.ok(gone, `expected the deleted note among ${JSON.stringify(hits.map((h) => h.path))}`);

    modal.choose(gone);
    assert.deepEqual(app.workspace.opened, [], "nothing should open");
    assert.ok(
        notices.some((n) => n.includes("work/planner.md") && n.includes("Build index")),
        `expected a notice naming the file and the fix, got ${JSON.stringify(notices)}`,
    );
});

test("related notes exclude the note itself and the ones it already links to", async () => {
    const { app, plugin } = await load();
    app.workspace.activeFile = new TFile("notes/sourdough.md", "sourdough");
    run(plugin, "related");
    await aModal();

    const modal = openedModals.at(-1)!;
    const hits = modal.type("") as Hit[];
    const paths = hits.map((h) => h.path);
    assert.ok(!paths.includes("notes/sourdough.md"), `got ${JSON.stringify(paths)}`);
    assert.ok(
        !paths.includes("notes/hydration.md"),
        `[[Hydration]] is already linked from the source: ${JSON.stringify(paths)}`,
    );
    assert.ok(paths.length > 0, "something unlinked should remain");

    // Typing in the related picker filters what is already ranked.
    assert.deepEqual(
        (modal.type("planner") as Hit[]).map((h) => h.path),
        paths.filter((p) => p.includes("planner")),
    );
});

test("related on a note the index has never seen reports it", async () => {
    const { app, plugin } = await load();
    app.workspace.activeFile = new TFile(
        "notes/written-after-the-export.md",
        "written-after-the-export",
    );
    run(plugin, "related");
    await aNotice();

    assert.equal(openedModals.length, 0, "there is nothing to pick from");
    assert.ok(
        notices.some((n) => n.includes("is not indexed")),
        `expected a stale-index notice, got ${JSON.stringify(notices)}`,
    );
});

test("a vault with no artifact is told how to build one", async () => {
    const { plugin } = await load({ artifactDir: "not/here" });
    run(plugin, "search");
    await aNotice();

    assert.equal(openedModals.length, 0);
    assert.ok(
        notices.some((n) => n.includes("gnosis export --out not/here")),
        `expected the exact command to run, got ${JSON.stringify(notices)}`,
    );
});
