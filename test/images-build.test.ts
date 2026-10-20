//! Building an index with images, end to end except for the models.
//!
//! Both CLIP towers are stand-ins: the vision tower answers a vector derived
//! from an image's bytes and refuses files named `corrupt`, the text tower a
//! vector derived from the title. Everything else is real — the builder in
//! WebAssembly, the artifact, the writer — and each test runs on its own copy
//! of the fixture vault. That the real towers reproduce the CLI's vectors is
//! `test/image-parity.test.ts`'s job.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { App, notices } from "./stubs/obsidian.js";
import GnosisPlugin from "../src/main.js";
import { MemoryCheckpoints } from "../src/build/checkpoints.js";
import { MemoryModelStore } from "../src/model-store.js";
import type { ImageEmbedder, ImageVectors, TextEmbedder } from "../src/embedder.js";
import type { IndexInfo } from "../src/types.js";
import { openArtifact } from "../src/artifact.js";

declare const GNOSIS_TEST_VAULT: string;

const ARTIFACT = ".gnosis/artifact";

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
    constructor(readonly dim: number) {}
    async embed(texts: string[]): Promise<Float32Array[]> {
        this.seen.push(...texts);
        return texts.map((t) => vectorOf(t, this.dim));
    }
    dispose(): void {}
}

class VisionTower implements ImageEmbedder {
    readonly batches: number[] = [];
    disposed = false;
    async embedImages(images: Uint8Array[]): Promise<ImageVectors> {
        this.batches.push(images.length);
        const failed = new Map<number, string>();
        const vectors = images.map((bytes, i) => {
            if (Buffer.from(bytes).toString().startsWith("corrupt")) {
                failed.set(i, "the image could not be decoded");
                return new Float32Array(512);
            }
            return vectorOf(bytes, 512);
        });
        return { vectors, failed };
    }
    dispose(): void {
        this.disposed = true;
    }
}

interface Harness {
    plugin: GnosisPlugin;
    text: TextTower;
    clipText: TextTower;
    vision: VisionTower;
    consents: string[][];
    visionStarts: number;
}

/** The fixture vault, plus the images a test names, with or without its artifact. */
function vaultCopy(images: Record<string, string>, options: { artifact: boolean }): string {
    const root = join(mkdtempSync(join(tmpdir(), "gnosis-images-")), "vault");
    cpSync(GNOSIS_TEST_VAULT, root, { recursive: true });
    if (!options.artifact) {
        rmSync(join(root, ".gnosis"), { recursive: true, force: true });
    }
    for (const [path, content] of Object.entries(images)) {
        writeFileSync(join(root, path), content);
    }
    return root;
}

async function load(root: string, options: { searchImages: boolean; visionHeld?: boolean }): Promise<Harness> {
    notices.length = 0;
    const app = new App(root);
    const plugin = new GnosisPlugin(app as never, { id: "gnosis", version: "0.0.0-test" } as never);
    await plugin.onload();
    plugin.settings.searchImages = options.searchImages;
    const harness: Harness = {
        plugin,
        text: new TextTower(384),
        clipText: new TextTower(512),
        vision: new VisionTower(),
        consents: [],
        visionStarts: 0,
    };
    plugin.hasWebgpu = async () => false;
    const store = new MemoryModelStore();
    if (options.visionHeld) {
        store.held_.add("Qdrant/clip-ViT-B-32-vision");
    }
    plugin.modelStore = store;
    plugin.embedderFactory = async (model) => (model.space === "image" ? harness.clipText : harness.text);
    plugin.visionFactory = async () => {
        harness.visionStarts++;
        return harness.vision;
    };
    plugin.checkpoints = new MemoryCheckpoints();
    plugin.askConsent = async (downloads) => {
        harness.consents.push(downloads.map((d) => d.what));
        return true;
    };
    plugin.confirmReplace = async () => true;
    plugin.confirmRebuild = async () => true;
    return harness;
}

async function opened(root: string) {
    const index = await openArtifact(new App(root) as never, ARTIFACT);
    return { index, info: index.info() as IndexInfo };
}

