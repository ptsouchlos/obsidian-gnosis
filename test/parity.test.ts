//! Does the plugin embed into the same space gnosis indexed into?
//!
//! Everything else in these suites replaces the model. This one runs it — the
//! repository, revision and ONNX file `src/models.ts` names, with the pooling
//! and document prefix the index recorded — and checks the result against the
//! vectors the gnosis CLI stored.
//!
//! The check is on the document side, because that is where the CLI's output
//! is available to compare against: each chunk's exact embedding input
//! (document prefix, heading trail, body, joined as `index::join_lines` joins
//! them) is re-embedded here and used as a dense-only query. If this plugin
//! reproduces gnosis's vector, the chunk's own document comes back first with
//! a cosine of 1 — measured, not assumed. The query prefix is a string the
//! manifest supplies, and `semantic.test.ts` pins that it is the one applied.
//!
//! transformers.js runs under node here, on ONNX Runtime's native provider.
//! The worker in Obsidian runs the WebAssembly one; both execute the same
//! ONNX graph, and a difference between them is not something this can see.
//!
//! Skipped unless pointed at a vault the CLI exported with f32 vectors (i8
//! would cap agreement at quantization error rather than test the model):
//!
//!   gnosis index . && gnosis export --quantize f32 --out .gnosis/artifact
//!   GNOSIS_PARITY_VAULT=/path/to/vault npm test
//!
//! Downloads the model on first run.

import assert from "node:assert/strict";
import test from "node:test";

import { App } from "./stubs/obsidian.js";
import { openArtifact } from "../src/artifact.js";
import { SHARD_DOCS } from "../src/build/plan.js";
import { queryModelFor } from "../src/models.js";
import type { Hit, IndexInfo } from "../src/types.js";

const vault = process.env["GNOSIS_PARITY_VAULT"];
const options =
    vault === undefined ? { skip: "set GNOSIS_PARITY_VAULT to a vault exported with f32 vectors" } : {};

/** `index::join_lines`: heading trail and body, newline-joined, either may be empty. */
function joinLines(heading: string, text: string): string {
    if (heading === "") return text;
    if (text === "") return heading;
    return `${heading}\n${text}`;
}

test("the plugin's model reproduces the vectors gnosis stored", options, async () => {
    const index = await openArtifact(new App(vault!) as never, ".gnosis/artifact");
    const info = index.info() as IndexInfo;
    assert.equal(info.quantization, "f32", "export with --quantize f32 so agreement can be exact");
    const space = info.spaces.find((s) => s.space === "text")!;
    const model = queryModelFor(space.queryModel);
    assert.ok(model, `no download known for ${space.queryModel}`);

    // Dense only: the lexical channel would reward a chunk for containing its
    // own words, which says nothing about the vector.
    index.setSearchConfig({ ...(index.searchConfig() as object), lexical: false });

    // The chunks themselves, gathered through the lexical channel since that
    // is what returns chunk text. A search answers with each document's best
    // chunk only, so words are drawn from the chunks found so far: a word
    // from a document's second chunk tends to surface that chunk next.
    const chunks = new Map<string, Hit>();
    const asked = new Set<string>();
    const queue = ["notes", "the"];
    while (queue.length > 0 && asked.size < 2000) {
        const word = queue.shift()!;
        if (asked.has(word)) continue;
        asked.add(word);
        for (const hit of index.lexicalSearch(word, 1000, undefined) as Hit[]) {
            const key = `${hit.path}\u0000${hit.heading_path}\u0000${hit.text}`;
            if (chunks.has(key)) continue;
            chunks.set(key, hit);
            queue.push(...(hit.text.toLowerCase().match(/[a-z]{5,}/g) ?? []));
        }
    }
    console.log(`parity: reached ${chunks.size} of ${info.chunks} chunks with ${asked.size} probe words`);
    assert.ok(chunks.size > info.chunks / 2, `only ${chunks.size} of ${info.chunks} chunks reached`);

    const { pipeline } = await import("@huggingface/transformers");
    const extractor = await pipeline("feature-extraction", model.repo, {
        revision: model.revision,
        dtype: model.dtype,
    });

    // A chunk's own document must score ~1 and tie for first. Not "be first":
    // a template and a note made from it can hold byte-identical chunks, whose
    // vectors are then identical too, and either may win the tie.
    let matched = 0;
    let lowest = Infinity;
    let ties = 0;
    const misses: string[] = [];
    for (const hit of chunks.values()) {
        const input = `${space.documentPrefix}${joinLines(hit.heading_path, hit.text)}`;
        const output = await extractor([input], { pooling: space.pooling as "cls" | "mean", normalize: true });
        const vector = Float32Array.from(output.data as Float32Array);
        const ranked = index.search("", new Map([["text", vector]]), 1000, undefined) as Hit[];
        const own = ranked.find((h) => h.path === hit.path);
        const top = ranked[0]!;
        if (own !== undefined && own.score >= top.score - 1e-6) {
            matched++;
            lowest = Math.min(lowest, own.score);
            if (top.path !== hit.path) ties++;
        } else {
            misses.push(`${hit.path}: own ${own?.score.toFixed(6)}, top ${top.path} ${top.score.toFixed(6)}`);
        }
    }
    console.log(
        `parity: ${matched}/${chunks.size} chunks score their own document top ` +
            `(${ties} in a tie with an identical chunk elsewhere); lowest ${lowest.toFixed(6)} ` +
            `(${space.queryModel}, ${space.pooling}, document prefix ${JSON.stringify(space.documentPrefix)})`,
    );
    assert.deepEqual(misses, [], "every chunk must find its own document at the top");
    assert.ok(lowest > 0.9999, `a re-embedded chunk should match its stored vector, got ${lowest}`);
});

