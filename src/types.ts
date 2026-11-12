//! The shapes the query client returns.
//!
//! `gnosis-wasm`'s generated types say `any`, because what crosses the
//! boundary is JSON. These are that JSON, written down once so the rest of the
//! plugin is type-checked against something.

/** One ranked result. Mirrors `search::Hit`. */
export interface Hit {
    /** Vault-relative, as the artifact stored it. */
    path: string;
    title: string;
    /** The label of the vault root this document was indexed under. */
    source_root: string;
    /** The chunk's heading trail, empty for a document with no headings. */
    heading_path: string;
    text: string;
    score: number;
    width: number | null;
    height: number | null;
    /** What `score` is made of; the three add up to it. Mirrors `search::ScoreParts`. */
    parts: { meaning: number; keywords: number; title: number; recency: number };
    /**
     * Below its model's relevance floor, with keywords too weak to make up for
     * it: what had to rank here, not an answer. Mirrors `search::Hit::weak`.
     */
    weak: boolean;
}

/** What a space's model is, as a client needs it to embed a query. */
export interface SpaceInfo {
    space: string;
    model: string;
    queryModel: string;
    pooling: string;
    /** Prepended to a query before embedding it, as the index recorded it. */
    queryPrefix: string;
    /** Prepended to indexed content; only a build needs it. */
    documentPrefix: string;
    dim: number;
    chunks: number;
}

/** Mirrors `gnosis-wasm`'s `InfoReport`. */
export interface IndexInfo {
    formatVersion: number;
    createdUnix: number;
    documents: number;
    chunks: number;
    quantization: string;
    compression: string;
    /** How many documents each kind holds; kinds with none are absent. */
    kinds: { kind: string; documents: number }[];
    roots: string[];
    spaces: SpaceInfo[];
}

/** A filter, as both search calls accept it. */
export interface Filter {
    from?: string[];
    tags?: string[];
    /** Document kinds to keep (`markdown`, `image`, `pdf`); empty or absent keeps all. */
    kinds?: string[];
}
