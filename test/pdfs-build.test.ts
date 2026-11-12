//! Building an index with PDFs, end to end except for the models.
//!
//! The extraction is real: `src/extract.ts` runs unchanged, starting the real
//! extract worker bundle from a blob URL. Node has no web `Worker`, so the
//! test installs a small shim over `worker_threads` that fetches the blob and
//! evaluates it in a thread that looks enough like a worker scope — the
//! client cannot tell the difference, and has no test-only seam. The towers
//! are stand-ins, as in `images-build.test.ts`: a vector derived from the text.
//! Each test runs on its own copy of the fixture vault.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Worker as ThreadWorker } from "node:worker_threads";

import { App, notices } from "./stubs/obsidian.js";
import GnosisPlugin from "../src/main.js";
import { MemoryCheckpoints } from "../src/build/checkpoints.js";
import { MemoryModelStore } from "../src/model-store.js";
import type { ImageEmbedder, ImageVectors, TextEmbedder } from "../src/embedder.js";
import { pdfDocumentCount, readArtifact } from "../src/artifact.js";

declare const GNOSIS_TEST_VAULT: string;

const ARTIFACT = ".gnosis/artifact";
const SAMPLE_TITLE = "Gnosis Sample Document";
/** `notes/sample.pdf`'s two pages, as the chunker embeds them. */
const SAMPLE_CHUNKS = [
    "Page 1\nChunking strategies for retrieval. This first page discusses heading aware windows.",
    "Page 2\nVector indexes and recall. The second page covers approximate nearest neighbours.",
];

// --- A web Worker over worker_threads -------------------------------------

/**
 * The thread's side: a `self` with `onmessage` and `postMessage`, then the
 * worker's source as its first message, evaluated as a classic script.
 */
const BRIDGE = `
const { parentPort } = require("node:worker_threads");
globalThis.self = globalThis;
globalThis.postMessage = (data) => parentPort.postMessage(data);
parentPort.on("message", (data) => { const h = self.onmessage; if (h) h({ data }); });
(async () => {
    const source = await new Promise((resolve) => parentPort.once("message", resolve));
    (0, eval)(source);
    parentPort.postMessage({ __ready: true });
})();
`;

/** The page's side: what `src/extract.ts` uses of `Worker`, and no more. */
class WorkerShim {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    private inner: ThreadWorker | null = null;
    private queued: unknown[] = [];
    private terminated = false;

    constructor(url: string | URL) {
        void fetch(url).then(async (response) => {
            if (this.terminated) {
                return;
            }
            const source = await response.text();
            const inner = new ThreadWorker(BRIDGE, { eval: true });
            this.inner = inner;
            inner.on("message", (data: unknown) => {
                if (typeof data === "object" && data !== null && "__ready" in data) {
                    for (const message of this.queued) {
                        inner.postMessage(message);
                    }
                    this.queued = [];
                } else {
                    this.onmessage?.({ data });
                }
            });
            inner.on("error", (err: Error) => this.onerror?.({ message: err.message }));
            inner.on("exit", () => this.onerror?.({ message: "the worker exited" }));
            inner.postMessage(source);
        });
    }

    postMessage(data: unknown): void {
        if (this.inner === null) {
            this.queued.push(data);
        } else {
            this.inner.postMessage(data);
        }
    }

    terminate(): void {
        this.terminated = true;
        void this.inner?.terminate();
    }
}

(globalThis as { Worker?: unknown }).Worker = WorkerShim;

// --- Fixtures --------------------------------------------------------------

/** A one-page PDF whose page is a 1×1 image: no text layer, no title. */
function scannedPdf(): Buffer {
    const parts: string[] = [];
    const offsets: number[] = [0];
    parts.push("%PDF-1.4\n");
    const obj = (n: number, body: string) => {
        offsets[n] = parts.join("").length;
        parts.push(`${n} 0 obj\n${body}\nendobj\n`);
    };
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    obj(
        3,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    );
    const stream = "q\n100 0 0 100 0 0 cm\n/Im0 Do\nQ\n";
    obj(4, `<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    const pixels = "ABC";
    obj(
        5,
        `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}endstream`,
    );
    const body = parts.join("");
    let xref = "xref\n0 6\n";
    for (let i = 0; i <= 5; i += 1) {
        const free = i === 0;
        xref += `${String(free ? 0 : offsets[i]).padStart(10, "0")} ${free ? "65535" : "00000"} ${free ? "f" : "n"} \n`;
    }
    const tail = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`;
    return Buffer.from(body + xref + tail, "utf8");
}