test("with image search on, a build indexes the images and a title proxy for every document", async () => {
    const root = vaultCopy({ "notes/flag.png": "pixels one", "notes/corrupt.png": "corrupt bytes" }, { artifact: false });
    const { plugin, text, clipText, vision } = await load(root, { searchImages: true });
    await plugin.buildIndex();

    const { index, info } = await opened(root);
    const image = info.spaces.find((s) => s.space === "image");
    assert.ok(image, "the index has an image space");
    assert.equal(image.model, "clip-vit-b-32");
    assert.equal(image.queryModel, "clip-vit-b-32");
    assert.equal(image.dim, 512);
    assert.equal(info.spaces[0]!.space, "text", "the text space is still first, as the CLI writes it");

    // The three images the vault holds: the fixture's loaf and the flag are
    // indexed, the corrupt one is skipped rather than failing the build.
    assert.deepEqual(
        [...clipText.seen].sort(),
        ["Hydration", "Sourdough", "flag", "loaf"],
        "every document's title: a note's parsed title, an image's file name",
    );
    assert.deepEqual(vision.batches, [3], "all three files in one call, one of which comes back undecodable");
    assert.equal(info.documents, 4, "two notes and two images");
    assert.ok(notices.some((n) => n.includes("2 images") && n.includes("1 skipped")), JSON.stringify(notices));
    assert.equal(vision.disposed, true, "the 352 MB model is not kept running after a build");
    assert.ok(text.seen.length > 0);

    // An image query finds the image, not a note's title proxy.
    const hits = index.search("", new Map([["image", vectorOf(Buffer.from("pixels one"), 512)]]), 5, undefined) as {
        path: string;
    }[];
    assert.equal(hits[0]!.path, "notes/flag.png");
});

test("rebuilding an unchanged vault embeds nothing, images and titles included", async () => {
    const root = vaultCopy({ "notes/flag.png": "pixels one" }, { artifact: false });
    const first = await load(root, { searchImages: true });
    await first.plugin.buildIndex();

    const again = await load(root, { searchImages: true });
    await again.plugin.buildIndex();
    assert.deepEqual(again.vision.batches, [], "no image is embedded again");
    assert.deepEqual(again.clipText.seen, [], "no title is embedded again");
    assert.deepEqual(again.text.seen, [], "no chunk is embedded again");
    assert.equal(again.visionStarts, 0, "the vision tower is not even loaded for a vault that has not changed");
});

test("a changed image is embedded again, and only it", async () => {
    const root = vaultCopy({ "notes/flag.png": "pixels one" }, { artifact: false });
    await (await load(root, { searchImages: true })).plugin.buildIndex();
    writeFileSync(join(root, "notes/flag.png"), "pixels two");

    const again = await load(root, { searchImages: true });
    await again.plugin.buildIndex();
    assert.deepEqual(again.vision.batches, [1]);
    assert.deepEqual(again.text.seen, []);
});

test("with image search off, images are left out and nothing about them is downloaded", async () => {
    const root = vaultCopy({ "notes/flag.png": "pixels one" }, { artifact: false });
    const { plugin, clipText, vision, visionStarts } = await (async () => {
        const h = await load(root, { searchImages: false });
        await h.plugin.buildIndex();
        return h;
    })();
    const { info } = await opened(root);
    assert.equal(info.documents, 2, "the notes alone");
    assert.equal(info.spaces.find((s) => s.space === "image"), undefined);
    assert.deepEqual(clipText.seen, []);
    assert.deepEqual(vision.batches, []);
    assert.equal(visionStarts, 0);
    void plugin;
});

test("an index built without images gains them when image search is turned on, reusing its notes", async () => {
    const root = vaultCopy({ "notes/flag.png": "pixels one" }, { artifact: false });
    await (await load(root, { searchImages: false })).plugin.buildIndex();

    const again = await load(root, { searchImages: true });
    await again.plugin.buildIndex();
    assert.deepEqual(again.text.seen, [], "the notes' text vectors are carried over");
    assert.deepEqual([...again.clipText.seen].sort(), ["Hydration", "Sourdough", "flag", "loaf"]);
    const { info } = await opened(root);
    assert.ok(info.spaces.some((s) => s.space === "image"));
    assert.equal(info.documents, 4);
});

test("an automatic update does not fetch the image model unasked", async () => {
    const root = vaultCopy({ "notes/flag.png": "pixels one" }, { artifact: false });
    const harness = await load(root, { searchImages: false, visionHeld: false });
    await harness.plugin.buildIndex();
    writeFileSync(join(root, "notes/new.md"), "# New\n\nA note written later.\n");
    harness.plugin.settings.searchImages = true;
    await harness.plugin.buildIndex(true);
    assert.equal(harness.visionStarts, 0);
    assert.ok(harness.plugin.autoSkipped?.includes("image model"), String(harness.plugin.autoSkipped));
});

test("turning image search on asks once for both towers, and names the vision one as later", async () => {
    const root = vaultCopy({}, { artifact: true });
    const harness = await load(root, { searchImages: false });
    let downloads: { what: string; later?: boolean }[] = [];
    harness.plugin.askConsent = async (d) => {
        downloads = d;
        return true;
    };
    assert.equal(await harness.plugin.enableImageSearch(), true);
    assert.deepEqual(
        downloads.map((d) => [d.what.split(" ")[0], d.later === true]),
        [
            ["clip-vit-b-32", false],
            ["clip-vit-b-32-vision", true],
            ["ONNX", false],
        ],
    );
});
