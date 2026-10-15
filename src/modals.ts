//! The two model-free tiers, as pickers.

import { SuggestModal } from "obsidian";
import type { App, TFile } from "obsidian";
import type { Hit } from "./types.js";
import { hitSnippet, hitSubtitle, resolveHit } from "./results.js";

/** Shared rendering and opening, so both pickers behave identically. */
abstract class HitModal extends SuggestModal<Hit> {
    protected constructor(app: App) {
        super(app);
    }

    override renderSuggestion(hit: Hit, el: HTMLElement): void {
        el.createEl("div", { cls: "gnosis-hit-title", text: hit.title });
        el.createEl("div", { cls: "gnosis-hit-detail", text: hitSubtitle(hit) });
        const snippet = hitSnippet(hit);
        if (snippet !== "") {
            el.createEl("div", { cls: "gnosis-hit-snippet", text: snippet });
        }
    }

    override onChooseSuggestion(hit: Hit): void {
        const file = resolveHit(this.app, hit);
        if (file === null) {
            // The index knows a document the vault no longer has. Reporting it
            // is the honest answer: the plugin cannot re-index, and silently
            // doing nothing would look like a broken click.
            this.showMissing(hit);
            return;
        }
        void this.app.workspace.getLeaf(false).openFile(file);
    }

    protected abstract showMissing(hit: Hit): void;
}

/** Lexical search: BM25+ over the artifact's text, no model, no download. */
export class LexicalSearchModal extends HitModal {
    constructor(
        app: App,
        private readonly runSearch: (query: string) => Hit[],
        private readonly notify: (message: string) => void,
    ) {
        super(app);
        this.setPlaceholder("Search your vault with gnosis…");
        this.emptyStateText = "No matches.";
    }

    override getSuggestions(query: string): Hit[] {
        // Nothing to rank for an empty query, and asking would return an
        // arbitrary slice of the corpus.
        return query.trim() === "" ? [] : this.runSearch(query);
    }

    protected override showMissing(hit: Hit): void {
        this.notify(`${hit.path} is in the index but not in the vault — re-run \`gnosis export\`.`);
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
        file: TFile,
        private readonly hits: Hit[],
        private readonly notify: (message: string) => void,
    ) {
        super(app);
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
                hit.title.toLowerCase().includes(needle) ||
                hit.path.toLowerCase().includes(needle),
        );
    }

    protected override showMissing(hit: Hit): void {
        this.notify(`${hit.path} is in the index but not in the vault — re-run \`gnosis export\`.`);
    }
}
