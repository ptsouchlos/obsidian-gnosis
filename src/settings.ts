//! Settings, and the one decision in them that matters.

import { PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import type GnosisPlugin from "./main.js";

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
}

export const DEFAULT_SETTINGS: GnosisSettings = {
    artifactDir: ".gnosis/artifact",
    limit: 20,
    semanticSearch: false,
};

export class GnosisSettingTab extends PluginSettingTab {
    constructor(
        app: App,
        private readonly plugin: GnosisPlugin,
    ) {
        super(app, plugin);
    }

    override display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Index folder")
            .setDesc(
                "Vault-relative folder holding the artifact that `gnosis export` wrote " +
                    "(a manifest.json and its shards).",
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
                    }),
            );

        new Setting(containerEl)
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

        new Setting(containerEl)
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

        new Setting(containerEl).setName("Index").setHeading();

        const status = containerEl.createEl("p", { cls: "gnosis-settings-status" });
        void this.plugin.describeIndex().then((lines) => {
            status.empty();
            for (const line of lines) {
                status.createEl("div", { text: line });
            }
        });
    }
}
