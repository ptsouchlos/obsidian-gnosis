//! The messages between the plugin and its embedding worker.
//!
//! Shared by both sides so they are type-checked against one definition. Every
//! request carries an id and gets exactly one `done` or `error` back with that
//! id; `progress` may arrive any number of times before it.

/** The ONNX Runtime WebAssembly binary, pinned by hash. */
export interface RuntimeSpec {
    url: string;
    sha256: string;
}

export interface LoadRequest {
    id: number;
    type: "load";
    repo: string;
    revision: string;
    dtype: "fp32";
    /** "onnx" or "": where the ONNX file sits in the repository. */
    subfolder: string;
    /** "clip-text" loads CLIP's text tower and projects; "encoder" pools a sentence encoder. */
    architecture: "encoder" | "clip-text" | "clip-vision";
    pooling: "cls" | "mean";
    runtime: RuntimeSpec;
    /** Where the model runs. "webgpu" only in the GPU worker, with its runtime. */
    device: Device;
    /** CPU threads; more than one only in the CPU worker. */
    threads: number;
}

/** transformers.js's names: the CPU through WebAssembly, or the GPU. */
export type Device = "wasm" | "webgpu";

export interface EmbedRequest {
    id: number;
    type: "embed";
    texts: string[];
}

/** Images to embed with the vision tower, as the bytes of their files. */
export interface EmbedImagesRequest {
    id: number;
    type: "embedImages";
    images: Uint8Array[];
}

export type Request = LoadRequest | EmbedRequest | EmbedImagesRequest;

/** Bytes downloaded so far, across the runtime and every model file. */
export interface Progress {
    id: number;
    type: "progress";
    file: string;
    loaded: number;
    total: number;
}

export interface Done {
    id: number;
    type: "done";
    /** Flat, `texts.length * dim` floats, for an `embed` request. */
    vectors?: Float32Array;
    dim?: number;
    /**
     * For `embedImages`: the files that would not decode, by position. Their
     * vectors are zeros, and they are not worth retrying: it is the file.
     */
    failed?: { index: number; message: string }[];
}

export interface Failed {
    id: number;
    type: "error";
    message: string;
}

export type Response = Progress | Done | Failed;
