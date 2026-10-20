//! Where to fetch the model an index was built with, so a query lands in the
//! same vector space as the stored chunks.
//!
//! For an index that already exists, how to embed — pooling and the prefixes —
//! comes from its manifest, never from here: they are per-index facts. This
//! table supplies them only when the plugin builds an index from nothing, the
//! one case where it is the indexer and has to say what the CLI's own model
//! table would. `test/parity.test.ts` checks the two agree on a CLI-built index.
//!
//! The other column is the client's own concern: which files to download for a
//! model id.
//!
//! Each entry pins the repository and the exact revision the gnosis CLI's
//! embedder (fastembed) downloads, and the same ONNX file. Matching them is what
//! made query parity exact when measured — cosine 1.000000 between vectors
//! computed here and vectors gnosis stored — and a different export of "the same
//! model" would not be.

export interface QueryModel {
    /// The Hugging Face repository.
    repo: string;
    /// The commit fastembed resolved, so an upstream re-export cannot move the
    /// vectors out from under an existing index.
    revision: string;
    /// transformers.js's name for the ONNX file: `fp32` is `onnx/model.onnx`,
    /// the file fastembed loads.
    dtype: "fp32";
    /// The vector space this model embeds queries into.
    space: "text" | "image";
    /// How its output becomes a vector: a sentence encoder is pooled over its
    /// tokens; CLIP's text tower is projected into the image space instead,
    /// whatever pooling its index records (measured against the CLI: the
    /// projection reproduces its scores to 2e-7, mean pooling does not).
    architecture: "encoder" | "clip-text";
    /// Where the ONNX file sits in the repository: transformers.js looks in
    /// `onnx/`, and an export that keeps it at the root says so with "".
    subfolder: "onnx" | "";
    /// What the reader is asked to download, for the consent prompt.
    downloadBytes: number;
    /// The rest is what a fresh index records, copied from the gnosis CLI's
    /// `resolve_text_model` (with `query_instruction` on, its default).
    pooling: "cls" | "mean";
    dim: number;
    queryPrefix: string;
    documentPrefix: string;
    /// For the settings picker.
    label: string;
}

/** Keyed by the model id an index's manifest records. */
export const QUERY_MODELS: Readonly<Record<string, QueryModel>> = {
    "bge-small-en-v1.5": {
        repo: "Xenova/bge-small-en-v1.5",
        revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
        dtype: "fp32",
        space: "text",
        architecture: "encoder",
        subfolder: "onnx",
        // onnx/model.onnx 127 MB, tokenizer 0.7 MB, configs.
        downloadBytes: 134_000_000,
        pooling: "cls",
        dim: 384,
        queryPrefix: "Represent this sentence for searching relevant passages: ",
        documentPrefix: "",
        label: "bge-small-en-v1.5 — English, 134 MB",
    },
    "multilingual-e5-small": {
        repo: "intfloat/multilingual-e5-small",
        revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
        dtype: "fp32",
        space: "text",
        architecture: "encoder",
        subfolder: "onnx",
        // onnx/model.onnx 449 MB, tokenizer 17 MB: the vocabulary is what
        // makes it multilingual, and what makes it large.
        downloadBytes: 487_000_000,
        pooling: "mean",
        dim: 384,
        queryPrefix: "query: ",
        documentPrefix: "passage: ",
        label: "multilingual-e5-small — 100 languages, 487 MB",
    },
    // The image space's query tower: CLIP's text encoder, which lands a text
    // query among the vectors its vision encoder gave the images. The files
    // are fastembed's own (`Qdrant/clip-ViT-B-32-text`).
    "clip-vit-b-32": {
        repo: "Qdrant/clip-ViT-B-32-text",
        revision: "48ca1db27cb4063eb311ec2aa7f087a808112876",
        dtype: "fp32",
        space: "image",
        architecture: "clip-text",
        subfolder: "",
        // model.onnx 254 MB, tokenizer 2.2 MB, vocabulary and merges 1.4 MB.
        downloadBytes: 258_000_000,
        pooling: "mean",
        dim: 512,
        queryPrefix: "",
        documentPrefix: "",
        label: "clip-vit-b-32 — images, 258 MB",
    },
};

/** The models a fresh index can be built with: the text space's. */
export function textModels(): [string, QueryModel][] {
    return Object.entries(QUERY_MODELS).filter(([, model]) => model.space === "text");
}

/** The model to embed a query with, or null if the plugin cannot. */
export function queryModelFor(modelId: string): QueryModel | null {
    return QUERY_MODELS[modelId] ?? null;
}

/** The model a vault with no index yet is built with, unless the reader picks another. */
export const DEFAULT_BUILD_MODEL = "bge-small-en-v1.5";
