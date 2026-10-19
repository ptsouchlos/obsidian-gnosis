//! Semantic search, end to end except for the model.
//!
//! The model is replaced by a stand-in that records what it was asked to embed
//! and answers with a chosen vector. Everything else is real: the artifact, the
//! WebAssembly module's hybrid ranking, and the plugin's own decisions — what
//! it asks before downloading, which prefix it prepends, when it falls back to
//! keywords and what it says when it cannot do better.
//!
//! What the stand-in cannot show — that transformers.js reproduces the vectors
//! gnosis stored — is `test/parity.test.ts`'s job, against real models.

import assert from "node:assert/strict";
import test from "node:test";

import { App, notices, openedModals } from "./stubs/obsidian.js";
import GnosisPlugin from "../src/main.js";
import { consentLines, type Download } from "../src/consent.js";
import { RUNTIMES, queryVectors, unsupportedReason, type EmbedderFactory, type TextEmbedder } from "../src/embedder.js";
import { MemoryModelStore } from "../src/model-store.js";
import type { QueryModel } from "../src/models.js";
import { modelStatus } from "../src/status.js";
import type { Hit, SpaceInfo } from "../src/types.js";

declare const GNOSIS_TEST_VAULT: string;

/** What the fixture's text space records: bge-small, with its instruction. */
const BGE_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

/** A stand-in model: records its inputs, answers with `vector` for each. */
class StandIn implements TextEmbedder {
    readonly seen: string[] = [];
    disposed = false;

    constructor(private readonly vector: number[]) {}

    async embed(texts: string[]): Promise<Float32Array[]> {
        this.seen.push(...texts);
        return texts.map(() => Float32Array.from(this.vector));
    }

    dispose(): void {
        this.disposed = true;
    }
}

interface Harness {
    plugin: GnosisPlugin;
    consented: Download[][];
    started: { model: QueryModel; pooling: string; device: string }[];
}

/**
 * A plugin over the fixture vault whose model loads instantly as `embedder`,
 * and whose reader answers the consent prompt with `agree`. `gpu`: whether
 * WebGPU offers an adapter; `gpuHeld`: whether its runtime is already here.
 */
async function load(options: {
    embedder?: TextEmbedder;
    agree?: boolean;
    factory?: EmbedderFactory;
    gpu?: boolean;
    gpuHeld?: boolean;
}): Promise<Harness> {
    notices.length = 0;
    openedModals.length = 0;
    const app = new App(GNOSIS_TEST_VAULT);
    const plugin = new GnosisPlugin(app as never, { id: "gnosis", version: "0.0.0-test" } as never);
    await plugin.onload();
    const harness: Harness = { plugin, consented: [], started: [] };
    plugin.hasWebgpu = async () => options.gpu ?? false;
    const store = new MemoryModelStore();
    if (options.gpuHeld) {
        store.runtimes.set(RUNTIMES.webgpu.url, RUNTIMES.webgpu.bytes);
    }
    plugin.modelStore = store;
    plugin.askConsent = async (downloads) => {
        harness.consented.push(downloads);
        return options.agree ?? true;
    };
    plugin.embedderFactory =
        options.factory ??
        (async (model, pooling, onProgress, device) => {
            harness.started.push({ model, pooling, device });
            onProgress({ file: "onnx/model.onnx", loaded: 50_000_000, total: 127_000_000 });
            onProgress({ file: "onnxruntime-web.wasm", loaded: 13_600_000, total: 13_600_000 });
            return options.embedder ?? new StandIn([1, 0, 0, 0]);
        });
    return harness;
}

function search(plugin: GnosisPlugin): void {
    const commands = (plugin as never as { commands: Map<string, { callback: () => void }> }).commands;
    commands.get("search")!.callback();
}

