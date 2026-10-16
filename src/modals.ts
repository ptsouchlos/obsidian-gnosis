//! The two model-free tiers, as pickers.

import { Keymap, Platform, SuggestModal } from "obsidian";
import type { App, PaneType, TFile } from "obsidian";
import type { Hit } from "./types.js";
import { formatScore, hitSnippet, hitSubtitle, noteName, resolveHit } from "./results.js";

/** How results are shown and opened, read when a picker opens. */
export interface Display {
    /** Where Cmd/Ctrl opens a result; a plain choice always opens in place. */
    modOpen: PaneType;
    keyboardHints: boolean;
    showScores: boolean;
}

/**
 * Where a chosen result opens.
 *
 * A plain click or Enter replaces the current tab. Cmd/Ctrl (or a middle
 * click) goes where the reader chose; Obsidian's own Cmd/Ctrl+Alt (split) and
 * Cmd/Ctrl+Alt+Shift (window) keep their usual meaning.
 */
export function paneFor(evt: MouseEvent | KeyboardEvent | undefined, modOpen: PaneType): PaneType | false {
    const mod = Keymap.isModEvent(evt);
    if (mod === false) {
        return false;
    }
    return mod === "tab" || mod === true ? modOpen : mod;
}

const PANE_WORDS: Record<PaneType, string> = { tab: "a new tab", split: "a new split", window: "a new window" };

/** Shared rendering and opening, so every picker behaves identically. */
abstract class HitModal extends SuggestModal<Hit> {
    protected constructor(
        app: App,
        protected readonly display: Display,
    ) {
        super(app);
        // Enter is the modal's own; Cmd/Ctrl+Enter has to be asked for.
        this.scope.register(["Mod"], "Enter", (evt) => {
            this.selectActiveSuggestion(evt);
            return false;
        });
        if (display.keyboardHints) {
            this.setInstructions([
                { command: "↑↓", purpose: "to navigate" },
                { command: "↵", purpose: "to open" },
                { command: `${Platform.isMacOS ? "⌘" : "Ctrl"} ↵`, purpose: `to open in ${PANE_WORDS[display.modOpen]}` },
                { command: "esc", purpose: "to dismiss" },
            ]);
        }
    }

    override renderSuggestion(hit: Hit, el: HTMLElement): void {
        if (this.display.showScores) {
            // The score as gnosis computed it — the same number at any rank —
            // rather than a percentage of the top hit, which reads 100% even
            // for a poor match.
            el.createEl("span", { cls: "gnosis-hit-score", text: formatScore(hit.score) });
        }
        el.createEl("div", { cls: "gnosis-hit-title", text: noteName(hit) });
        el.createEl("div", { cls: "gnosis-hit-detail", text: hitSubtitle(hit) });
        const snippet = hitSnippet(hit);
        if (snippet !== "") {
            el.createEl("div", { cls: "gnosis-hit-snippet", text: snippet });
        }
    }

    override onChooseSuggestion(hit: Hit, evt?: MouseEvent | KeyboardEvent): void {
        const file = resolveHit(this.app, hit);
        if (file === null) {
            // The index knows a document the vault no longer has. Reporting it
            // is the honest answer: the plugin cannot re-index, and silently
            // doing nothing would look like a broken click.
            this.showMissing(hit);
            return;
        }
        void this.app.workspace.getLeaf(paneFor(evt, this.display.modOpen)).openFile(file);
    }

    protected abstract showMissing(hit: Hit): void;
}

/** Lexical search: BM25+ over the artifact's text, no model, no download. */
export class LexicalSearchModal extends HitModal {
    constructor(
        app: App,
        display: Display,
        private readonly runSearch: (query: string) => Hit[],
        private readonly notify: (message: string) => void,
    ) {
        super(app, display);
        this.setPlaceholder("Search your vault with Gnosis…");
        this.emptyStateText = "No matches.";
    }

    override getSuggestions(query: string): Hit[] {
        // Nothing to rank for an empty query, and asking would return an
        // arbitrary slice of the corpus.
        return query.trim() === "" ? [] : this.runSearch(query);
    }

    protected override showMissing(hit: Hit): void {
        this.notify(`${hit.path} is in the index but not in the vault — run "Build index" to update it.`);
    }
}

/**
 * Related notes for one file: the other model-free tier, and the one at full
 * quality, since both sides of the comparison are vectors the artifact
 * already carries.
 */
export class RelatedModal extends HitModal {
    constructor(
        app: App,
        display: Display,
        file: TFile,
        private readonly hits: Hit[],
        private readonly notify: (message: string) => void,
    ) {
        super(app, display);
        this.setPlaceholder(`Related to ${file.basename}`);
        this.emptyStateText = "Nothing related found.";
    }

    override getSuggestions(query: string): Hit[] {
        const needle = query.trim().toLowerCase();
        if (needle === "") {
            return this.hits;
        }
        // Filtering, not re-ranking: the ranking came from the vectors, and
        // typing here narrows what is already ranked.
        return this.hits.filter(
            (hit) =>
                noteName(hit).toLowerCase().includes(needle) ||
                hit.path.toLowerCase().includes(needle),
        );
    }

    protected override showMissing(hit: Hit): void {
        this.notify(`${hit.path} is in the index but not in the vault — run "Build index" to update it.`);
    }
}

/**
 * Hybrid search: the query embedded with the index's own model and fused with
 * the lexical channel, by the same code and weights as the CLI.
 *
 * Until the model is ready — the first time, that is a download — it answers
 * lexically and says so, rather than making the reader wait for a picker.
 */
export class SemanticSearchModal extends HitModal {
    /** Bumped per keystroke, so a slow answer to an old query is dropped. */
    private ticket = 0;
    private last: Hit[] = [];

    constructor(
        app: App,
        display: Display,
        private readonly runSearch: (query: string) => Promise<Hit[]>,
        semantic: boolean,
        private readonly notify: (message: string) => void,
        private readonly debounceMs = 150,
    ) {
        super(app, display);
        this.setPlaceholder(
            semantic
                ? "Search your vault by meaning with Gnosis…"
                : "Search your vault with Gnosis (keywords while the model loads)…",
        );
        this.emptyStateText = "No matches.";
    }

    override async getSuggestions(query: string): Promise<Hit[]> {
        const ticket = ++this.ticket;
        if (query.trim() === "") {
            return [];
        }
        // Embedding is the slow part of a query, so wait for typing to pause
        // rather than embed every prefix of a word.
        await new Promise((resolve) => setTimeout(resolve, this.debounceMs));
        if (ticket !== this.ticket) {
            return this.last;
        }
        const hits = await this.runSearch(query);
        if (ticket === this.ticket) {
            this.last = hits;
        }
        return hits;
    }

    protected override showMissing(hit: Hit): void {
        this.notify(`${hit.path} is in the index but not in the vault — run "Build index" to update it.`);
    }
}
