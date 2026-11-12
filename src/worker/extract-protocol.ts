//! The messages between the plugin and its PDF extraction worker.
//!
//! Shared by both sides so they are type-checked against one definition. The
//! worker is one-shot — the host starts one per file, posts its single request,
//! and gets exactly one `done` or `error` back with that id. There is no
//! `progress`: a single file either extracts or it does not.

/** A PDF file, as the bytes of the whole file. */
export interface ExtractRequest {
    id: number;
    type: "extract";
    bytes: Uint8Array;
}

export type Request = ExtractRequest;

/** The extraction: a title and per-page text, in document order. */
export interface Done {
    id: number;
    type: "done";
    /** Empty when the PDF has no metadata title; the host substitutes the file stem. */
    title: string;
    /** One per page, in document order, as `setPdfPages` wants them. */
    pages: { page: number; text: string }[];
}

export interface Failed {
    id: number;
    type: "error";
    message: string;
}

export type Response = Done | Failed;
