//! Settings, grouped the way a reader looks for them: the index first, then
//! how search ranks, then the model. The index card at the top is the one
//! place that says what the index is doing right now.

import { PluginSettingTab, Setting, setIcon } from "obsidian";
import type { App } from "obsidian";
import type GnosisPlugin from "./main.js";
import { DEFAULT_BUILD_MODEL, QUERY_MODELS } from "./models.js";
import type { IndexStatus } from "./status.js";

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
}

export const DEFAULT_SETTINGS: GnosisSettings = {
    artifactDir: ".gnosis/artifact",
    limit: 20,
    semanticSearch: false,
    buildModel: DEFAULT_BUILD_MODEL,
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
        const refresh = () => {
            const ticket = ++this.ticket;
            void this.plugin.indexStatus().then((status) => {
                if (ticket === this.ticket) {
                    this.renderIndexCard(card, status);
                }
            });
        };
        this.unsubscribe?.();
        this.unsubscribe = this.plugin.onStatusChange(refresh);
        refresh();

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

        this.heading(containerEl, "Model");

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
                        return;
                    }
                    // Turning it on asks first; a refusal puts the toggle back.
                    if (!(await this.plugin.enableSemanticSearch())) {
                        toggle.setValue(false);
                    }
                }),
            );

        this.footer(containerEl);
    }

    override hide(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.ticket++;
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