async function waitFor(what: string, done: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!done()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}: ${JSON.stringify(notices)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/** Open the search picker once the model has loaded, and return it. */
async function semanticPicker(plugin: GnosisPlugin) {
    assert.equal(await plugin.enableSemanticSearch(), true);
    // The model loads in the background; the next picker uses it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    search(plugin);
    await waitFor("the search modal", () => openedModals.length > 0);
    return openedModals.at(-1)!;
}

test("turning semantic search on asks first, and says what it downloads", async () => {
    const { plugin, consented, started } = await load({ agree: true });
    assert.equal(await plugin.enableSemanticSearch(), true);

    assert.equal(consented.length, 1, "the reader is asked exactly once");
    const [model, runtime] = consented[0]!;
    assert.match(model!.what, /bge-small-en-v1\.5 \(Xenova\/bge-small-en-v1\.5, revision ea104da\)/);
    assert.equal(model!.from, "huggingface.co");
    assert.equal(runtime!.from, "cdn.jsdelivr.net");
    assert.ok(runtime!.bytes > 10_000_000, "the runtime's size is the real file's");

    assert.equal(plugin.settings.semanticSearch, true);
    assert.equal(started.length, 1);
    assert.equal(started[0]!.model.revision, "ea104dacec62c0de699686887e3f920caeb4f3e3");
    assert.equal(started[0]!.pooling, "cls", "pooling comes from the index, not a guess");
});

test("with no graphics card, the CPU engine is what is asked about and used", async () => {
    const { plugin, consented, started } = await load({ gpu: false });
    assert.equal(await plugin.enableSemanticSearch(), true);
    assert.equal(consented[0]![1]!.bytes, RUNTIMES.wasm.bytes);
    assert.match(consented[0]![1]!.what, /WebAssembly engine/);
    assert.equal(started[0]!.device, "wasm");
    assert.equal(plugin.runningOn(), "wasm");
});

test("with a graphics card, turning semantic search on names the WebGPU engine and uses it", async () => {
    const { plugin, consented, started } = await load({ gpu: true });
    assert.equal(await plugin.enableSemanticSearch(), true);
    const runtime = consented[0]![1]!;
    assert.equal(runtime.bytes, RUNTIMES.webgpu.bytes);
    assert.match(runtime.what, /WebGPU engine/);
    assert.ok(
        consentLines(consented[0]!).some((l) => l.includes("set Compute to CPU")),
        "the prompt says how to choose the CPU instead",
    );
    assert.equal(started[0]!.device, "webgpu");
});

test("Compute set to CPU uses the CPU even with a graphics card", async () => {
    const { plugin, consented, started } = await load({ gpu: true });
    plugin.settings.compute = "cpu";
    assert.equal(await plugin.enableSemanticSearch(), true);
    assert.equal(consented[0]![1]!.bytes, RUNTIMES.wasm.bytes);
    assert.equal(started[0]!.device, "wasm");
});

test("a search never downloads the WebGPU engine unasked, and uses it once it is here", async () => {
    const without = await load({ gpu: true });
    without.plugin.settings.semanticSearch = true;
    assert.equal(await without.plugin.chooseDevice(true), "wasm", "an unattended start keeps to the CPU");
    assert.equal(await without.plugin.chooseDevice(false), "webgpu", "a start that asks may name it");

    const held = await load({ gpu: true, gpuHeld: true });
    assert.equal(await held.plugin.chooseDevice(true), "webgpu");
});

test("declining the prompt downloads nothing and leaves search lexical", async () => {
    const { plugin, started } = await load({ agree: false });
    assert.equal(await plugin.enableSemanticSearch(), false);
    assert.equal(plugin.settings.semanticSearch, false);
    assert.equal(started.length, 0, "no model may start without consent");

    search(plugin);
    await waitFor("the search modal", () => openedModals.length > 0);
    const hits = openedModals.at(-1)!.type("baker's percentages") as Hit[];
    assert.ok(Array.isArray(hits), "the lexical picker answers synchronously");
    assert.equal(hits[0]?.path, "notes/hydration.md");
});

test("a query is embedded with the prefix the index recorded", async () => {
    const embedder = new StandIn([0, 0, 1, 0]);
    const { plugin } = await load({ embedder });
    const modal = await semanticPicker(plugin);

    await modal.type("how do databases pick a plan");
    assert.deepEqual(embedder.seen, [`${BGE_INSTRUCTION}how do databases pick a plan`]);
});

test("semantic search finds a note by meaning when no word matches", async () => {
    // "xyzzy" matches nothing lexically, so the ranking is the vector's alone:
    // it points at the planner note's chunk.
    const { plugin } = await load({ embedder: new StandIn([0, 0, 1, 0]) });
    const modal = await semanticPicker(plugin);

    const hits = (await modal.type("xyzzy")) as Hit[];
    assert.equal(hits[0]?.path, "work/planner.md", `got ${JSON.stringify(hits.map((h) => h.path))}`);
});

test("while the model is still loading, search answers with keywords", async () => {
    let release: (e: TextEmbedder) => void = () => {};
    const { plugin } = await load({
        factory: () => new Promise((resolve) => (release = resolve)),
    });
    assert.equal(await plugin.enableSemanticSearch(), true);
    search(plugin);
    await waitFor("the search modal", () => openedModals.length > 0);

    const hits = (await openedModals.at(-1)!.type("baker's percentages")) as Hit[];
    assert.equal(hits[0]?.path, "notes/hydration.md", "lexical results, not an empty picker");
    release(new StandIn([1, 0, 0, 0]));
});

test("a model that fails to load says so and can be retried", async () => {
    let attempts = 0;
    const { plugin } = await load({
        factory: async () => {
            attempts++;
            throw new Error("HTTP 503 from huggingface.co");
        },
    });
    assert.equal(await plugin.enableSemanticSearch(), true);
    await waitFor("the failure notice", () => notices.some((n) => n.includes("could not load the model")));
    assert.ok(notices.some((n) => n.includes("HTTP 503")), JSON.stringify(notices));

    // The failed load is forgotten, so the next search tries again.
    search(plugin);
    await waitFor("a second attempt", () => attempts === 2);
});

test("turning semantic search off shuts the model down", async () => {
    const embedder = new StandIn([1, 0, 0, 0]);
    const { plugin } = await load({ embedder });
    await semanticPicker(plugin);
    await plugin.disableSemanticSearch();
    assert.equal(embedder.disposed, true);
    assert.equal(plugin.settings.semanticSearch, false);
});

test("download progress is one notice, summed across files", async () => {
    const { plugin } = await load({});
    await plugin.enableSemanticSearch();
    await waitFor("a progress notice", () => notices.some((n) => n.includes("loading the model")));
    assert.ok(
        notices.some((n) => n.includes("64 MB of 141 MB")),
        `the model and the runtime are one download: ${JSON.stringify(notices)}`,
    );
});

test("a file that delivers more than it announced never reads as over 100%", async () => {
    // What a gzip-encoded response does: content-length is the compressed size.
    const { plugin } = await load({
        factory: async (_model, _pooling, onProgress) => {
            onProgress({ file: "tokenizer.json", loaded: 2_000_000, total: 700_000 });
            return new StandIn([1, 0, 0, 0]);
        },
    });
    await plugin.enableSemanticSearch();
    await waitFor("a progress notice", () => notices.some((n) => n.includes("loading the model")));
    assert.ok(notices.some((n) => n.includes("2.0 MB of 2.0 MB")), JSON.stringify(notices));
});

const space = (over: Partial<SpaceInfo>): SpaceInfo => ({
    space: "text",
    model: "bge-small-en-v1.5",
    queryModel: "bge-small-en-v1.5",
    pooling: "cls",
    queryPrefix: BGE_INSTRUCTION,
    documentPrefix: "",
    dim: 4,
    chunks: 3,
    ...over,
});

test("an index built with a model the plugin cannot fetch is told so", () => {
    assert.match(unsupportedReason(space({ queryModel: "nomic-embed-text-v1.5" }))!, /does not support 'nomic-embed-text-v1\.5'/);
    assert.match(unsupportedReason(space({ pooling: "eos" }))!, /pooling 'eos'/);
    assert.equal(unsupportedReason(space({})), null);
});

test("an index built without the instruction is queried without it", async () => {
    const embedder = new StandIn([1, 0, 0, 0]);
    await queryVectors(embedder, space({ queryPrefix: "" }), "sourdough");
    assert.deepEqual(embedder.seen, ["sourdough"]);
});

test("a vector of the wrong size is refused before it reaches the index", async () => {
    await assert.rejects(
        queryVectors(new StandIn([1, 0, 0]), space({}), "sourdough"),
        /3d vector for an index of 4d/,
    );
});

test("the consent prompt promises nothing leaves the device and states the total", () => {
    const lines = consentLines([
        { what: "model", from: "huggingface.co", bytes: 134_000_000 },
        { what: "runtime", from: "cdn.jsdelivr.net", bytes: 13_600_000 },
    ]);
    assert.match(lines[0]!, /148 MB in all/);
    assert.ok(lines.some((l) => l.includes("134 MB from huggingface.co")));
    assert.ok(lines.some((l) => l.includes("never leave this device")));
});

// The settings tab's model card: what this device holds, and deleting it.

test("the model card says what is downloaded, and what a first use costs", async () => {
    const { plugin } = await load({});
    const store = new MemoryModelStore();
    plugin.modelStore = store;

    const before = await plugin.modelStatus();
    assert.equal(before.state, "absent");
    assert.equal(before.model, "bge-small-en-v1.5 · 4d", "the index's own model, not the setting's");
    assert.match(before.detail, /on first use, after asking/);
    assert.equal(before.canDelete, false, "nothing to delete");

    store.held_.add("Xenova/bge-small-en-v1.5");
    assert.equal((await plugin.modelStatus()).state, "downloaded");

    assert.equal(await plugin.enableSemanticSearch(), true);
    const loaded = await plugin.modelStatus();
    assert.equal(loaded.state, "ready");
    assert.match(loaded.detail, /MB on this device · in use/);
    assert.equal(loaded.canDelete, true);
});

test("deleting the model asks, turns semantic search off, and frees only its files", async () => {
    const embedder = new StandIn([1, 0, 0, 0]);
    const { plugin } = await load({ embedder });
    const store = new MemoryModelStore();
    store.held_.add("Xenova/bge-small-en-v1.5");
    store.held_.add("someone-elses/model");
    store.runtimes.set(RUNTIMES.wasm.url, RUNTIMES.wasm.bytes);
    store.runtimes.set(RUNTIMES.webgpu.url, RUNTIMES.webgpu.bytes);
    plugin.modelStore = store;
    await plugin.enableSemanticSearch();

    let asked: string[] = [];
    plugin.confirmDelete = async (lines) => {
        asked = lines;
        return false;
    };
    await plugin.deleteModel();
    assert.ok(asked.some((l) => l.includes("index is not affected")), JSON.stringify(asked));
    assert.equal(plugin.settings.semanticSearch, true, "declining changes nothing");
    assert.equal(store.held_.has("Xenova/bge-small-en-v1.5"), true);

    plugin.confirmDelete = async () => true;
    await plugin.deleteModel();
    assert.equal(plugin.settings.semanticSearch, false, "or the next search would download it again");
    assert.equal(embedder.disposed, true);
    assert.deepEqual([...store.held_], ["someone-elses/model"], "another plugin's model is left alone");
    assert.equal(store.runtimes.size, 0, "both engines, CPU and WebGPU, are removed");
    assert.ok(notices.some((n) => n.includes("MB freed")), JSON.stringify(notices));
    assert.equal((await plugin.modelStatus()).state, "absent");
});

test("a model that fails to load shows why on the card", async () => {
    const { plugin } = await load({
        factory: async () => {
            throw new Error("HTTP 503 from huggingface.co");
        },
    });
    plugin.modelStore = new MemoryModelStore();
    await plugin.enableSemanticSearch().catch(() => false);
    await waitFor("the failure", () => notices.some((n) => n.includes("could not load")));
    const status = await plugin.modelStatus();
    assert.equal(status.state, "failed");
    assert.match(status.detail, /HTTP 503/);
});

test("an index built with a model the plugin cannot run says so on the card", () => {
    const status = modelStatus({
        modelId: "all-MiniLM-L6-v2",
        dim: 384,
        supported: false,
        heldBytes: null,
        complete: false,
        downloadBytes: 0,
        embedder: null,
        error: null,
        building: false,
    });
    assert.equal(status.state, "unsupported");
    assert.match(status.detail, /Keyword search and related notes still work/);
    assert.equal(status.canDelete, false);
});
