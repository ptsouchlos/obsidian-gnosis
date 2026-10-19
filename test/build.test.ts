//! Building the index from inside the vault, end to end except for the model.
//!
//! The model is a deterministic stand-in: the same text always gives the same
//! unit vector, so a test can tell exactly which chunks were embedded. The
//! builder, the artifact format and the writer are real, and each test runs on
//! its own copy of the fixture vault on disk.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { App, notices } from "./stubs/obsidian.js";
import GnosisPlugin from "../src/main.js";
import { MemoryCheckpoints } from "../src/build/checkpoints.js";
import { replaceWarning, statusLine } from "../src/build/plan.js";
import type { TextEmbedder } from "../src/embedder.js";
import type { IndexInfo } from "../src/types.js";
import { openArtifact } from "../src/artifact.js";
import { stalenessLine } from "../src/staleness.js";

declare const GNOSIS_TEST_VAULT: string;

const ARTIFACT = ".gnosis/artifact";
const BGE_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

/** A unit vector from the text's hash: deterministic, and distinct per text. */
function hashVector(text: string, dim: number): Float32Array {
    const out = new Float32Array(dim);
    let bytes = createHash("sha256").update(text).digest();
    for (let i = 0; i < dim; i++) {
        if (i % 32 === 0 && i > 0) {
            bytes = createHash("sha256").update(bytes).digest();
        }
        out[i] = bytes[i % 32]! - 127.5;
    }
    const norm = Math.hypot(...out);
    return out.map((x) => x / norm);
}

class HashEmbedder implements TextEmbedder {
    readonly seen: string[] = [];
    /** Called after each batch, so a test can act mid-build. */
    afterBatch: (calls: number) => void | Promise<void> = () => {};
    private calls = 0;

    constructor(private readonly dim: number) {}

    async embed(texts: string[]): Promise<Float32Array[]> {
        this.seen.push(...texts);
        const out = texts.map((t) => hashVector(t, this.dim));
        await this.afterBatch(++this.calls);
        return out;
    }

    dispose(): void {}
}

/** A copy of the fixture vault, with or without its CLI-built artifact. */
function vaultCopy(options: { artifact: boolean; extraNotes?: number }): string {
    const root = join(mkdtempSync(join(tmpdir(), "gnosis-build-")), "vault");
    cpSync(GNOSIS_TEST_VAULT, root, { recursive: true });
    if (!options.artifact) {
        rmSync(join(root, ".gnosis"), { recursive: true, force: true });
    }
    for (let i = 0; i < (options.extraNotes ?? 0); i++) {
        writeFileSync(
            join(root, "notes", `extra-${String(i).padStart(2, "0")}.md`),
            `# Extra ${i}\n\nA note about topic ${i}, with a body long enough to be its own chunk.\n`,
        );
    }
    return root;
}

interface Harness {
    plugin: GnosisPlugin;
    app: App;
    embedder: HashEmbedder;
    checkpoints: MemoryCheckpoints;
    consents: number;
    replaces: string[][];
}

async function load(root: string, options: { dim?: number; replace?: boolean } = {}): Promise<Harness> {
    notices.length = 0;
    const app = new App(root);
    const plugin = new GnosisPlugin(app as never, { id: "gnosis", version: "0.0.0-test" } as never);
    await plugin.onload();
    const embedder = new HashEmbedder(options.dim ?? 384);
    const checkpoints = new MemoryCheckpoints();
    const harness: Harness = { plugin, app, embedder, checkpoints, consents: 0, replaces: [] };
    plugin.embedderFactory = async () => embedder;
    plugin.checkpoints = checkpoints;
    plugin.askConsent = async () => {
        harness.consents++;
        return true;
    };
    plugin.confirmReplace = async (lines) => {
        harness.replaces.push(lines);
        return options.replace ?? true;
    };
    return harness;
}

async function info(root: string): Promise<IndexInfo> {
    const index = await openArtifact(new App(root) as never, ARTIFACT);
    try {
        return index.info() as IndexInfo;
    } finally {
        index.free();
    }
}

const shardBytes = (root: string) => readFileSync(join(root, ARTIFACT, "shard-0000.bin"));