/**
 * Does an index the plugin builds match the one the CLI built from the same
 * vault?
 *
 * The vault is copied without its index and built from nothing by the
 * plugin's own build command, with the real model under node. The comparison
 * is against a CLI export at the same quantization, which defaults to i8,
 * and the same shard size, `SHARD_DOCS` in `src/build/plan.ts`:
 *
 *   gnosis export --quantize i8 --shard-docs <SHARD_DOCS> --out .gnosis/artifact-i8
 *
 * The vault has to be indexed with images off (`[embed.image] enabled =
 * false`, image files ignored): the plugin builds notes only, so each image
 * the CLI indexed would be a document only one side has.
 *
 * Everything but the vectors is decided by gnosis's own code on both sides,
 * so documents, chunks and every chunk's text must match exactly. The
 * vectors come from two runtimes — fastembed and transformers.js — so the
 * strongest possible outcome is byte-identical shards, if their last-bit
 * differences never cross an i8 rounding boundary. This reports how close it
 * gets, and asserts what must hold regardless.
 */
const i8 = process.env["GNOSIS_PARITY_I8"] ?? ".gnosis/artifact-i8";

test("the plugin builds the index the CLI built", options, async () => {
    const { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { basename, join } = await import("node:path");
    const cliDir = join(vault!, i8);
    if (!existsSync(join(cliDir, "manifest.json"))) {
        throw new Error(`no CLI export at ${cliDir}: run gnosis export --quantize i8 --shard-docs ${SHARD_DOCS} --out ${i8}`);
    }
    const exported = JSON.parse(readFileSync(join(cliDir, "manifest.json"), "utf8")).shard_docs;
    if (exported !== SHARD_DOCS) {
        throw new Error(`${cliDir} was exported with --shard-docs ${exported}; the plugin builds with ${SHARD_DOCS}`);
    }

    // The same folder name: the CLI labels a vault by it, and so does the plugin.
    const copy = join(mkdtempSync(join(tmpdir(), "gnosis-parity-")), basename(vault!));
    cpSync(vault!, copy, { recursive: true, preserveTimestamps: true });
    rmSync(join(copy, ".gnosis"), { recursive: true, force: true });

    const { default: GnosisPlugin } = await import("../src/main.js");
    const { MemoryCheckpoints } = await import("../src/build/checkpoints.js");
    const { pipeline } = await import("@huggingface/transformers");
    const app = new App(copy);
    const plugin = new GnosisPlugin(app as never, { id: "gnosis", version: "parity" } as never);
    await plugin.onload();
    const cliManifest = JSON.parse(readFileSync(join(cliDir, "manifest.json"), "utf8"));
    plugin.settings.buildModel = cliManifest.spaces[0].model.id;
    plugin.checkpoints = new MemoryCheckpoints();
    plugin.askConsent = async () => true;
    plugin.confirmReplace = async () => true;
    plugin.embedderFactory = async (model, pooling) => {
        const extractor = await pipeline("feature-extraction", model.repo, {
            revision: model.revision,
            dtype: model.dtype,
        });
        return {
            embed: async (texts: string[]) => {
                const output = await extractor(texts, { pooling, normalize: true });
                const dim = output.dims.at(-1)!;
                const flat = output.data as Float32Array;
                return texts.map((_, i) => Float32Array.from(flat.subarray(i * dim, (i + 1) * dim)));
            },
            dispose: () => {},
        };
    };
    const started = Date.now();
    await plugin.buildIndex();
    const seconds = (Date.now() - started) / 1000;

    const pluginDir = join(copy, ".gnosis/artifact");
    const ours = await openArtifact(new App(copy) as never, ".gnosis/artifact");
    const theirs = await openArtifact(new App(vault!) as never, i8);
    const a = ours.info() as IndexInfo;
    const b = theirs.info() as IndexInfo;
    console.log(`build: ${a.documents} notes, ${a.chunks} chunks in ${seconds.toFixed(1)} s (node, native ONNX Runtime)`);
    assert.equal(a.documents, b.documents, "the same notes");
    assert.equal(a.chunks, b.chunks, "chunked the same way");
    assert.deepEqual(a.roots, b.roots, "labeled the same way");
    assert.deepEqual(
        a.spaces.map(({ chunks: _c, ...s }) => s),
        b.spaces.map(({ chunks: _c, ...s }) => s),
        "the same model, pooling and prefixes recorded",
    );

    // Text-only signals must agree exactly: they never touch a vector.
    for (const q of ["note", "template", "daily", "book", "evergreen", "meeting", "recipe"]) {
        assert.deepEqual(ours.lexicalSearch(q, 50, undefined), theirs.lexicalSearch(q, 50, undefined), q);
    }

    // Byte for byte. Measured on kepano-obsidian, the only bytes that differ
    // are per-chunk i8 scales (max/127), by under 1e-6 relative: fastembed and
    // transformers.js agree on every quantized component and differ in the
    // float's last bits. So that is what is asserted — everything identical
    // except the scale field, and that field within 1e-5.
    const names = readdirSync(cliDir).filter((n) => n.endsWith(".bin")).sort();
    assert.deepEqual(readdirSync(pluginDir).filter((n) => n.endsWith(".bin")).sort(), names, "the same shards");
    let identical = 0;
    let scalesDiffer = 0;
    let worst = 0;
    for (const name of names) {
        const mine = readFileSync(join(pluginDir, name));
        const cli = readFileSync(join(cliDir, name));
        assert.equal(mine.length, cli.length, `${name}: same length`);
        if (mine.equals(cli)) {
            identical++;
            continue;
        }
        // Header, section table, document block, then 32-byte chunk records
        // whose last four bytes are the scale; see gnosis's `write_shard`.
        const sections = cli[9]!;
        const recordsAt = 16 + sections * 12 + cli.readUInt32LE(12);
        let count = 0;
        for (let i = 0; i < sections; i++) count += cli.readUInt32LE(16 + i * 12 + 8);
        const vectorsAt = recordsAt + count * 32;
        for (let i = 0; i < cli.length; i++) {
            if (mine[i] === cli[i]) continue;
            const inScale = i >= recordsAt && i < vectorsAt && (i - recordsAt) % 32 >= 28;
            assert.ok(inScale, `${name}: byte ${i} differs outside a scale field`);
        }
        for (let r = 0; r < count; r++) {
            const at = recordsAt + r * 32 + 28;
            const a = mine.readFloatLE(at);
            const b = cli.readFloatLE(at);
            if (a !== b) {
                scalesDiffer++;
                worst = Math.max(worst, Math.abs(a - b) / Math.abs(b));
            }
        }
    }
    console.log(
        `build: ${identical}/${names.length} shard(s) byte-identical; elsewhere only ${scalesDiffer} ` +
            `of ${a.chunks} i8 scales differ, by at most ${worst.toExponential(2)} relative`,
    );
    assert.ok(worst < 1e-5, `a scale differs by ${worst} relative`);
    ours.free();
    theirs.free();
});

/**
 * Does the plugin's content hash match the one the CLI recorded?
 *
 * Staleness hashes a note to clear an mtime that moved without an edit. If
 * the plugin's hash of a note's text differed from the CLI's hash of the
 * file, every such note would read as changed against a CLI-built index.
 * Asked by hash alone, for every note, so each one is compared. Needs no
 * model and any quantization.
 */
test("the plugin hashes notes as the CLI recorded them", options, async () => {
    const { contentHash } = await import("../vendor/gnosis-wasm/gnosis_wasm.js");
    const app = new App(vault!);
    // Opening starts the WebAssembly module `contentHash` lives in.
    const index = await openArtifact(app as never, ".gnosis/artifact");
    const notes = app.vault.getMarkdownFiles();
    const entries = await Promise.all(
        notes.map(async (file) => ({ path: file.path, hash: contentHash(await app.vault.cachedRead(file)) })),
    );
    const report = index.staleness(entries) as { changed: string[]; added: string[]; unchanged: number };
    console.log(`hash parity: ${report.unchanged} of ${notes.length} notes match the CLI's hash`);
    assert.deepEqual(report.changed, [], "every note's hash matches the CLI's");
    assert.deepEqual(report.added, [], "and every note is in the CLI's index");
});