/** The fixture vault without its artifact, plus whatever files a test names. */
function vaultCopy(files: Record<string, string | Buffer> = {}): string {
    const root = join(mkdtempSync(join(tmpdir(), "gnosis-pdfs-")), "vault");
    cpSync(GNOSIS_TEST_VAULT, root, { recursive: true });
    rmSync(join(root, ".gnosis"), { recursive: true, force: true });
    for (const [path, content] of Object.entries(files)) {
        writeFileSync(join(root, path), content);
    }
    return root;
}

/** `count` copies of the sample PDF, each its own document: `notes/copy-NN.pdf`. */
function sampleCopies(root: string, count: number): void {
    for (let i = 0; i < count; i++) {
        copyFileSync(join(root, "notes/sample.pdf"), join(root, `notes/copy-${String(i).padStart(2, "0")}.pdf`));
    }
}

// --- The harness -----------------------------------------------------------

/** A unit vector from bytes: deterministic, distinct per input. */
function vectorOf(bytes: Uint8Array | string, dim: number): Float32Array {
    const out = new Float32Array(dim);
    let digest = createHash("sha256").update(bytes).digest();
    for (let i = 0; i < dim; i++) {
        if (i % 32 === 0 && i > 0) {
            digest = createHash("sha256").update(digest).digest();
        }
        out[i] = digest[i % 32]! - 127.5;
    }
    const norm = Math.hypot(...out);
    return out.map((x) => x / norm);
}

class TextTower implements TextEmbedder {
    readonly seen: string[] = [];
    calls = 0;
    /** Called after each embed call with the number of calls so far. */
    afterCall: (calls: number) => void = () => {};
    constructor(readonly dim: number) {}
    async embed(texts: string[]): Promise<Float32Array[]> {
        this.seen.push(...texts);
        this.calls++;
        this.afterCall(this.calls);
        return texts.map((t) => vectorOf(t, this.dim));
    }
    dispose(): void {}
}

class VisionTower implements ImageEmbedder {
    async embedImages(images: Uint8Array[]): Promise<ImageVectors> {
        return { vectors: images.map((bytes) => vectorOf(bytes, 512)), failed: new Map() };
    }
    dispose(): void {}
}

interface Harness {
    plugin: GnosisPlugin;
    text: TextTower;
    clipText: TextTower;
    checkpoints: MemoryCheckpoints;
}

async function load(root: string, options: { indexPdfs?: boolean; searchImages?: boolean } = {}): Promise<Harness> {
    notices.length = 0;
    const app = new App(root);
    const plugin = new GnosisPlugin(app as never, { id: "gnosis", version: "0.0.0-test" } as never);
    await plugin.onload();
    plugin.settings.searchImages = options.searchImages ?? true;
    plugin.settings.indexPdfs = options.indexPdfs ?? true;
    const checkpoints = new MemoryCheckpoints();
    const harness: Harness = { plugin, text: new TextTower(384), clipText: new TextTower(512), checkpoints };
    plugin.hasWebgpu = async () => false;
    const store = new MemoryModelStore();
    store.held_.add("Qdrant/clip-ViT-B-32-vision");
    plugin.modelStore = store;
    plugin.embedderFactory = async (model) => (model.space === "image" ? harness.clipText : harness.text);
    plugin.visionFactory = async () => new VisionTower();
    plugin.checkpoints = checkpoints;
    plugin.askConsent = async () => true;
    plugin.confirmReplace = async () => true;
    plugin.confirmRebuild = async () => true;
    return harness;
}

async function pdfsIndexed(root: string): Promise<number> {
    return pdfDocumentCount(await readArtifact(new App(root) as never, ARTIFACT));
}

function skips(plugin: GnosisPlugin): string[] {
    return plugin.diagnostics
        .recent()
        .filter((e) => e.kind === "error" && e.message.startsWith("skipped "))
        .map((e) => e.message);
}

// --- The tests -------------------------------------------------------------

test("with PDFs on, a build extracts a PDF's pages and indexes it under its own title", async () => {
    const root = vaultCopy();
    const { plugin, text, clipText } = await load(root);
    await plugin.buildIndex();

    assert.equal(await pdfsIndexed(root), 1);
    for (const chunk of SAMPLE_CHUNKS) {
        assert.ok(text.seen.includes(chunk), `${JSON.stringify(chunk)} in ${JSON.stringify(text.seen)}`);
    }
    assert.deepEqual(
        [...clipText.seen].sort(),
        [SAMPLE_TITLE, "Hydration", "Sourdough", "loaf"],
        "the PDF's proxy is its metadata title, not its file name",
    );
    assert.ok(notices.some((n) => n.includes("1 PDFs (1 embedded)")), JSON.stringify(notices));
    assert.deepEqual(skips(plugin), []);
});

test("with PDFs off, none is read and the index holds the notes and images alone", async () => {
    const root = vaultCopy();
    const { plugin, text, clipText } = await load(root, { indexPdfs: false });
    await plugin.buildIndex();

    assert.equal(await pdfsIndexed(root), 0);
    assert.ok(!text.seen.some((t) => SAMPLE_CHUNKS.includes(t)));
    assert.ok(!clipText.seen.includes(SAMPLE_TITLE));
});

