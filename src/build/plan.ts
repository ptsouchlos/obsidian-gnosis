//! Deciding what a build makes, and what to tell the reader about it.
//!
//! Pure functions over manifests and progress, kept apart from the plugin so
//! the decisions are testable without a vault.

import { queryModelFor } from "../models.js";
import type { BuildProgress, BuildSpec } from "./job.js";

/** The parts of a manifest a build decision reads. Snake case: it is the file's own. */
interface ManifestView {
    created_unix: number;
    quantization: "f32" | "f16" | "i8";
    compression: "none" | "deflate";
    roots: string[];
    spaces: {
        space: string;
        model: { id: string; pooling: string; dim: number; query_prefix: string; document_prefix: string };
    }[];
    shards: { documents: number }[];
}

export type Planned = { spec: BuildSpec } | { refuse: string };

/**
 * Rebuild an existing index: the same model, pooling, prefixes, dimension,
 * quantization and compression it already has.
 *
 * Kept, not re-chosen, for two reasons. Reuse depends on it: the builder only
 * carries a note's vectors over from an artifact built the same way. And the
 * reader chose them, possibly with the CLI on another machine; a rebuild here
 * should not quietly change what their index is.
 */
export function specFromManifest(manifestJson: string, vaultName: string): Planned {
    const manifest = JSON.parse(manifestJson) as ManifestView;
    const text = manifest.spaces.find((s) => s.space === "text");
    if (text === undefined) {
        return { refuse: "the existing index has no text space to rebuild" };
    }
    const { id, pooling, dim, query_prefix, document_prefix } = text.model;
    if (queryModelFor(id) === null) {
        return {
            refuse:
                `the existing index was built with '${id}', which this plugin cannot run — ` +
                `rebuild it with the gnosis CLI, or delete it to build a new one here`,
        };
    }
    if (pooling !== "cls" && pooling !== "mean") {
        return { refuse: `the existing index records pooling '${pooling}', which this plugin does not know` };
    }
    return {
        spec: {
            model: id,
            pooling,
            dim,
            queryPrefix: query_prefix,
            documentPrefix: document_prefix,
            root: vaultName,
            quantization: manifest.quantization,
            compression: manifest.compression,
        },
    };
}

/** A first index for this vault, with the model the reader picked. */
export function specForNewIndex(modelId: string, vaultName: string): Planned {
    const model = queryModelFor(modelId);
    if (model === null) {
        return { refuse: `'${modelId}' is not a model this plugin can build with` };
    }
    return {
        spec: {
            model: modelId,
            pooling: model.pooling,
            dim: model.dim,
            queryPrefix: model.queryPrefix,
            documentPrefix: model.documentPrefix,
            root: vaultName,
        },
    };
}

/**
 * What replacing an index this device did not write would cost, in lines.
 *
 * The plugin builds the text space of one vault. An index from the CLI can
 * hold more — images, other folders — and a rebuild here would drop them, so
 * the reader is told before agreeing rather than discovering it after.
 */
export function replaceWarning(manifestJson: string, vaultName: string): string[] {
    const manifest = JSON.parse(manifestJson) as ManifestView;
    const documents = manifest.shards.reduce((n, s) => n + s.documents, 0);
    const text = manifest.spaces.find((s) => s.space === "text");
    const built = new Date(manifest.created_unix * 1000).toLocaleString();
    const lines = [
        `The index in this vault was written by another device or by the gnosis CLI, not by ` +
            `this device: ${documents.toLocaleString()} documents, ${text?.model.id ?? "no text model"}, ` +
            `built ${built}.`,
        "Building here replaces it with one built on this device. Unchanged notes are carried " +
            "over rather than re-embedded.",
    ];
    if (manifest.spaces.some((s) => s.space === "image")) {
        lines.push(
            "It also searches images, which the plugin cannot index yet — the rebuilt index will " +
                "not include them. The gnosis CLI can add them back.",
        );
    }
    if (manifest.roots.length !== 1 || manifest.roots[0] !== vaultName) {
        lines.push(
            `It covers ${manifest.roots.map((r) => `'${r}'`).join(", ")}; the rebuilt index will ` +
                `cover this whole vault, '${vaultName}', instead.`,
        );
    }
    return lines;
}

/** A rough minutes-left figure, once there is enough history to make one. */
function estimate(progress: BuildProgress): string {
    const embeddedNotes = progress.notesDone - progress.notesReused;
    if (progress.elapsedMs < 20_000 || embeddedNotes < 5 || progress.chunksEmbedded === 0) {
        return "";
    }
    const chunksPerNote = progress.chunksEmbedded / embeddedNotes;
    const chunksPerMs = progress.chunksEmbedded / progress.elapsedMs;
    const remainingMs = ((progress.notesTotal - progress.notesDone) * chunksPerNote) / chunksPerMs;
    const minutes = Math.ceil(remainingMs / 60_000);
    // An upper bound: notes still ahead that turn out unchanged cost nothing.
    return minutes <= 1 ? " · under a minute left" : ` · ~${minutes} min left`;
}

/** The status bar while a build runs. */
export function statusLine(progress: BuildProgress): string {
    return (
        `Gnosis: indexing ${progress.notesDone.toLocaleString()}/${progress.notesTotal.toLocaleString()} notes` +
        ` · ${progress.chunksEmbedded.toLocaleString()} chunks embedded${estimate(progress)}`
    );
}
