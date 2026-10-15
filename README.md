# gnosis for Obsidian

Search your vault with [gnosis](https://github.com/ptsouchlos/gnosis)'s own
retrieval pipeline, reading a portable index you built on your own machine.
No server, no API key, nothing leaves the vault.

The ranking code is not reimplemented here. gnosis's query pipeline is
compiled to WebAssembly and vendored in `vendor/gnosis-wasm/`, so the lexical
channel, BM25+'s parameters, the title bonus, the fusion weight and the vector
comparison behind related-notes are the same code — and the same measurements —
as the CLI's. This plugin reads bytes out of the vault, calls into it, and
shows what comes back.

## Status: stage 1

**Works now, with no model and no download:**

- **Search vault** — BM25+ over the index's own text. On the scifact benchmark
  this tier scores 0.666 nDCG@10 against the hybrid pipeline's 0.722: worse
  than semantic search, and far from nothing.
- **Related notes** — the most similar notes to the current one, at *full*
  quality, because both sides of that comparison are vectors the index already
  carries. Notes the current one already links to are excluded, so what is left
  is unlinked mentions.
- **Show index info** — what built the index, when, and how much it holds.

**Not yet:**

- **Semantic search**, which needs a query embedder. The index records the model
  id *and* its pooling for exactly this: a client that guesses pooling produces
  vectors that look healthy and throw away most of their usable range.
- **Staleness reporting** — "built 3 days ago, 47 notes have changed since".
- **Images**, which the index already carries.
- **Indexing from the plugin.** The design is one designated indexer: the
  machine with the models builds the index, and every other machine reads it.

## Getting started

Build an index with the gnosis CLI, in the vault:

```sh
cd /path/to/vault
gnosis index .
gnosis export --out .gnosis/artifact
```

Then install the plugin and point it at that folder (`.gnosis/artifact` is the
default). The index is a manifest plus shards; shard names are stable and only
changed documents are rewritten, so it syncs as a handful of files rather than
one large one.

## Building

```sh
npm install
npm run build     # writes main.js
npm test          # the suites below
script/install.sh /path/to/vault
```

No Rust toolchain needed: the WebAssembly module and its JS glue are committed
under `vendor/gnosis-wasm/`, with the gnosis revision they came from recorded
in `vendor/gnosis-wasm/GNOSIS_REV`. To refresh them from a gnosis checkout:

```sh
script/update-wasm.sh ../gnosis
```

`main.js` is about 440 KB, most of it the inlined 317 KB `.wasm`. It is inlined
because the community-plugin channel ships only `main.js`, `manifest.json` and
`styles.css` — which also means the plugin never touches the network.

## Tests

Three suites, each answering something the others cannot:

- `test/plugin.test.ts` — the plugin's own logic against a committed fixture
  vault and a real artifact: lazy loading, the commands, resolving a hit back
  to a file, and what it says when a note in the index is gone from the vault.
  Obsidian's API is stubbed in `test/stubs/obsidian.ts`; the WebAssembly module
  and the artifact are real.
- `test/bundle.test.cjs` — the shipped `main.js`: bundled, minified, CommonJS,
  with the `.wasm` inlined, required the way Obsidian requires it. This is
  where a bundler mistake shows up instead of in a user's console.
- `test/real-vault.test.ts` — the same plugin against a real vault, skipped
  unless pointed at one: `GNOSIS_VAULT=/path/to/vault npm test`. It asserts the
  thing a fixture cannot — that every result resolves to a file that is
  actually there.
