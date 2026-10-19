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
import { App, notices, openedModals } from "./stubs/obsidian.js";
import GnosisPlugin from "../src/main.js";
import { RelatedFollower } from "../src/related/follow.js";
import { formatScore } from "../src/results.js";
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

test("a ranking preset changes the next search, with no reload", async () => {
    const { plugin } = await load();
    run(plugin, "search");
    await aModal();
    const modal = openedModals.at(-1)!;
    // "hydration" is the title of one note: exactly what the title bonus lifts.
    const score = () => (modal.type("hydration") as Hit[]).find((h) => h.path === "notes/hydration.md")!.score;

    const withBonus = score();
    plugin.settings.titleBonus = "off";
    plugin.applySearchConfig();
    const without = score();
    assert.ok(without < withBonus, `${without} should be below ${withBonus}`);

    plugin.settings.titleBonus = "default";
    plugin.applySearchConfig();
    assert.equal(score(), withBonus, "and back");
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

test("Cmd/Ctrl opens a result where the reader chose; a plain choice opens in place", async () => {
    const { app, plugin } = await load();
    plugin.settings.modOpen = "split";
    run(plugin, "search");
    await aModal();
    const modal = openedModals.at(-1)!;
    const hit = (modal.type("baker's percentages") as Hit[])[0]!;

    modal.choose(hit);
    modal.choose(hit, { ctrlKey: true });
    // Obsidian's own Cmd/Ctrl+Alt+Shift still means a window.
    modal.choose(hit, { ctrlKey: true, altKey: true, shiftKey: true });
    assert.deepEqual(app.workspace.panes, [false, "split", "window"]);
    assert.ok(
        (modal as never as { keys: Map<string, unknown> }).keys.has("Mod+Enter"),
        "Cmd/Ctrl+Enter is bound, or only a click could use the setting",
    );
});

test("keyboard hints name where Cmd/Ctrl opens, and can be turned off", async () => {
    const { plugin } = await load();
    plugin.settings.modOpen = "window";
    run(plugin, "search");
    await aModal();
    const hints = (openedModals.at(-1) as never as { instructions: { purpose: string }[] }).instructions;
    assert.ok(hints.some((h) => h.purpose === "to open in a new window"), JSON.stringify(hints));

    const off = await load();
    off.plugin.settings.keyboardHints = false;
    run(off.plugin, "search");
    await aModal();
    assert.deepEqual((openedModals.at(-1) as never as { instructions: unknown[] }).instructions, []);
});

test("scores keep two significant figures, so keyword-only scores stay distinct", () => {
    assert.equal(formatScore(0.0318), "0.032");
    assert.equal(formatScore(0.0283), "0.028");
    assert.equal(formatScore(0.7554), "0.76");
});

test("scores are shown only when asked for", async () => {
    const { plugin } = await load();
    run(plugin, "search");
    await aModal();
    const hit = (openedModals.at(-1)!.type("baker's percentages") as Hit[])[0]!;
    const hidden = fakeEl();
    openedModals.at(-1)!.renderSuggestion(hit, hidden as never);
    assert.ok(!hidden.texts.includes(formatScore(hit.score)));

    const shown = await load();
    shown.plugin.settings.showScores = true;
    run(shown.plugin, "search");
    await aModal();
    const el = fakeEl();
    openedModals.at(-1)!.renderSuggestion(hit, el as never);
    assert.equal(el.texts[0], formatScore(hit.score), "the score comes first, as a badge");
});

test("a result renders its title, locator and snippet", async () => {
    const { plugin } = await load();
    run(plugin, "search");
    await aModal();

    const modal = openedModals.at(-1)!;
    const hits = modal.type("baker's percentages") as Hit[];
    const el = fakeEl();
    modal.renderSuggestion(hits[0]!, el as never);
    // The file's name, as Obsidian shows a note — not its H1, "Hydration".
    assert.deepEqual(el.texts.slice(0, 2), ["hydration", "Hydration"]);
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
    const { plugin } = await load();
    const state = await plugin.relatedState("notes/sourdough.md");
    assert.equal(state.kind, "ready");
    const paths = (state as { hits: Hit[] }).hits.map((h) => h.path);
    assert.ok(!paths.includes("notes/sourdough.md"), `got ${JSON.stringify(paths)}`);
    assert.ok(
        !paths.includes("notes/hydration.md"),
        `[[Hydration]] is already linked from the source: ${JSON.stringify(paths)}`,
    );
    assert.ok(paths.length > 0, "something unlinked should remain");

    plugin.settings.relatedIncludeLinked = true;
    const linked = (await plugin.relatedState("notes/sourdough.md")) as { hits: Hit[] };
    assert.ok(linked.hits.some((h) => h.path === "notes/hydration.md"), "unless asked to include them");
});

test("related notes come with gnosis's pair scores between them, for the map", async () => {
    const { plugin } = await load();
    plugin.settings.relatedIncludeLinked = true;
    const state = await plugin.relatedState("notes/sourdough.md");
    assert.equal(state.kind, "ready");
    const { hits, pairs } = state as { hits: Hit[]; pairs: (number | null)[][] | null };
    assert.ok(pairs !== null, "the fixture has a text space");
    assert.equal(pairs.length, hits.length);
    pairs.forEach((row, i) => {
        assert.equal(row.length, hits.length);
        assert.equal(row[i], null, "a note is never related to itself");
    });
    assert.ok(hits.length < 2 || pairs.flat().some((s) => typeof s === "number"), JSON.stringify(pairs));
});

test("related on a note the index has never seen says the index is older than the note", async () => {
    const { plugin } = await load();
    const state = await plugin.relatedState("notes/written-after-the-export.md");
    assert.deepEqual(state, { kind: "stale", path: "notes/written-after-the-export.md" });
    assert.deepEqual(notices, [], "said in the panel, never as a notice");
});

test("related with no index says so in place, with no notice", async () => {
    const { plugin } = await load({ artifactDir: "not/here" });
    assert.deepEqual(await plugin.relatedState("notes/sourdough.md"), { kind: "no-index", dir: "not/here" });
    assert.deepEqual(notices, []);
});

test("the panel follows the active note, stays put while pinned, and catches up after", async () => {
    const { plugin } = await load();
    const asked: string[] = [];
    const follower = new RelatedFollower(async (path) => {
        asked.push(path);
        return plugin.relatedState(path);
    });

    assert.deepEqual(await follower.follow(null), { kind: "no-note" });
    const first = await follower.follow("notes/sourdough.md");
    assert.equal(first?.kind, "ready");
    assert.equal(await follower.follow("notes/sourdough.md"), null, "the same note again changes nothing");

    follower.pinned = true;
    assert.equal(await follower.follow("notes/hydration.md"), null, "pinned: the panel stays on sourdough");
    assert.equal(follower.path, "notes/sourdough.md");

    follower.pinned = false;
    const second = await follower.follow("notes/hydration.md");
    assert.equal(second?.kind, "ready");
    assert.equal(follower.path, "notes/hydration.md");

    // Back to a note it has already answered: from the cache, not the index.
    await follower.follow("notes/sourdough.md");
    assert.deepEqual(asked, ["notes/sourdough.md", "notes/hydration.md"]);
    follower.invalidate();
    await follower.current();
    assert.deepEqual(asked.at(-1), "notes/sourdough.md", "after the index changes, asked again");
    assert.equal(asked.length, 3);
});

test("the related command opens the panel in the sidebar, once", async () => {
    const { app, plugin } = await load();
    run(plugin, "related");
    await waitFor("the panel", () => app.workspace.getLeavesOfType("gnosis-related").length === 1);
    run(plugin, "related");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(app.workspace.getLeavesOfType("gnosis-related").length, 1, "revealed, not opened twice");
});

test("the panel is a page-preview source, so hovering a result previews it", async () => {
    const { plugin } = await load();
    const sources = (plugin as never as { hoverSources: Map<string, { defaultMod: boolean }> }).hoverSources;
    assert.deepEqual(sources.get("gnosis-related"), { display: "Gnosis related notes", defaultMod: true });
});

test("the panel opens by itself the first time, and never again once closed", async () => {
    const { app, plugin } = await load();
    for (const ready of app.workspace.layoutReady) ready();
    await waitFor("the panel", () => app.workspace.getLeavesOfType("gnosis-related").length === 1);
    assert.equal(plugin.settings.relatedPanelShown, true);

    // The reader closes it; the next load leaves it closed.
    app.workspace.leaves.length = 0;
    const again = await load();
    again.plugin.settings.relatedPanelShown = true;
    for (const ready of again.app.workspace.layoutReady) ready();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(again.app.workspace.getLeavesOfType("gnosis-related").length, 0);
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
