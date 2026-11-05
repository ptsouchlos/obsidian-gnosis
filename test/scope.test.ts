//! The scope prefixes: what a reader may type, and what each means.
//!
//! Parsed in the search box only, so nothing here needs a vault or a model —
//! the rules are all about the shape of the query.

import assert from "node:assert/strict";
import test from "node:test";

import { parseScope, scopeLabel } from "../src/scope.js";

test("a scope at the start limits the query to that kind", () => {
    assert.deepEqual(parseScope("txt: hydration"), { kinds: ["markdown"], rest: "hydration" });
    assert.deepEqual(parseScope("img: red bicycle"), { kinds: ["image"], rest: "red bicycle" });
    assert.deepEqual(parseScope("pdf: the report"), { kinds: ["pdf"], rest: "the report" });
});

test("the longer aliases name the same kinds", () => {
    assert.deepEqual(parseScope("md: hydration"), parseScope("txt: hydration"));
    assert.deepEqual(parseScope("image: red bicycle"), parseScope("img: red bicycle"));
});

test("a prefix is read case-insensitively, like the rest of the query", () => {
    assert.deepEqual(parseScope("TXT: hydration"), { kinds: ["markdown"], rest: "hydration" });
    assert.deepEqual(parseScope("Img: red bicycle"), { kinds: ["image"], rest: "red bicycle" });
});

test("only the start of the query is a scope", () => {
    assert.deepEqual(parseScope("todo: call Sam"), { kinds: [], rest: "todo: call Sam" });
    assert.deepEqual(parseScope("baker's txt: percentages"), { kinds: [], rest: "baker's txt: percentages" });
});

test("the space after the colon is optional", () => {
    assert.deepEqual(parseScope("txt:hydration"), { kinds: ["markdown"], rest: "hydration" });
    assert.deepEqual(parseScope("txt:  hydration"), { kinds: ["markdown"], rest: "hydration" });
});

test("a scope with nothing after it searches nothing, like an empty query", () => {
    assert.deepEqual(parseScope("img:"), { kinds: ["image"], rest: "" });
});

test("a query with no prefix comes back unchanged", () => {
    assert.deepEqual(parseScope("hydration"), { kinds: [], rest: "hydration" });
    assert.deepEqual(parseScope(""), { kinds: [], rest: "" });
});

test("a scope the reader mistypes is an ordinary query", () => {
    assert.deepEqual(parseScope("tnt: hydration"), { kinds: [], rest: "tnt: hydration" });
});

test("the label says what a scope searches, in the reader's words", () => {
    assert.equal(scopeLabel([]), null, "no scope names nothing");
    assert.equal(scopeLabel(["markdown"]), "notes");
    assert.equal(scopeLabel(["image"]), "images");
    assert.equal(scopeLabel(["pdf"]), "PDFs");
});