test("a PDF indexed without an image space gets no title proxy, and needs none", async () => {
    const root = vaultCopy();
    const { plugin, text, clipText } = await load(root, { searchImages: false });
    await plugin.buildIndex();

    assert.equal(await pdfsIndexed(root), 1);
    assert.ok(text.seen.includes(SAMPLE_CHUNKS[0]!));
    assert.deepEqual(clipText.seen, []);
});

test("rebuilding an unchanged vault extracts and embeds nothing", async () => {
    const root = vaultCopy();
    await (await load(root)).plugin.buildIndex();

    const again = await load(root);
    let workers = 0;
    const Shim = WorkerShim;
    (globalThis as { Worker?: unknown }).Worker = class extends Shim {
        constructor(url: string | URL) {
            super(url);
            workers++;
        }
    };
    try {
        await again.plugin.buildIndex();
    } finally {
        (globalThis as { Worker?: unknown }).Worker = Shim;
    }
    assert.equal(workers, 0, "an unchanged PDF is reused by its hash, not extracted again");
    assert.deepEqual(again.text.seen, []);
    assert.deepEqual(again.clipText.seen, []);
    assert.equal(await pdfsIndexed(root), 1);
});

test("a PDF that will not extract is skipped, and the next file still gets a working worker", async () => {
    const root = vaultCopy({ "notes/scanned.pdf": scannedPdf() });
    copyFileSync(join(dirname(GNOSIS_TEST_VAULT), "malformed-ops.pdf"), join(root, "notes/malformed.pdf"));
    const { plugin, text, clipText } = await load(root);
    // Path order: malformed traps its worker's wasm first, then sample has to
    // extract in a fresh one, then scanned turns out to have no text.
    await plugin.buildIndex();

    assert.equal(await pdfsIndexed(root), 1, "sample.pdf, between the two failures");
    assert.ok(text.seen.includes(SAMPLE_CHUNKS[1]!));
    assert.deepEqual(
        skips(plugin),
        [
            "skipped notes/malformed.pdf: unreachable",
            "skipped notes/scanned.pdf: no extractable text (an image-only or scanned PDF has no text layer)",
        ],
    );
    assert.ok(!clipText.seen.includes("malformed") && !clipText.seen.includes("scanned"), JSON.stringify(clipText.seen));
    assert.ok(notices.some((n) => n.includes("2 skipped as unreadable")), JSON.stringify(notices));
});

test("a build that checkpoints as it goes re-adds its PDFs by hash, and the result is the same", async () => {
    // Enough PDFs to fill several batches, so checkpoints land among them.
    const reference = vaultCopy();
    sampleCopies(reference, 24);
    const whole = await load(reference);
    await whole.plugin.buildIndex();

    const root = vaultCopy();
    sampleCopies(root, 24);
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
    assert.equal(await pdfsIndexed(root), 25);
    assert.equal(harness.text.seen.length, whole.text.seen.length, "no page embedded twice");
    assert.equal(harness.clipText.seen.length, whole.clipText.seen.length, "no title embedded twice");
});

test("canceling among the PDFs keeps their progress, and the resumed build extracts only the rest", async () => {
    const reference = vaultCopy();
    sampleCopies(reference, 12);
    const whole = await load(reference);
    await whole.plugin.buildIndex();

    const root = vaultCopy();
    sampleCopies(root, 12);
    const first = await load(root);
    first.text.afterCall = (calls) => {
        if (calls === 1) {
            (first.plugin as never as { building: AbortController }).building.abort();
        }
    };
    await first.plugin.buildIndex();
    assert.equal(first.checkpoints.saved.size, 1, "the canceled build keeps its progress");
    const pagesBefore = first.text.seen.length;
    assert.ok(pagesBefore > 0 && pagesBefore < whole.text.seen.length, `${pagesBefore} of ${whole.text.seen.length}`);
    assert.ok(first.clipText.seen.includes(SAMPLE_TITLE), "the PDFs done before the cancel have their proxies");

    const second = await load(root);
    for (const [k, v] of first.checkpoints.saved) second.checkpoints.saved.set(k, v);
    await second.plugin.buildIndex();
    assert.ok(notices.some((n) => n.includes("resuming")), JSON.stringify(notices));
    assert.equal(pagesBefore + second.text.seen.length, whole.text.seen.length, "no page embedded again");
    assert.equal(
        first.clipText.seen.length + second.clipText.seen.length,
        whole.clipText.seen.length,
        "no title embedded again",
    );
    assert.equal(await pdfsIndexed(root), 13);
    assert.equal(second.checkpoints.saved.size, 0);
});
