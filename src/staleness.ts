//! How far the index has fallen behind the vault.
//!
//! gnosis's `Index.staleness` does the comparison; this decides what to send
//! it. An mtime alone is wrong in two ways that never go away: a syncer or
//! another plugin rewriting a note unchanged moves its mtime, and a rebuild
//! that reuses an unchanged note keeps the note's *old* mtime. Such a note
//! would read as changed forever. So mtimes only narrow the field, and the
//! notes they flag are hashed — with gnosis's own hash, the one the index
//! recorded — for the answer.

import type { Note } from "./build/job.js";

/** The notes a build would add, update and remove. */
export interface Staleness {
    changed: string[];
    added: string[];
    removed: string[];
    /** How many notes were read and hashed to decide. */
    hashed: number;
    elapsedMs: number;
}

interface Report {
    changed: string[];
    added: string[];
    removed: string[];
}

/** What `Index.staleness` needs; the real `Index` has it. */
export interface StalenessSource {
    staleness(entries: unknown): unknown;
}

/**
 * Compare `notes` — the notes a build would include — with the index.
 *
 * `removed` is limited to notes: the gnosis CLI also indexes images and
 * PDFs, which no build here sends, and they would otherwise all read as
 * removed.
 */
export async function vaultStaleness(
    index: StalenessSource,
    notes: Note[],
    hash: (text: string) => string,
    now: () => number = () => Date.now(),
): Promise<Staleness> {
    const startedAt = now();
    // The artifact records seconds, floored, as `Builder.addDocument` stores them.
    const byMtime = index.staleness(
        notes.map((note) => ({ path: note.path, mtime: Math.floor(note.mtime / 1000) })),
    ) as Report;

    // An edit always moves the mtime forward, so only these can have changed.
    const suspects = new Set(byMtime.changed);
    const entries: { path: string; hash: string }[] = [];
    for (const note of notes) {
        if (suspects.has(note.path)) {
            entries.push({ path: note.path, hash: hash(await note.read()) });
        }
    }
    // Asked about these alone, so only its `changed` means anything: every
    // other indexed note would read as removed.
    const changed = entries.length === 0 ? [] : (index.staleness(entries) as Report).changed;

    return {
        changed,
        added: byMtime.added,
        removed: byMtime.removed.filter((path) => path.endsWith(".md")),
        hashed: entries.length,
        elapsedMs: now() - startedAt,
    };
}

function count(n: number, noun: string): string {
    return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

/** One line for the index card and "Show index info". */
export function stalenessLine(s: Staleness): string {
    const parts: string[] = [];
    if (s.changed.length > 0) {
        parts.push(`${count(s.changed.length, "note")} changed`);
    }
    if (s.added.length > 0) {
        parts.push(parts.length === 0 ? `${count(s.added.length, "new note")}` : `${s.added.length.toLocaleString()} new`);
    }
    if (s.removed.length > 0) {
        parts.push(
            parts.length === 0
                ? `${count(s.removed.length, "note")} deleted`
                : `${s.removed.length.toLocaleString()} deleted`,
        );
    }
    return parts.length === 0
        ? "Up to date with your notes."
        : `${parts.join(", ")} since the last update.`;
}
