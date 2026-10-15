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

## Status: stage 2

**Works with no model and no download:**

- **Search vault** — BM25+ over the index's own text. On the scifact benchmark
  this tier scores 0.666 nDCG@10 against the hybrid pipeline's 0.722: worse
  than semantic search, and far from nothing.
- **Related notes** — the most similar notes to the current one, at *full*
  quality, because both sides of that comparison are vectors the index already
  carries. Notes the current one already links to are excluded, so what is left
  is unlinked mentions.
- **Show index info** — what built the index, when, and how much it holds.

**Semantic search, once you turn it on** (Settings → Semantic search):

- **Search vault** becomes hybrid: the query is embedded with the model your
  index was built with and fused with the keyword channel, by gnosis's own
  ranking code. While the model loads, search answers with keywords and says
  so.
- Turning it on asks first, and lists what it downloads: the model's files
  from Hugging Face at the revision the gnosis CLI uses (bge-small-en-v1.5:
  134 MB; multilingual-e5-small: 487 MB), and ONNX Runtime's WebAssembly engine
  from jsDelivr (14.3 MB), which is checked against a SHA-256 pinned at build
  time before it runs. Both are cached; a second session downloads nothing.
- **Nothing leaves the device.** The model runs locally in a worker; notes and
  queries are never uploaded.
- How a query is embedded — pooling and the query prefix — is read from the
  index rather than assumed, so an index built with `query_instruction = false`
  is queried without the instruction, as the CLI would.

**Not yet:**

- **Staleness reporting** — "built 3 days ago, 47 notes have changed since".
- **Images**, which the index already carries; a text query needs CLIP's text
  tower, a second model.
- **Indexing from the plugin.** For now the machine with the CLI builds the
  index, and every machine reads it.

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

`main.js` is about 1.4 MB: the inlined 666 KB gnosis `.wasm`, and the
embedding worker (transformers.js and ONNX Runtime's JavaScript, 509 KB), which
is inlined as source and started from a blob. Both are inlined because the
community-plugin channel ships only `main.js`, `manifest.json` and
`styles.css`. The only network access is the consented download above: the
plugin fetches no JavaScript at run time.

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
- `test/semantic.test.ts` — semantic search with the model replaced by a
  stand-in that records its inputs: consent before any download, the index's
  own query prefix applied, the keyword fallback while the model loads, and
  what it says when the model cannot load or the index's model is unsupported.
  The WebAssembly module and its hybrid ranking are real.
- `test/parity.test.ts` — the real model, against vectors the gnosis CLI
  stored: each chunk's exact embedding input is re-embedded with the files
  `src/models.ts` names and must find its own document with a cosine of ~1.
  Skipped unless pointed at a vault exported with f32 vectors:
  `GNOSIS_PARITY_VAULT=/path/to/vault npm test`. Downloads the model.
- `test/real-vault.test.ts` — the same plugin against a real vault, skipped
  unless pointed at one: `GNOSIS_VAULT=/path/to/vault npm test`. It asserts the
  thing a fixture cannot — that every result resolves to a file that is
  actually there.
