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

const percent = (x: number) => `${Math.round(Math.min(Math.max(x, 0), 1) * 100)}%`;
const two = (x: number) => x.toFixed(2);

/**
 * What a hit's score is made of, in one line.
 *
 * With meaning in the blend: "Match 83% · meaning 0.65 · keywords 0.08 ·
 * title +0.10", the parts adding up to the match. A note lifted for being
 * recent also says "recent +0.04". Keywords alone are a
 * different scale: the blend still weighs them by their share (0.1 at
 * Balanced), so a perfect keyword match would read "Match 3%". There,
 * `keywordShare` undoes the weight and the line says how well the keywords
 * matched against their own ceiling.
 */
export function scoreLine(hit: Hit, keywordShare: number | null): string {
    const { meaning, keywords, title, recency } = hit.parts;
    const bonus = `title +${two(title)}` + (recency > 0 ? ` · recent +${two(recency)}` : "");
    if (keywordShare !== null && keywordShare > 0) {
        return `Keywords ${percent(keywords / keywordShare)} · ${bonus}`;
    }
    return `Match ${percent(hit.score)} · meaning ${two(meaning)} · keywords ${two(keywords)} · ${bonus}`;
}

/**
 * What a related note's score says, in the search box's style: "82% similar".
 * A related score is the mean of the two notes' best chunk-to-chunk
 * similarities, so it has no keyword or title part to break out.
 */
export function relatedLine(hit: Hit, linked: boolean): string {
    const line = `${percent(hit.score)} similar`;
    return linked ? `${line} · linked` : line;
}

/**
 * The paths a note shares a link with, either way: those it links to and
 * those that link to it. `resolvedLinks` is Obsidian's map of source path to
 * the paths it links to.
 */
export function linkedPaths(resolvedLinks: Record<string, Record<string, number>>, path: string): Set<string> {
    const linked = new Set(Object.keys(resolvedLinks[path] ?? {}));
    for (const [source, targets] of Object.entries(resolvedLinks)) {
        if (path in targets) {
            linked.add(source);
        }
    }
    return linked;
}

/**
 * The note's date and tags, for the line under a snippet: "created
 * 2026-03-16 · #time/meeting". Empty when there is neither.
 *
 * `created` is the frontmatter property if the note has one, else its
 * modified time: a date the reader recognizes either way, and named for what
 * it is.
 */
export function metaLine(created: unknown, mtime: number | null, tags: readonly string[]): string {
    const parts: string[] = [];
    const date = typeof created === "string" && created.trim() !== "" ? created.trim().slice(0, 10) : null;
    if (date !== null) {
        parts.push(`created ${date}`);
    } else if (mtime !== null) {
        const d = new Date(mtime);
        const pad = (n: number) => String(n).padStart(2, "0");
        parts.push(`modified ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    }
    // A few, unique, in the note's own order: a line, not a tag cloud.
    parts.push(...[...new Set(tags)].slice(0, 4));
    return parts.join(" · ");
}

/**
 * Whether a hit is an image, by its file extension.
 *
 * Not by `width` and `height`: an exported artifact does not carry them, so
 * they are null for every hit it returns, images included.
 */
export function isImage(hit: Hit): boolean {
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(hit.path);
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
