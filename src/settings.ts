//! Settings, grouped the way a reader looks for them: the index first, then
//! how search ranks, then the model. The index card at the top is the one
//! place that says what the index is doing right now.

import { PluginSettingTab, Setting, setIcon } from "obsidian";
import type { App, PaneType } from "obsidian";
import type GnosisPlugin from "./main.js";
import { DEFAULT_BUILD_MODEL, QUERY_MODELS } from "./models.js";
import type { Strategy, TitleBonus } from "./ranking.js";
import type { IndexStatus, ModelStatus } from "./status.js";
import { segmented } from "./ui/segmented.js";

export interface GnosisSettings {
    /**
     * Where the artifact lives, vault-relative.
     *
     * Defaults beside the CLI's own index, which already writes `.gnosis/` into
     * the vault it indexes, so `gnosis export --out .gnosis/artifact` needs no
     * explanation of where to put things. A dot-folder also keeps the shards
     * out of the file explorer and out of search results, which matters because
     * they are derived data the reader never edits.
     */
    artifactDir: string;
    /** How many results to show. */
    limit: number;
    /**
     * Embed queries with the index's model, for hybrid search.
     *
     * Off until the reader turns it on, because turning it on downloads the
     * model — and that is the reader's decision, made with the size and the
     * source in front of them, not a default.
     */
    semanticSearch: boolean;
    /**
     * The model "Build index" uses for a vault with no index yet. An existing
     * index is always rebuilt with its own model, whatever this says.
     */
    buildModel: string;
    /** How meaning and keywords are weighed; see `ranking.ts`. */
    strategy: Strategy;
    /** How much a note's title counts; see `ranking.ts`. */
    titleBonus: TitleBonus;
    /** Where Cmd/Ctrl opens a result. A plain choice opens in the current tab. */
    modOpen: PaneType;
    /** The key hints under a picker's results. */
    keyboardHints: boolean;
    /** Each result's score beside its title. */
    showScores: boolean;
}

export const DEFAULT_SETTINGS: GnosisSettings = {
    artifactDir: ".gnosis/artifact",
    limit: 20,
    semanticSearch: false,
    buildModel: DEFAULT_BUILD_MODEL,
    strategy: "balanced",
    titleBonus: "default",
    modOpen: "tab",
    keyboardHints: true,
    showScores: false,
};

/** Where the footer's links go. */
const REPO_URL = "https://github.com/ptsouchlos/obsidian-gnosis";

const ACTION_LABELS: Record<IndexStatus["action"], string> = {
    build: "Build index",
    update: "Update index",
    cancel: "Cancel",
    resume: "Resume",
};

export class GnosisSettingTab extends PluginSettingTab {
    /** Stops listening for index changes; set while the tab is shown. */
    private unsubscribe: (() => void) | null = null;
    /** Bumped per refresh, so a slow read never overwrites a newer one. */
    private ticket = 0;
    private modelTicket = 0;

    constructor(
        app: App,
        private readonly plugin: GnosisPlugin,
    ) {
        super(app, plugin);
    }

    override display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass("gnosis-settings");

        this.heading(containerEl, "Index");
        const card = containerEl.createDiv({ cls: "gnosis-card gnosis-index-card" });
        // Filled in below; `refresh` redraws both cards whenever the plugin
        // says the index or the model may have changed.
        let modelCard: HTMLElement | null = null;
        const refresh = (progressOnly = false) => {
            const ticket = ++this.ticket;
            void this.plugin.indexStatus().then((index) => {
                if (ticket === this.ticket) {
                    this.renderIndexCard(card, index);
                }
            });
            // A build's progress tick changes only the index card's numbers;
            // the model card reads Cache Storage, which is not worth redoing
            // every batch.
            if (!progressOnly) {
                const modelTicket = ++this.modelTicket;
                void this.plugin.modelStatus().then((model) => {
                    if (modelTicket === this.modelTicket && modelCard !== null) {
                        this.renderModelCard(modelCard, model);
                    }
                });
            }
        };

