/* tslint:disable */
/* eslint-disable */

/**
 * Accumulates documents, then packs them into an artifact.
 */
export class Builder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Offer one document to the index.
     *
     * `mtime_ms` is a JavaScript timestamp in milliseconds; the artifact
     * records seconds, as the CLI does from the filesystem.
     */
    addDocument(path: string, text: string, mtime_ms: number): any;
    /**
     * A builder with nothing to reuse: every document will be embedded.
     */
    static create(spec: any): Builder;
    /**
     * How many documents have been offered.
     */
    documentCount(): number;
    /**
     * Pack everything added into shards.
     *
     * `created_unix` comes from the client because wasm has no clock. It is
     * the one field that makes two otherwise identical artifacts differ.
     */
    finish(created_unix: number): any;
    /**
     * A builder that reuses an existing artifact: a document whose content
     * hash matches keeps its chunks *and its vectors*, so an ordinary day's
     * editing re-embeds a handful of chunks rather than a vault.
     */
    static fromArtifact(spec: any, manifest_json: string, shards: Map<any, any>): Builder;
    /**
     * How many documents are waiting for vectors, for a progress report.
     */
    pendingCount(): number;
    /**
     * Supply one document's vectors, flat and in chunk order.
     *
     * Flat rather than an array of arrays: this is the one call that moves
     * real volume across the boundary, and a `Float32Array` of
     * `chunks * dim` copies once.
     */
    setVectors(path: string, vectors: Float32Array): void;
}

/**
 * A loaded artifact, queried through gnosis's own retrieval pipeline.
 */
export class Index {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * What this artifact is: its models, their pooling and prefixes, its dimensions,
     * how much it holds and when it was built.
     */
    info(): any;
    /**
     * Search the lexical channel alone, with no model at all.
     *
     * This is the tier a client can offer before it has downloaded anything:
     * BM25+ over the artifact's own text, scored and ranked by the same code
     * the hybrid path uses, with the title bonus applied. On scifact it
     * scores 0.666 nDCG@10 against the hybrid path's 0.722 — worse, and far
     * from nothing.
     */
    lexicalSearch(query: string, limit: number, filter: any): any;
    /**
     * Assemble an index from bytes the client has already read.
     *
     * `shards` maps each shard's name, as the manifest lists it, to its
     * bytes. Shards are verified against the manifest's hashes, so a
     * partially synced artifact fails to open rather than answering queries
     * from a mixture of two indexes.
     */
    static open(manifest_json: string, shards: Map<any, any>): Index;
    /**
     * Documents most similar to `path`'s own chunks — the other model-free
     * tier, at full quality, since both sides of the comparison are vectors
     * the artifact already carries.
     *
     * Unless `include_linked` is set, the source and everything it links to
     * are excluded: the point is unlinked mentions. Link resolution here
     * matches filename stems only — an artifact carries no frontmatter, so a
     * host with its own alias index (Obsidian has one) should resolve aliases
     * there and pass the results in a filter rather than expect this to.
     */
    related(path: string, limit: number, include_linked: boolean, filter: any): any;
    /**
     * The configuration in force, so a client can report it.
     */
    searchConfig(): any;
    /**
     * Run a hybrid query: one vector per space, fused with the lexical
     * channel in the text space.
     *
     * `vectors` maps a space name (`"text"`, `"image"`) to a `Float32Array`.
     * The spaces searched are exactly the ones a vector was supplied for —
     * a space without an embedder is not silently skipped, it is simply not
     * asked about.
     */
    search(query: string, vectors: Map<any, any>, limit: number, filter: any): any;
    /**
     * Override the retrieval configuration.
     *
     * The artifact does not carry one — it is the indexing machine's local
     * setting, and the defaults here are the measured ones. A client that
     * changes it is choosing to diverge from what this project's numbers
     * describe, which is why it is a separate, explicit call.
     */
    setSearchConfig(config: any): void;
    /**
     * How related each of `paths` is to each other: a square array where row
     * `i`, column `j` is the text-space score `related(paths[i])` ranks
     * `paths[j]` by, or `null` on the diagonal and for a pair `related` would
     * never list.
     *
     * For placing related notes relative to each other, which one `related`
     * list cannot say. Calling `related` once per note instead costs a scan
     * of every chunk per note — measured at ~0.5 s for 20 notes over 4,199
     * chunks — and still misses most pairs past its limit. This reads only
     * the listed notes' own chunks.
     *
     * Text space only, and raw: on an artifact with more than one space,
     * `related` normalizes each space against its own result list before
     * merging, so its numbers are not these. A pair scored on its own has no
     * list to normalize against. On a text-only artifact they are the same
     * numbers.
     */
    similarities(paths: string[]): any;
    /**
     * Compare a client's own view of its vault against what the artifact
     * holds.
     *
     * The client does the walk — only it can — and this does the comparison.
     * Nothing here can *fix* staleness: only the machine with the models can
     * re-index. So the requirement is an accurate report, and an entry whose
     * freshness cannot be determined is reported as such rather than counted
     * as fresh.
     */
    staleness(entries: any): any;
}

/**
 * The content hash `addDocument` records for `text`, for `Index.staleness`.
 *
 * A client that sends a hash gets an exact answer, where an mtime moves
 * whenever a syncer or another plugin rewrites a file unchanged.
 */
export function contentHash(text: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_builder_free: (a: number, b: number) => void;
    readonly __wbg_index_free: (a: number, b: number) => void;
    readonly builder_addDocument: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly builder_create: (a: number, b: number) => void;
    readonly builder_documentCount: (a: number, b: number) => void;
    readonly builder_finish: (a: number, b: number, c: number) => void;
    readonly builder_fromArtifact: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly builder_pendingCount: (a: number, b: number) => void;
    readonly builder_setVectors: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly contentHash: (a: number, b: number, c: number) => void;
    readonly index_info: (a: number, b: number) => void;
    readonly index_lexicalSearch: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly index_open: (a: number, b: number, c: number, d: number) => void;
    readonly index_related: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly index_search: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly index_searchConfig: (a: number, b: number) => void;
    readonly index_setSearchConfig: (a: number, b: number, c: number) => void;
    readonly index_similarities: (a: number, b: number, c: number, d: number) => void;
    readonly index_staleness: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
