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
