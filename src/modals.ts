//! Search, as pickers: keywords alone, or blended with meaning.

import { Keymap, Notice, Platform, SuggestModal, getAllTags } from "obsidian";
import type { App, PaneType, TFile } from "obsidian";
import type { Hit } from "./types.js";
import { hitSnippet, hitSubtitle, isImage, metaLine, noteName, resolveHit, scoreLine, thumbnailSize } from "./results.js";

/** How results are shown and opened, read when a picker opens. */
export interface Display {
    /** Where Cmd/Ctrl opens a result; a plain choice always opens in place. */
    modOpen: PaneType;
    keyboardHints: boolean;
    showScores: boolean;
    /**
     * The keywords' share of the blend, for a keyword-only search, whose
     * scores are on that scale (see `scoreLine`); null where meaning is blended in.
     */
    keywordShare: number | null;
}

/** What choosing a result does: open it, or hand over a link to it. */
type Action = "open" | "insert" | "copy";

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

async function copyLink(link: string, file: TFile): Promise<void> {
    try {
        await navigator.clipboard.writeText(link);
        new Notice(`Gnosis: copied a link to ${file.basename}`);
    } catch {
        new Notice("Gnosis: could not copy to the clipboard");
    }
}

/** Shared rendering and opening, so every picker behaves identically. */
abstract class HitModal extends SuggestModal<Hit> {
    /** Set by a key just before it chooses the selected result. */
    private action: Action = "open";

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
        // The other actions choose the selected result too, saying how, so
        // they act on exactly what the reader sees highlighted.
        this.scope.register(["Shift"], "Enter", (evt) => {
            this.action = "insert";
            this.selectActiveSuggestion(evt);
            return false;
        });
        this.scope.register(["Mod", "Shift"], "c", (evt) => {
            this.action = "copy";
            this.selectActiveSuggestion(evt);
            return false;
        });
        if (display.keyboardHints) {
            const mod = Platform.isMacOS ? "⌘" : "Ctrl";
            this.setInstructions([
                { command: "↑↓", purpose: "to navigate" },
                { command: "↵", purpose: "to open" },
                { command: `${mod} ↵`, purpose: `to open in ${PANE_WORDS[display.modOpen]}` },
                { command: "⇧ ↵", purpose: "to insert a link" },
                { command: `${mod} ⇧ C`, purpose: "to copy a link" },
                { command: "esc", purpose: "to dismiss" },
            ]);
        }
    }

    /** The keywords' share of the blend if these results are keywords alone, else null. */
    protected keywordShare(): number | null {
        return this.display.keywordShare;
    }

    override renderSuggestion(hit: Hit, el: HTMLElement): void {
        const thumbnail = this.thumbnail(hit);
        if (thumbnail !== null) {
            el.addClass("gnosis-hit-has-thumb");
            el.appendChild(thumbnail);
        }
        el.createEl("div", { cls: "gnosis-hit-title", text: noteName(hit) });
        el.createEl("div", { cls: "gnosis-hit-detail", text: `› ${hitSubtitle(hit)}` });
        const snippet = hitSnippet(hit);
        if (snippet !== "") {
            el.createEl("div", { cls: "gnosis-hit-snippet", text: snippet });
        }
        const file = resolveHit(this.app, hit);
        if (file !== null) {
            const cache = this.app.metadataCache.getFileCache(file);
            const meta = metaLine(cache?.frontmatter?.["created"], file.stat.mtime, cache === null ? [] : getAllTags(cache) ?? []);
            if (meta !== "") {
                el.createEl("div", { cls: "gnosis-hit-meta", text: meta });
            }
        }
        if (this.display.showScores) {
            // The score as gnosis computed it — the same number at any rank —
            // rather than a share of the top hit, which reads 100% even for a
            // poor match; then what made it.
            el.createEl("div", { cls: "gnosis-hit-scores", text: scoreLine(hit, this.keywordShare()) });
        }
    }

    /** The image itself at a glance, from the vault's own file; null for a note. */
    private thumbnail(hit: Hit): HTMLElement | null {
        if (!isImage(hit)) {
            return null;
        }
        const file = resolveHit(this.app, hit);
        if (file === null) {
            return null;
        }
        const { width, height } = thumbnailSize(hit.width!, hit.height!);
        return createEl("img", {
            cls: "gnosis-hit-thumb",
            attr: {
                src: this.app.vault.getResourcePath(file),
                alt: noteName(hit),
                width: String(width),
                height: String(height),
                loading: "lazy",
            },
        });
    }

    override onChooseSuggestion(hit: Hit, evt?: MouseEvent | KeyboardEvent): void {
        const action = this.action;
        this.action = "open";
        const file = resolveHit(this.app, hit);
        if (file === null) {
            // The index knows a document the vault no longer has. Reporting it
            // is the honest answer: the plugin cannot re-index, and silently
            // doing nothing would look like a broken click.
            this.showMissing(hit);
            return;
        }
        if (action === "open") {
            void this.app.workspace.getLeaf(paneFor(evt, this.display.modOpen)).openFile(file);
            return;
        }
        // The link as Obsidian would write it, honoring the reader's wikilink
        // or Markdown setting and making a path relative to the open note.
        const editor = this.app.workspace.activeEditor;
        const link = this.app.fileManager.generateMarkdownLink(file, editor?.file?.path ?? "");
        if (action === "insert") {
            if (editor?.editor === undefined) {
                new Notice("Gnosis: open a note to insert a link into");
                return;
            }
            editor.editor.replaceSelection(link);
            return;
        }
        void copyLink(link, file);
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
    /** As answered: keywords alone while the model loads, then the blend. */
    private share: number | null = null;

    constructor(
        app: App,
        display: Display,
        /**
         * The results, and the keywords' share of the blend when they are
         * keywords alone (the model not yet loaded), else null.
         */
        private readonly runSearch: (query: string) => Promise<{ hits: Hit[]; keywordShare: number | null }>,
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
        const { hits, keywordShare } = await this.runSearch(query);
        if (ticket === this.ticket) {
            this.last = hits;
            this.share = keywordShare;
        }
        return hits;
    }

    protected override keywordShare(): number | null {
        return this.share;
    }

    protected override showMissing(hit: Hit): void {
        this.notify(`${hit.path} is in the index but not in the vault — run "Build index" to update it.`);
    }
}
