//! Does the plugin's CLIP text tower land a query where the gnosis CLI's does?
//!
//! The image space's vectors come from CLIP's vision tower, indexed by the
//! CLI. A text query reaches them through the text tower, which the plugin
//! runs through transformers.js and the CLI through fastembed. If the two
//! agree, every image scores the same either way, so this compares the scores
//! the plugin's query gives each image against the ones `gnosis search`
//! prints.
//!
//! Skipped unless pointed at a vault with images the CLI indexed and exported
//! with f32 vectors:
//!
//!   gnosis index . && gnosis export --quantize f32 --out .gnosis/artifact
//!   GNOSIS_PARITY_VAULT=/path/to/vault npm test
//!
//! `gnosis` must be on the PATH; `GNOSIS_FASTEMBED_CACHE` points it at an
//! existing model cache instead of downloading one. Downloads the model on
//! first run.

import assert from "node:assert/strict";
import test from "node:test";

import { App } from "./stubs/obsidian.js";
import { openArtifact } from "../src/artifact.js";
import { queryModelFor } from "../src/models.js";
import { queryVectors } from "../src/embedder.js";
import { clipPixels } from "../src/worker/preprocess.js";
import type { Hit, IndexInfo } from "../src/types.js";

const vault = process.env["GNOSIS_PARITY_VAULT"];
const options =
    vault === undefined ? { skip: "set GNOSIS_PARITY_VAULT to a vault with images, exported with f32 vectors" } : {};

const QUERIES = ["a red and white flag", "a blue striped flag", "an icon", "a dark wallpaper", "sun", "code editor logo"];

test("the plugin's CLIP text tower scores images as the CLI does", options, async () => {
    const { execFileSync } = await import("node:child_process");
    const index = await openArtifact(new App(vault!) as never, ".gnosis/artifact");
    const info = index.info() as IndexInfo;
    const space = info.spaces.find((s) => s.space === "image");
    assert.ok(space, "the index has no image space");
    const model = queryModelFor(space.queryModel);
    assert.ok(model, `no download known for ${space.queryModel}`);

    const { AutoTokenizer, CLIPTextModelWithProjection } = await import("@huggingface/transformers");
    const tokenizer = await AutoTokenizer.from_pretrained(model.repo, { revision: model.revision });
    const clip = await CLIPTextModelWithProjection.from_pretrained(model.repo, {
        revision: model.revision,
        dtype: model.dtype,
        subfolder: model.subfolder,
        model_file_name: "model",
    });
    const embedder = {
        embed: async (texts: string[]) => {
            const inputs = tokenizer(texts, { padding: true, truncation: true });
            const { text_embeds } = await clip(inputs);
            const normalized = text_embeds.normalize(2, -1);
            const dim = normalized.dims.at(-1)!;
            const flat = normalized.data as Float32Array;
            return texts.map((_, i) => Float32Array.from(flat.subarray(i * dim, (i + 1) * dim)));
        },
        dispose: () => {},
    };

    const cache = process.env["GNOSIS_FASTEMBED_CACHE"];
    let worst = 1;
    for (const query of QUERIES) {
        const cli = JSON.parse(
            execFileSync("gnosis", ["search", "--in", "image", "--limit", "1000", "--json", query], {
                cwd: vault!,
                encoding: "utf8",
                env: cache === undefined ? process.env : { ...process.env, FASTEMBED_CACHE_DIR: cache },
            }),
        ) as Hit[];
        const vectors = await queryVectors(embedder, space, query);
        const ours = index.search("", vectors, 1000, undefined) as Hit[];
        // The CLI prints absolute paths, the artifact stores relative ones.
        const name = (path: string) => path.split("/").pop()!;
        const theirs = new Map(ours.map((h) => [name(h.path), h.score]));
        assert.ok(cli.length > 0, `"${query}": the CLI found no images`);
        const gap = Math.max(
            ...cli.map((h) => {
                const score = theirs.get(name(h.path));
                assert.ok(score !== undefined, `"${query}": the plugin did not find ${h.path}`);
                return Math.abs(h.score - score);
            }),
        );
        assert.deepEqual(
            ours.slice(0, cli.length).map((h) => name(h.path)),
            cli.map((h) => name(h.path)),
            `"${query}": the same images in the same order`,
        );
        worst = Math.min(worst, 1 - gap);
        console.log(`image parity: "${query}" — ${cli.length} images, largest score difference ${gap.toExponential(2)}`);
        assert.ok(gap < 1e-4, `"${query}": scores differ by ${gap}`);
    }
    console.log(`image parity: worst agreement ${worst.toFixed(6)} over ${QUERIES.length} queries`);
});

/**
 * Does the plugin's vision tower reproduce the vectors the CLI stored for the
 * images themselves?
 *
 * Each image under the vault is embedded here and used as a dense-only query
 * against the image space: if preprocessing (decode, resize, crop,
 * normalize) matches fastembed's, the image's own document comes back first
 * with a cosine of ~1. Preprocessing differences show up here first.
 */
test("the plugin's CLIP vision tower reproduces the CLI's image vectors", options, async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const index = await openArtifact(new App(vault!) as never, ".gnosis/artifact");
    const info = index.info() as IndexInfo;
    const space = info.spaces.find((s) => s.space === "image")!;
    const vision = queryModelFor("clip-vit-b-32-vision");
    assert.ok(vision, "no vision model is registered");

    const { CLIPVisionModelWithProjection, RawImage, Tensor } = await import("@huggingface/transformers");
    const clip = await CLIPVisionModelWithProjection.from_pretrained(vision.repo, {
        revision: vision.revision,
        dtype: vision.dtype,
        subfolder: vision.subfolder,
        model_file_name: "model",
    });

    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith(".")) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(entry.name)) files.push(full);
        }
    };
    walk(vault!);
    assert.ok(files.length > 0, "the vault has no images");

    let lowest = 1;
    for (const file of files) {
        const decoded = (await RawImage.fromBlob(new Blob([readFileSync(file)]))).rgba();
        const pixels = clipPixels(decoded.data, decoded.width, decoded.height);
        const { image_embeds } = await clip({ pixel_values: new Tensor("float32", pixels, [1, 3, 224, 224]) });
        const vector = Float32Array.from(image_embeds.normalize(2, -1).data as Float32Array);
        assert.equal(vector.length, space.dim);
        const own = relative(vault!, file);
        const ranked = index.search("", new Map([["image", vector]]), 1000, undefined) as Hit[];
        const hit = ranked.find((h) => h.path === own);
        assert.ok(hit, `${own} is not in the index`);
        lowest = Math.min(lowest, hit.score);
        console.log(`  ${own}: ${hit.score.toFixed(4)}`);
        assert.equal(ranked[0]!.path, own, `${own}: the top hit is ${ranked[0]!.path}`);
    }
    console.log(`image parity: ${files.length} images, lowest own-score ${lowest.toFixed(6)}`);
    assert.ok(lowest > 0.999, `an image re-embedded here should match its stored vector, got ${lowest}`);
});
