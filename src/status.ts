//! What the settings tab's index card says, decided apart from drawing it.
//!
//! One function from what the plugin knows — the manifest on disk, a build in
//! flight, a checkpoint left behind — to the state the card shows. Kept pure
//! so every state is testable without a DOM, and so the card can never show a
//! combination the plugin could not actually be in.

import { MANIFEST_NAME } from "./artifact.js";
import type { BuildProgress } from "./build/job.js";
import { statusLine } from "./build/plan.js";

/** The manifest, as far as the card reads it. Snake case: it is the file's own. */
interface ManifestView {
    created_unix: number;
    spaces: { space: string; model: { id: string; dim: number } }[];
    shards: { documents: number; chunks: number }[];
}

export type IndexState = "ready" | "building" | "paused" | "none" | "unreadable";

export interface IndexStatus {
    state: IndexState;
    /** The short label beside the dot. */
    label: string;
    /** One sentence under the numbers; empty when the numbers say it all. */
    detail: string;
    notes: number | null;
    chunks: number | null;
    /** When the live index was built, in milliseconds. */
    builtAt: number | null;
    /** The text space's model, as "id · 384d". */
    model: string | null;
    /** Who wrote the live index, when there is one. */
    writtenBy: "this device" | "another device or the gnosis CLI" | null;
    /** The one action the card offers. */
    action: "build" | "update" | "cancel" | "resume";
}

/** What the plugin knows, gathered by `GnosisPlugin.indexStatus`. */
export interface StatusInput {
    /** The manifest's JSON, null when there is none. */
    manifestJson: string | null;
    /** Why the manifest could not be read, when it exists but is not usable. */
    readError: string | null;
    /** Whether this device wrote that manifest. */
    writtenHere: boolean;
    /** The build in flight, if any; `null` progress before its first report. */
    building: { progress: BuildProgress | null } | null;
    /** A checkpoint an interrupted build left, as notes it already holds. */
    checkpointNotes: number | null;
    /** Markdown notes in the vault now, for "N of M". */
    vaultNotes: number;
}

function sum(manifest: ManifestView, field: "documents" | "chunks"): number {
    return manifest.shards.reduce((n, s) => n + s[field], 0);
}

export function indexStatus(input: StatusInput, artifactDir: string): IndexStatus {
    let manifest: ManifestView | null = null;
    let readError = input.readError;
    if (input.manifestJson !== null && readError === null) {
        try {
            manifest = JSON.parse(input.manifestJson) as ManifestView;
        } catch {
            readError = `${artifactDir}/${MANIFEST_NAME} is not valid JSON`;
        }
    }
    const text = manifest?.spaces.find((s) => s.space === "text") ?? null;
    const live = {
        notes: manifest === null ? null : sum(manifest, "documents"),
        chunks: manifest === null ? null : sum(manifest, "chunks"),
        builtAt: manifest === null ? null : manifest.created_unix * 1000,
        model: text === null ? null : `${text.model.id} · ${text.model.dim}d`,
        writtenBy:
            manifest === null
                ? null
                : input.writtenHere
                  ? ("this device" as const)
                  : ("another device or the gnosis CLI" as const),
    };

    if (input.building !== null) {
        const progress = input.building.progress;
        return {
            ...live,
            state: "building",
            label: "Indexing…",
            // The status bar's own line, minus its prefix: one wording for both.
            detail: progress === null ? "Reading the vault…" : statusLine(progress).replace(/^Gnosis: i/, "I"),
            action: "cancel",
        };
    }
    if (input.checkpointNotes !== null) {
        return {
            ...live,
            state: "paused",
            label: "Paused",
            detail:
                `${input.checkpointNotes.toLocaleString()} of ${input.vaultNotes.toLocaleString()} notes ` +
                `indexed. The rest are still queued; resume to finish. ` +
                (manifest === null
                    ? "Search needs a finished index."
                    : "Search uses the previous index until then."),
            action: "resume",
        };
    }
    if (readError !== null) {
        return {
            ...live,
            state: "unreadable",
            label: "Index unreadable",
            // Usually a sync still in progress: say so, verbatim, rather than
            // offering a rebuild as the first answer.
            detail: `${readError}. If another device is still syncing it, wait; otherwise rebuild it.`,
            action: "build",
        };
    }
    if (manifest === null) {
        return {
            ...live,
            state: "none",
            label: "No index",
            detail: `Nothing in ${artifactDir} yet. Build one here, or with the gnosis CLI.`,
            action: "build",
        };
    }
    return { ...live, state: "ready", label: "Ready", detail: "", action: "update" };
}

export type ModelState = "unsupported" | "absent" | "downloaded" | "loading" | "ready" | "failed";

export interface ModelStatus {
    state: ModelState;
    label: string;
    detail: string;
    /** "id · 384d", the model this vault's index uses or would be built with. */
    model: string;
    /** Whether there is anything on this device to delete, and it is safe to. */
    canDelete: boolean;
}

export interface ModelInput {
    modelId: string;
    dim: number;
    /** Whether the plugin can run this model at all. */
    supported: boolean;
    /** Bytes this device holds of it, model and runtime; null if unknown. */
    heldBytes: number | null;
    /** Whether the weights are among them. */
    complete: boolean;
    /** What a first use downloads, for "not downloaded yet". */
    downloadBytes: number;
    embedder: "loading" | "ready" | null;
    error: string | null;
    /** A build uses the model; deleting it mid-build is refused. */
    building: boolean;
}

function mb(bytes: number): string {
    return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

export function modelStatus(input: ModelInput): ModelStatus {
    const model = `${input.modelId} · ${input.dim}d`;
    const held = input.heldBytes ?? 0;
    const canDelete = held > 0 && input.embedder !== "loading" && !input.building;
    if (!input.supported) {
        return {
            state: "unsupported",
            label: "Not available here",
            detail:
                "This index was built with a model the plugin cannot run. Keyword search and " +
                "related notes still work.",
            model,
            canDelete,
        };
    }
    if (input.error !== null) {
        return { state: "failed", label: "Failed to load", detail: input.error, model, canDelete };
    }
    if (input.embedder === "loading") {
        return { state: "loading", label: "Loading…", detail: "Downloading or starting the model.", model, canDelete };
    }
    const where = `${mb(held)} on this device`;
    if (input.embedder === "ready") {
        return { state: "ready", label: "Loaded", detail: `${where} · in use`, model, canDelete };
    }
    if (input.complete) {
        return { state: "downloaded", label: "Downloaded", detail: where, model, canDelete };
    }
    return {
        state: "absent",
        label: "Not downloaded",
        detail: `${mb(input.downloadBytes)} on first use, after asking.` + (held > 0 ? ` ${mb(held)} partly downloaded.` : ""),
        model,
        canDelete,
    };
}
