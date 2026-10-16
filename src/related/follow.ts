//! What the related-notes panel shows, decided apart from drawing it.
//!
//! The panel follows the active note. The follower holds the two things that
//! are the panel's own — whether it is pinned to a note, and the answers it
//! already has — and asks the plugin for everything else. Kept free of the DOM
//! so following, pinning and caching are testable against the real index.

import type { Hit } from "../types.js";

/** Everything the panel can be showing. Each is said in words, never a blank panel. */
export type RelatedState =
    | { kind: "no-note" }
    | { kind: "loading"; path: string }
    | { kind: "no-index"; dir: string }
    | { kind: "unreadable"; message: string }
    /** The note is newer than the index: written or renamed since the last build. */
    | { kind: "stale"; path: string }
    | { kind: "empty"; path: string }
    | { kind: "ready"; path: string; hits: Hit[] };

/** Answers "what is related to this note", without raising notices. */
export type RelatedSource = (path: string) => Promise<RelatedState>;

export class RelatedFollower {
    /** While pinned, the active note changing does not change the panel. */
    pinned = false;
    /** The note the panel is about, or null with no note open. */
    path: string | null = null;
    private readonly cache = new Map<string, RelatedState>();
    /** Bumped per request, so a slow answer for an old note is dropped. */
    private ticket = 0;
    private started = false;

    constructor(private readonly source: RelatedSource) {}

    /**
     * The active note changed. Returns what to show, or null when the panel
     * should stay as it is: pinned, or already showing this note.
     */
    async follow(path: string | null): Promise<RelatedState | null> {
        // The first call always answers, even with no note: a panel opened
        // with nothing active still says so rather than staying blank.
        if (this.started && (this.pinned || path === this.path)) {
            return null;
        }
        this.started = true;
        this.path = path;
        return this.current();
    }

    /** What to show for the current note, from the cache when it can be. */
    async current(): Promise<RelatedState | null> {
        const path = this.path;
        if (path === null) {
            return { kind: "no-note" };
        }
        const cached = this.cache.get(path);
        if (cached !== undefined) {
            return cached;
        }
        const ticket = ++this.ticket;
        const state = await this.source(path);
        // A note's answer is fixed until the index or a setting changes, so
        // it is kept; a missing or unreadable index is not, since it can
        // appear at any moment.
        if (state.kind === "ready" || state.kind === "empty" || state.kind === "stale") {
            this.cache.set(path, state);
        }
        return ticket === this.ticket && path === this.path ? state : null;
    }

    /** Forget every answer: the index was rebuilt, or a setting changed what they would be. */
    invalidate(): void {
        this.cache.clear();
        this.ticket++;
    }
}
