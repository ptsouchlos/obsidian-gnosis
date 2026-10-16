//! Turning a hit into something Obsidian can open.

import type { App, TFile } from "obsidian";
import type { Hit } from "./types.js";

/**
 * Find the vault file a hit refers to.
 *
 * An artifact stores vault-relative paths, so usually this is a direct lookup.
 * The exception is an index built over a *subfolder* of the vault: the CLI then
 * records paths relative to that root and the root's own label beside them, so
 * the file sits one level further down than the path says. Trying the labelled
 * prefix second covers that without making the common case slower.
 */
export function resolveHit(app: App, hit: Hit): TFile | null {
    const direct = app.vault.getFileByPath(hit.path);
    if (direct) {
        return direct;
    }
    if (hit.source_root !== "") {
        return app.vault.getFileByPath(`${hit.source_root}/${hit.path}`);
    }
    return null;
}

/**
 * The name a hit is shown under: the note's file name, as Obsidian names a
 * note everywhere else.
 *
 * Not gnosis's `title`, which prefers frontmatter `title:` and then the first
 * H1. Many vaults open every note with the same heading ("# Notes"), which
 * would list every result under one name.
 */
export function noteName(hit: Hit): string {
    const file = hit.path.split("/").pop() ?? hit.path;
    return file.replace(/\.md$/, "");
}

/** A one-line locator for a hit: its heading trail, or its folder. */
export function hitSubtitle(hit: Hit): string {
    if (hit.heading_path !== "") {
        return hit.heading_path;
    }
    const folder = hit.path.split("/").slice(0, -1).join("/");
    return folder === "" ? hit.path : folder;
}

/** A short snippet of a hit's text, collapsed onto one line. */
export function hitSnippet(hit: Hit, limit = 160): string {
    const flat = hit.text.replace(/\s+/g, " ").trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * A score, to two significant figures.
 *
 * Not to two decimals: with no model, search is keywords alone, and gnosis
 * still scales them by the blend's keyword share, so a whole result list can
 * sit between 0.026 and 0.032 — identical at two decimals, distinct here.
 */
export function formatScore(score: number): string {
    return score >= 1 ? score.toFixed(2) : score.toPrecision(2);
}