        containerEl.createEl("p", {
            cls: "gnosis-note",
            text:
                "Building the index embeds every note, which is desktop-only. On a phone or " +
                "tablet, build on a computer and let your sync bring the finished index over.",
        });

        const advanced = containerEl.createEl("details", { cls: "gnosis-advanced" });
        advanced.createEl("summary", { text: "Advanced" });

        this.card(new Setting(advanced))
            .setName("Index folder")
            .setDesc(
                "Vault-relative folder holding the index: a manifest.json and its shards. " +
                    "The gnosis CLI writes it with `gnosis export --out <folder>`.",
            )
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_SETTINGS.artifactDir)
                    .setValue(this.plugin.settings.artifactDir)
                    .onChange(async (value) => {
                        this.plugin.settings.artifactDir = value.trim();
                        await this.plugin.saveSettings();
                        // The loaded index came from the old folder, so it is
                        // no longer what this setting describes.
                        this.plugin.closeIndex();
                        refresh();
                    }),
            );

        this.card(new Setting(advanced))
            .setName("Model for new indexes")
            .setDesc(
                "What \"Build index\" embeds with when this vault has no index yet. An existing " +
                    "index keeps its own model; to switch, delete it and build again.",
            )
            .addDropdown((dropdown) => {
                for (const [id, model] of Object.entries(QUERY_MODELS)) {
                    dropdown.addOption(id, model.label);
                }
                dropdown.setValue(this.plugin.settings.buildModel).onChange(async (value) => {
                    this.plugin.settings.buildModel = value;
                    await this.plugin.saveSettings();
                });
            });

        this.heading(containerEl, "Search");

        containerEl.createEl("p", {
            cls: "gnosis-note",
            text:
                "Gnosis ranks each note by meaning and by keywords, blends the two, and gives a " +
                "small bonus to notes whose title matches. The defaults are the measured ones; " +
                "change them only if your searches say so.",
        });
        const pipeline = containerEl.createDiv({ cls: "gnosis-card gnosis-pipeline" });

        const strategy = this.card(new Setting(containerEl)).setName("Search strategy");
        const strategyControl = segmented<Strategy>(
            strategy.controlEl,
            "Search strategy",
            [
                { value: "balanced", label: "Balanced" },
                { value: "keyword", label: "Keyword focused" },
            ],
            this.plugin.settings.strategy,
            async (value) => {
                this.plugin.settings.strategy = value;
                await this.saveRanking();
                drawSearch();
            },
        );

        const titleBonus = this.card(new Setting(containerEl))
            .setName("Title bonus")
            .setDesc(
                "Lifts a note whose title carries the words you searched for, so the note about a " +
                    "topic outranks notes that only mention it.",
            );
        segmented<TitleBonus>(
            titleBonus.controlEl,
            "Title bonus",
            [
                { value: "off", label: "Off" },
                { value: "default", label: "On" },
            ],
            this.plugin.settings.titleBonus,
            async (value) => {
                this.plugin.settings.titleBonus = value;
                await this.saveRanking();
                drawSearch();
            },
        );

        this.card(new Setting(containerEl))
            .setName("Results")
            .setDesc("How many results each search shows.")
            .addSlider((slider) =>
                slider
                    .setLimits(5, 50, 5)
                    .setValue(this.plugin.settings.limit)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.limit = value;
                        await this.plugin.saveSettings();
                    }),
            );
        containerEl.createEl("p", { cls: "gnosis-note", text: "Changes apply to your next search." });

        /** The parts of the Search section that depend on other settings. */
        const drawSearch = () => {
            const semantic = this.plugin.settings.semanticSearch;
            this.renderPipeline(pipeline, semantic);
            // With no model there is nothing to blend: keywords are all there is.
            strategyControl.setDisabled(!semantic);
            strategy.setDesc(
                semantic
                    ? "Balanced suits nearly every vault. Keyword focused trusts exact words more " +
                          "than meaning: try it if searches for exact terms rank the wrong notes " +
                          "first, or if your notes are not in the model's language (there, turning " +
                          "semantic search off can do better still)."
                    : "Turn on semantic search (below) to blend meaning with keywords; until then " +
                          "search is by keywords alone.",
            );
        };
        drawSearch();

        this.heading(containerEl, "Display");

        const modOpen = this.card(new Setting(containerEl))
            .setName("Open results with Cmd/Ctrl in")
            .setDesc(
                "Where a result opens when you hold Cmd/Ctrl while clicking or pressing Enter. A " +
                    "plain click or Enter always opens it in the current tab.",
            );
        segmented<PaneType>(
            modOpen.controlEl,
            "Open results with Cmd/Ctrl in",
            [
                { value: "tab", label: "New tab" },
                { value: "split", label: "New split" },
                { value: "window", label: "New window" },
            ],
            this.plugin.settings.modOpen,
            async (value) => {
                this.plugin.settings.modOpen = value;
                await this.plugin.saveSettings();
            },
        );

        this.card(new Setting(containerEl))
            .setName("Keyboard hints")
            .setDesc("Show the keys for navigating and opening results under the search box.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.keyboardHints).onChange(async (on) => {
                    this.plugin.settings.keyboardHints = on;
                    await this.plugin.saveSettings();
                }),
            );

        this.card(new Setting(containerEl))
            .setName("Show scores")
            .setDesc(
                "Show each result's score beside its title. Higher is a closer match; for related " +
                    "notes it is how similar the two notes are.",
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.showScores).onChange(async (on) => {
                    this.plugin.settings.showScores = on;
                    await this.plugin.saveSettings();
                }),
            );

        this.heading(containerEl, "Model");
        modelCard = containerEl.createDiv({ cls: "gnosis-card gnosis-model-card" });

        this.card(new Setting(containerEl))
            .setName("Semantic search")
            .setDesc(
                "Search by meaning as well as by keyword, with the model your index was built " +
                    "with. Downloads the model once; queries and notes stay on this device.",
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.semanticSearch).onChange(async (on) => {
                    if (!on) {
                        await this.plugin.disableSemanticSearch();
                    } else if (!(await this.plugin.enableSemanticSearch())) {
                        // Turning it on asks first; a refusal puts the toggle back.
                        toggle.setValue(false);
                    }
                    drawSearch();
                }),
            );

        this.card(new Setting(containerEl))
            .setName("Runs on")
            .setDesc(
                "The CPU, through WebAssembly, on this device. Graphics-card acceleration " +
                    "(WebGPU) is not supported yet.",
            );

        this.footer(containerEl);

        this.unsubscribe?.();
        this.unsubscribe = this.plugin.onStatusChange(refresh);
        refresh();
    }

    override hide(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.ticket++;
        this.modelTicket++;
    }

    private async saveRanking(): Promise<void> {
        await this.plugin.saveSettings();
        this.plugin.applySearchConfig();
    }

    /** Notes → meaning + keywords → blend → title bonus → results. */
    private renderPipeline(el: HTMLElement, semantic: boolean): void {
        el.empty();
        const settings = this.plugin.settings;
        const step = (parent: HTMLElement, text: string, off = false, sub?: string) => {
            const box = parent.createDiv({ cls: "gnosis-step" });
            box.toggleClass("is-off", off);
            box.createDiv({ text });
            if (sub !== undefined) {
                box.createDiv({ cls: "gnosis-step-sub", text: sub });
            }
            return box;
        };
        const arrow = () => el.createSpan({ cls: "gnosis-step-arrow", text: "→" });

        step(el, "Notes");
        arrow();
        const channels = el.createDiv({ cls: "gnosis-step-stack" });
        step(channels, "Meaning", !semantic, semantic ? undefined : "semantic search off");
        step(channels, "Keywords");
        arrow();
        step(
            el,
            "Blend",
            !semantic,
            semantic ? (settings.strategy === "balanced" ? "balanced" : "keyword focused") : "keywords only",
        ).addClass("is-accent");
        arrow();
        step(el, "Title bonus", settings.titleBonus === "off", settings.titleBonus === "off" ? "off" : "on");
        arrow();
        step(el, "Results");
    }

    private heading(containerEl: HTMLElement, name: string): void {
        new Setting(containerEl).setName(name).setHeading();
    }

    private card(setting: Setting): Setting {
        setting.settingEl.addClass("gnosis-card");
        return setting;
    }

    private renderIndexCard(card: HTMLElement, status: IndexStatus): void {
        card.empty();
        card.dataset["state"] = status.state;

        const top = card.createDiv({ cls: "gnosis-index-top" });
        const state = top.createDiv({ cls: "gnosis-index-state" });
        state.createSpan({ cls: "gnosis-dot" });
        state.createSpan({ cls: "gnosis-index-label", text: status.label });

        if (status.notes !== null && status.chunks !== null) {
            const numbers = top.createDiv({ cls: "gnosis-index-numbers" });
            for (const [value, unit] of [
                [status.notes, "notes"],
                [status.chunks, "chunks"],
            ] as const) {
                const figure = numbers.createDiv({ cls: "gnosis-figure" });
                figure.createDiv({ cls: "gnosis-figure-value", text: value.toLocaleString() });
                figure.createDiv({ cls: "gnosis-figure-unit", text: unit });
            }
        }

        if (status.builtAt !== null) {
            const updated = top.createDiv({ cls: "gnosis-index-updated" });
            updated.createDiv({ cls: "gnosis-figure-unit", text: "last updated" });
            updated.createDiv({
                cls: "gnosis-index-when",
                text: new Date(status.builtAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                }),
            });
        }

        const bottom = card.createDiv({ cls: "gnosis-index-bottom" });
        const words = bottom.createDiv({ cls: "gnosis-index-words" });
        if (status.detail !== "") {
            words.createDiv({ cls: "gnosis-index-detail", text: status.detail });
        }
        const meta = [status.model, status.writtenBy === null ? null : `built by ${status.writtenBy}`]
            .filter((part) => part !== null)
            .join(" · ");
        if (meta !== "") {
            words.createDiv({ cls: "gnosis-index-meta", text: meta });
        }

        const button = bottom.createEl("button", { text: ACTION_LABELS[status.action] });
        if (status.action === "build" || status.action === "resume") {
            button.addClass("mod-cta");
        }
        button.addEventListener("click", () => {
            if (status.action === "cancel") {
                this.plugin.cancelBuild();
            } else {
                void this.plugin.buildIndex();
            }
        });
    }

    private renderModelCard(card: HTMLElement, status: ModelStatus): void {
        card.empty();
        card.dataset["state"] = status.state;
        const words = card.createDiv({ cls: "gnosis-model-words" });
        words.createDiv({ cls: "gnosis-model-name", text: "Embedding model" });
        const state = words.createDiv({ cls: "gnosis-index-state gnosis-model-state" });
        state.createSpan({ cls: "gnosis-dot" });
        state.createSpan({ text: `${status.label} · ${status.detail}` });
        words.createDiv({ cls: "gnosis-index-meta", text: status.model });

        if (status.canDelete) {
            const button = card.createEl("button", { text: "Delete", cls: "mod-warning" });
            // Deleting turns semantic search off, so the whole tab is redrawn.
            button.addEventListener("click", () => {
                void this.plugin.deleteModel().then(() => this.display());
            });
        }
    }

    private footer(containerEl: HTMLElement): void {
        const footer = containerEl.createDiv({ cls: "gnosis-footer" });
        const name = footer.createDiv({ cls: "gnosis-footer-name" });
        name.createSpan({ cls: "gnosis-footer-title", text: "Gnosis" });
        name.createSpan({ cls: "gnosis-footer-version", text: `v${this.plugin.manifest.version}` });

        const links = footer.createDiv({ cls: "gnosis-footer-links" });
        for (const [icon, label, href] of [
            ["book-open", "Documentation", `${REPO_URL}#readme`],
            ["github", "Source on GitHub", REPO_URL],
        ] as const) {
            const link = links.createEl("a", { cls: "gnosis-footer-link", href });
            link.setAttribute("aria-label", label);
            setIcon(link, icon);
        }
    }
}