test("a vault with no index gets one, built here with the default model", async () => {
    const root = vaultCopy({ artifact: false });
    const harness = await load(root);
    const { plugin, embedder, checkpoints, replaces } = harness;
    await plugin.buildIndex();

    const built = await info(root);
    assert.equal(built.documents, 2, "the vault's two notes, and nothing else");
    assert.deepEqual(built.roots, ["vault"], "labeled by the vault's name, as the CLI labels a vault");
    const text = built.spaces[0]!;
    assert.equal(text.model, "bge-small-en-v1.5");
    assert.equal(text.pooling, "cls");
    assert.equal(text.dim, 384);
    assert.equal(text.queryPrefix, BGE_INSTRUCTION, "the prefix a later query must use is recorded");
    assert.equal(built.quantization, "i8", "the CLI's default");

    assert.ok(embedder.seen.length >= 2);
    assert.equal(harness.consents, 1, "the model download is asked about");
    assert.equal(replaces.length, 0, "there was nothing to replace");
    assert.equal(checkpoints.saved.size, 0, "a finished build leaves no checkpoint");
    assert.equal(plugin.settings.semanticSearch, true, "search uses the model it was built with");
    assert.ok(notices.some((n) => n.includes("indexed 2 notes")), JSON.stringify(notices));
});

test("the diagnostics report records the build, and holds no note contents or paths", async () => {
    const root = vaultCopy({ artifact: false });
    const { plugin, app } = await load(root);
    await plugin.buildIndex();
    // An error that names a note, as a wasm error can.
    plugin.diagnostics.record("error", "document 'notes/sourdough.md' not found");

    await plugin.generateReport();
    const report = readFileSync(join(root, "gnosis-report.md"), "utf8");
    assert.deepEqual(app.workspace.opened, ["gnosis-report.md"], "the report is opened");

    assert.match(report, /Gnosis 0\.0\.0-test/);
    assert.match(report, /Obsidian 0\.0\.0-test/);
    assert.match(report, /Platform: desktop, Linux/);
    assert.match(report, /- State: Ready/);
    assert.match(report, /indexed after \d+\.\d s/, "the last build and its duration");
    assert.match(report, /- 2 notes, \d+ chunks: \d+ embedded, 0 notes unchanged/);
    assert.match(report, /\| strategy \| "balanced" \|/, "settings are listed");
    assert.match(report, /model · loaded bge-small-en-v1\.5\/cls in \d+ ms/, "the model load is timed");

    assert.match(report, /document 'note-1' not found/, "a path in an error is a token");
    assert.ok(!report.includes("sourdough.md") && !report.includes("hydration.md"), report);
    assert.ok(!report.includes("wild yeast starter"), "never a note's contents");

    // The report is a markdown file in the vault, but not one of the notes.
    await plugin.buildIndex();
    assert.equal((await info(root)).documents, 2, "the report is not indexed");
});

test("rebuilding an unchanged vault embeds nothing and writes nothing", async () => {
    const root = vaultCopy({ artifact: false });
    const first = await load(root);
    await first.plugin.buildIndex();
    const bytes = shardBytes(root);

    const second = await load(root);
    second.app.local.set(...([...first.app.local][0]!));
    await second.plugin.buildIndex();
    assert.deepEqual(second.embedder.seen, [], "every note is reused");
    assert.deepEqual(second.app.vault.adapter.writes, [], "not even the manifest is rewritten");
    assert.ok(shardBytes(root).equals(bytes));
    assert.ok(notices.some((n) => n.includes("already up to date")), JSON.stringify(notices));
});

test("editing one note re-embeds only that note", async () => {
    const root = vaultCopy({ artifact: false });
    const first = await load(root);
    await first.plugin.buildIndex();

    writeFileSync(join(root, "notes/hydration.md"), "# Hydration\n\nRewritten: water by mass.\n");
    const second = await load(root);
    second.app.local.set(...([...first.app.local][0]!));
    await second.plugin.buildIndex();

    assert.ok(second.embedder.seen.length > 0);
    assert.ok(
        second.embedder.seen.every((t) => t.includes("Rewritten")),
        `only the edited note's chunks: ${JSON.stringify(second.embedder.seen)}`,
    );
    assert.equal((await info(root)).documents, 2);
});

test("a deleted note leaves the index", async () => {
    const root = vaultCopy({ artifact: false });
    const first = await load(root);
    await first.plugin.buildIndex();

    rmSync(join(root, "notes/sourdough.md"));
    const second = await load(root);
    second.app.local.set(...([...first.app.local][0]!));
    await second.plugin.buildIndex();
    assert.equal((await info(root)).documents, 1);
    assert.deepEqual(second.embedder.seen, [], "removing a note embeds nothing");
});

