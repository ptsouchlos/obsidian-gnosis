//! A scope prefix, at the start of a query, says what kinds of documents it searches.

/** A query with its scope split off. */
export interface Scope {
    /** The kinds the query is limited to, as gnosis names them; empty means all. */
    kinds: string[];
    /** The query with the prefix stripped; unchanged when it had none. */
    rest: string;
}

/** The words a reader may type for a kind, case-insensitively. */
const KIND_WORDS: Record<string, string> = {
    txt: "markdown",
    md: "markdown",
    img: "image",
    image: "image",
    pdf: "pdf",
};

/** A scope, at the very start of the query, with or without a space after the colon. */
const SCOPE_AT_START = /^(txt|md|image|img|pdf):[ \t]*/i;

/**
 * Split a scope prefix off the start of a query.
 *
 * Only the start counts, so `todo: call Sam` and a colon mid-query stay
 * ordinary queries.
 */
export function parseScope(query: string): Scope {
    const match = SCOPE_AT_START.exec(query);
    const word = match === null ? undefined : match[1];
    const kind = word === undefined ? undefined : KIND_WORDS[word.toLowerCase()];
    if (kind === undefined || match === null) {
        return { kinds: [], rest: query };
    }
    return { kinds: [kind], rest: query.slice(match[0].length) };
}

/** What the picker's instruction line says the query searches; null for no scope. */
export function scopeLabel(kinds: string[]): string | null {
    if (kinds.length === 0) {
        return null;
    }
    const WORDS: Record<string, string> = { markdown: "notes", image: "images", pdf: "PDFs" };
    return kinds.map((kind) => WORDS[kind] ?? kind).join(" and ");
}