test("an index another device or the CLI wrote is replaced only if the reader agrees", async () => {
    const root = vaultCopy({ artifact: true });
    const before = shardBytes(root);

    // Declined: nothing is downloaded, embedded or written.
    const declined = await load(root, { dim: 4, replace: false });
    await declined.plugin.buildIndex();
    assert.equal(declined.replaces.length, 1);
    assert.equal(declined.consents, 0, "declining comes before any download");
    assert.deepEqual(declined.embedder.seen, []);
    assert.deepEqual(declined.app.vault.adapter.writes, []);
    assert.ok(shardBytes(root).equals(before));

    // The warning says what the CLI's index has that a rebuild here drops.
    const warning = declined.replaces[0]!.join(" ");
    assert.match(warning, /images/, warning);
    assert.match(warning, /'notes', 'work'/, warning);

    // Agreed: rebuilt with the existing index's own model and settings.
    const agreed = await load(root, { dim: 4, replace: true });
    await agreed.plugin.buildIndex();
    const rebuilt = await info(root);
    assert.equal(rebuilt.documents, 2, "the deleted planner note and the image are gone");
    assert.equal(rebuilt.spaces.length, 1, "text only: the plugin does not index images");
    assert.equal(rebuilt.spaces[0]!.dim, 4, "the index's dimension, not the table's");
    assert.equal(rebuilt.quantization, "f32", "the index's quantization, not the default");

    // Now this device wrote it, so the next build does not ask.
    const again = await load(root, { dim: 4 });
    again.app.local.set(...([...agreed.app.local][0]!));
    await again.plugin.buildIndex();
    assert.equal(again.replaces.length, 0);
});

test("canceling keeps the live index and resumes where it stopped", async () => {
    const root = vaultCopy({ artifact: false, extraNotes: 40 });

    // The reference: how much a whole build embeds.
    const reference = vaultCopy({ artifact: false, extraNotes: 40 });
    const full = await load(reference);
    await full.plugin.buildIndex();
    const total = full.embedder.seen.length;

    const first = await load(root);
    first.embedder.afterBatch = (calls) => {
        if (calls === 1) {
            (first.plugin as never as { building: AbortController }).building.abort();
        }
    };
    await first.plugin.buildIndex();
    assert.ok(!existsSync(join(root, ARTIFACT)), "a canceled build writes no index");
    assert.equal(first.checkpoints.saved.size, 1, "but keeps its progress");
    const embeddedBefore = first.embedder.seen.length;
    assert.ok(embeddedBefore > 0 && embeddedBefore < total, `${embeddedBefore} of ${total}`);

    const second = await load(root);
    for (const [k, v] of first.checkpoints.saved) second.checkpoints.saved.set(k, v);
    await second.plugin.buildIndex();
    assert.ok(notices.some((n) => n.includes("resuming")), JSON.stringify(notices));
    assert.equal(
        embeddedBefore + second.embedder.seen.length,
        total,
        "nothing embedded before the cancel is embedded again",
    );
    assert.equal((await info(root)).documents, 42);
    assert.equal(second.checkpoints.saved.size, 0);
});

test("a long build checkpoints as it goes, and the result is the same", async () => {
    const root = vaultCopy({ artifact: false, extraNotes: 40 });
    const harness = await load(root);
    harness.plugin.checkpointEveryMs = 0;
    let saves = 0;
    const save = harness.checkpoints.save.bind(harness.checkpoints);
    harness.checkpoints.save = async (vault, checkpoint) => {
        saves++;
        await save(vault, checkpoint);
    };
    await harness.plugin.buildIndex();
    assert.ok(saves >= 2, `expected several checkpoints, got ${saves}`);
    assert.equal((await info(root)).documents, 42);
    assert.equal(harness.checkpoints.saved.size, 0, "cleared once the build is written");
    assert.equal(new Set(harness.embedder.seen).size, harness.embedder.seen.length, "no chunk embedded twice");
});

test("an index the CLI rewrites during a build is not overwritten without asking", async () => {
    const root = vaultCopy({ artifact: false, extraNotes: 20 });
    const first = await load(root);
    await first.plugin.buildIndex();
    const manifest = join(root, ARTIFACT, "manifest.json");

    writeFileSync(join(root, "notes/hydration.md"), "# Hydration\n\nEdited.\n");
    const second = await load(root, { replace: false });
    second.app.local.set(...([...first.app.local][0]!));
    second.embedder.afterBatch = () => {
        // Another writer: the same index, re-exported with a new timestamp.
        const json = JSON.parse(readFileSync(manifest, "utf8"));
        json.created_unix += 1;
        writeFileSync(manifest, JSON.stringify(json));
    };
    const changedBefore = readFileSync(manifest, "utf8");
    await second.plugin.buildIndex();
    assert.equal(second.replaces.length, 1, "asked once, at the point of writing");
    assert.notEqual(readFileSync(manifest, "utf8"), changedBefore, "the other writer's manifest stands");
    assert.ok(!second.app.vault.adapter.writes.includes(`${ARTIFACT}/manifest.json`));
});

test("building is refused on mobile", async () => {
    const root = vaultCopy({ artifact: false });
    const { plugin, embedder } = await load(root);
    plugin.isMobile = () => true;
    await plugin.buildIndex();
    assert.ok(notices.some((n) => n.includes("desktop-only")));
    assert.deepEqual(embedder.seen, []);
});

test("an index built with a model the plugin cannot run is left to the CLI", async () => {
    const root = vaultCopy({ artifact: true });
    const manifest = join(root, ARTIFACT, "manifest.json");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace("bge-small-en-v1.5", "all-MiniLM-L6-v2"));
    const { plugin, replaces, app } = await load(root, { dim: 4 });
    await plugin.buildIndex();
    assert.ok(notices.some((n) => n.includes("'all-MiniLM-L6-v2'")), JSON.stringify(notices));
    assert.equal(replaces.length, 0);
    assert.deepEqual(app.vault.adapter.writes, []);
});

test("the status line estimates time left once it has history", () => {
    const base = { notesDone: 100, notesTotal: 1000, notesReused: 0, chunksEmbedded: 200 };
    assert.equal(
        statusLine({ ...base, elapsedMs: 5_000 }),
        "Gnosis: indexing 100/1,000 notes · 200 chunks embedded",
        "no estimate in the first seconds",
    );
    // 2 chunks a note at 200 chunks a minute: 900 notes is 9 minutes.
    assert.match(statusLine({ ...base, elapsedMs: 60_000 }), /~9 min left$/);
});

test("the replace warning is silent about what a rebuild keeps", () => {
    const manifest = JSON.stringify({
        created_unix: 0,
        quantization: "i8",
        compression: "deflate",
        roots: ["vault"],
        spaces: [{ space: "text", model: { id: "bge-small-en-v1.5", pooling: "cls", dim: 384, query_prefix: "", document_prefix: "" } }],
        shards: [{ documents: 3 }],
    });
    const lines = replaceWarning(manifest, "vault");
    assert.equal(lines.length, 2, `no image or folder warning for a plain one-vault index: ${lines}`);
});

// The settings tab's index card. Its states are decided by `indexStatus`,
// so these drive the real plugin through each one rather than the drawing.

test("the index card says when there is no index, and offers to build one", async () => {
    const { plugin } = await load(vaultCopy({ artifact: false }));
    const status = await plugin.indexStatus();
    assert.equal(status.state, "none");
    assert.equal(status.action, "build");
    assert.equal(status.notes, null);
    assert.match(status.detail, /\.gnosis\/artifact/);
});

test("the index card reads an index someone else wrote from its manifest alone", async () => {
    const { plugin } = await load(vaultCopy({ artifact: true }));
    const status = await plugin.indexStatus();
    assert.equal(status.state, "ready");
    assert.equal(status.action, "update");
    assert.equal(status.notes, 4);
    assert.equal(status.chunks, 6);
    assert.equal(status.builtAt, 1_700_000_400_000);
    assert.equal(status.model, "bge-small-en-v1.5 · 4d");
    assert.equal(status.writtenBy, "another device or the gnosis CLI");
});

test("the index card follows a build: indexing, then ready and written here", async () => {
    const root = vaultCopy({ artifact: false, extraNotes: 40 });
    const { plugin, embedder } = await load(root);
    let changes = 0;
    plugin.onStatusChange(() => changes++);
    // `afterBatch` runs before its batch's progress is reported, so the look
    // after the first batch sees the build but no numbers yet.
    const seen: Awaited<ReturnType<typeof plugin.indexStatus>>[] = [];
    embedder.afterBatch = async (calls) => {
        if (calls <= 2) {
            seen.push(await plugin.indexStatus());
        }
    };
    await plugin.buildIndex();

    const [during, later] = seen;
    assert.equal(during!.state, "building");
    assert.equal(during!.action, "cancel");
    assert.equal(later!.state, "building");
    assert.match(later!.detail, /^Indexing \d+\/42 notes · \d+ chunks embedded/);
    assert.ok(changes >= 3, `start, progress and end each notify: ${changes}`);

    const after = await plugin.indexStatus();
    assert.equal(after.state, "ready");
    assert.equal(after.notes, 42);
    assert.equal(after.writtenBy, "this device");
});

test("the index card offers to resume a canceled build", async () => {
    const root = vaultCopy({ artifact: false, extraNotes: 40 });
    const { plugin, embedder } = await load(root);
    embedder.afterBatch = (calls) => {
        if (calls === 1) {
            plugin.cancelBuild();
        }
    };
    await plugin.buildIndex();

    const status = await plugin.indexStatus();
    assert.equal(status.state, "paused");
    assert.equal(status.action, "resume");
    assert.match(status.detail, /^\d+ of 42 notes indexed/);
    assert.match(status.detail, /needs a finished index/, "there is no previous index to fall back on");
});

test("the index card names a manifest it cannot read", async () => {
    const root = vaultCopy({ artifact: true });
    writeFileSync(join(root, ARTIFACT, "manifest.json"), "{ not json");
    const { plugin } = await load(root);
    const status = await plugin.indexStatus();
    assert.equal(status.state, "unreadable");
    assert.match(status.detail, /manifest\.json is not valid JSON/);
    assert.equal(status.action, "build");
});

// Step 6: what a build leaves out, and where the index lives.

test("notes in Obsidian's excluded files are left out of a build, unless the reader says not to", async () => {
    const root = vaultCopy({ artifact: false });
    const { plugin, app } = await load(root);
    app.excluded.push("notes/sourdough");
    await plugin.buildIndex();
    assert.equal((await info(root)).documents, 1, "only hydration.md");

    const again = await load(root);
    again.app.excluded.push("notes/sourdough");
    again.app.local.set(...([...app.local][0]!));
    again.plugin.settings.honorExcluded = false;
    await again.plugin.buildIndex();
    assert.equal((await info(root)).documents, 2);
});

test("moving the index copies it, checks it opens, and only then removes the old one", async () => {
    const root = vaultCopy({ artifact: true });
    const before = shardBytes(root);
    const { plugin } = await load(root);
    assert.equal(await plugin.moveIndex("Gnosis Index"), true);

    assert.equal(plugin.settings.artifactDir, "Gnosis Index");
    assert.ok(!existsSync(join(root, ARTIFACT)), "the old folder is gone");
    assert.ok(existsSync(join(root, ".gnosis")), "but not its parent, where the CLI keeps its database");
    assert.ok(readFileSync(join(root, "Gnosis Index/shard-0000.bin")).equals(before), "byte for byte");
    const status = await plugin.indexStatus();
    assert.equal(status.state, "ready");
    assert.equal(status.notes, 4);
});

test("moving onto a folder that already holds an index is refused, and touches neither", async () => {
    const root = vaultCopy({ artifact: true });
    cpSync(join(root, ARTIFACT), join(root, "Gnosis Index"), { recursive: true });
    const { plugin, app } = await load(root);
    assert.equal(await plugin.moveIndex("Gnosis Index"), false);
    assert.equal(plugin.settings.artifactDir, ARTIFACT);
    assert.deepEqual(app.vault.adapter.writes, [], "nothing written or removed");
    assert.ok(notices.some((n) => n.includes("already an index in Gnosis Index")), JSON.stringify(notices));
});

test("with no index yet, moving only changes where the next build writes", async () => {
    const root = vaultCopy({ artifact: false });
    const { plugin, app } = await load(root);
    assert.equal(await plugin.moveIndex("Gnosis Index"), true);
    assert.deepEqual(app.vault.adapter.writes, []);
    await plugin.buildIndex();
    assert.ok(existsSync(join(root, "Gnosis Index/manifest.json")));
});

test("a move whose copy does not open leaves the original and no half-copy", async () => {
    const root = vaultCopy({ artifact: true });
    // A shard that no longer matches its manifest: the copy fails to verify.
    const shard = join(root, ARTIFACT, "shard-0000.bin");
    const corrupt = Buffer.from(readFileSync(shard));
    corrupt[corrupt.length - 1]! ^= 0xff;
    writeFileSync(shard, corrupt);

    const { plugin } = await load(root);
    assert.equal(await plugin.moveIndex("Gnosis Index"), false);
    assert.equal(plugin.settings.artifactDir, ARTIFACT);
    assert.ok(readFileSync(shard).equals(corrupt), "the original is exactly as it was");
    assert.ok(!existsSync(join(root, "Gnosis Index")), "and the copy is gone");
});

// ---- Staleness ----------------------------------------------------------------

/** Move a file's mtime a day forward, as a syncer or a careless plugin can. */
function touch(root: string, path: string): void {
    const later = new Date(Date.now() + 86_400_000);
    utimesSync(join(root, path), later, later);
}

test("staleness counts edited, new and deleted notes, and not touched ones", async () => {
    const root = vaultCopy({ artifact: false });
    const { plugin, app } = await load(root);
    await plugin.buildIndex();

    const fresh = (await plugin.vaultStaleness())!;
    assert.deepEqual([fresh.changed, fresh.added, fresh.removed], [[], [], []]);
    assert.equal(fresh.hashed, 0, "nothing newer than the build is read at all");
    assert.equal(stalenessLine(fresh), "Up to date with your notes.");

    // Touched but not edited: its mtime says changed, its content does not.
    touch(root, "notes/sourdough.md");
    const touched = (await plugin.vaultStaleness())!;
    assert.deepEqual(touched.changed, [], "a touched note is not a changed one");
    assert.equal(touched.hashed, 1, "only the touched note was read");

    writeFileSync(join(root, "notes/hydration.md"), "# Hydration\n\nRewritten: water by mass.\n");
    touch(root, "notes/hydration.md");
    writeFileSync(join(root, "notes/rye.md"), "# Rye\n\nA denser crumb.\n");
    rmSync(join(root, "notes/sourdough.md"));
    const stale = (await plugin.vaultStaleness())!;
    assert.deepEqual(stale.changed, ["notes/hydration.md"]);
    assert.deepEqual(stale.added, ["notes/rye.md"]);
    assert.deepEqual(stale.removed, ["notes/sourdough.md"]);
    assert.equal(stalenessLine(stale), "1 note changed, 1 new, 1 deleted since the last update.");

    // What a build leaves out is not "new": an excluded note, and the report.
    app.excluded.push("notes/rye.md");
    await plugin.generateReport();
    const excluded = (await plugin.vaultStaleness())!;
    assert.deepEqual(excluded.added, [], JSON.stringify(excluded));
    assert.match(
        readFileSync(join(root, "gnosis-report.md"), "utf8"),
        /- State: Ready — 1 note changed, 1 deleted since the last update\./,
        "the report carries the counts, the excluded note not among them",
    );

    // And an update brings it back to zero.
    app.excluded.length = 0;
    await plugin.buildIndex();
    const updated = (await plugin.vaultStaleness())!;
    assert.deepEqual([updated.changed, updated.added, updated.removed], [[], [], []], JSON.stringify(updated));
});

// The fixture's artifact carries placeholder hashes, so it cannot say whether
// the plugin's hash is the CLI's; `parity.test.ts` checks that against a real
// export. What it can say is what counts as deleted.
test("against a CLI index, only a missing note is deleted, never an image", async () => {
    const root = vaultCopy({ artifact: true });
    const { plugin } = await load(root, { dim: 4 });
    const stale = (await plugin.vaultStaleness())!;
    assert.deepEqual(
        stale.removed,
        ["work/planner.md"],
        "the note the fixture deliberately lacks, and not notes/loaf.png",
    );
});

test("the staleness line names only what there is", () => {
    const s = (changed: number, added: number, removed: number) => ({
        changed: Array(changed).fill("x"),
        added: Array(added).fill("x"),
        removed: Array(removed).fill("x"),
        hashed: 0,
        elapsedMs: 0,
    });
    assert.equal(stalenessLine(s(12, 0, 0)), "12 notes changed since the last update.");
    assert.equal(stalenessLine(s(0, 3, 0)), "3 new notes since the last update.");
    assert.equal(stalenessLine(s(0, 0, 1)), "1 note deleted since the last update.");
    assert.equal(stalenessLine(s(0, 3, 2)), "3 new notes, 2 deleted since the last update.");
});
