//! The plugin: gnosis's own retrieval pipeline, running in the vault.
//!
//! What is here is deliberately thin. Every ranking decision — the lexical
//! channel, BM25+'s parameters, the title bonus, the fusion weight, the
//! vector comparison behind `related` — lives in the WebAssembly module, which
//! is the same code the gnosis CLI runs and the same code its measurements
//! describe. This file reads bytes, calls into it, and shows what comes back.
//!
//! This stage needs no model and downloads nothing: lexical search and related
//! notes both work from the artifact alone. Semantic search needs a query
//! embedder, which is the next stage.

import { Notice, Plugin } from "obsidian";
import type { TFile } from "obsidian";
import type { Index } from "../vendor/gnosis-wasm/gnosis_wasm.js";
import { ArtifactMissing, openArtifact } from "./artifact.js";
import { LexicalSearchModal, RelatedModal } from "./modals.js";
import { DEFAULT_SETTINGS, GnosisSettingTab, type GnosisSettings } from "./settings.js";
import type { Hit, IndexInfo } from "./types.js";

export default class GnosisPlugin extends Plugin {
    override settings: GnosisSettings = DEFAULT_SETTINGS;
    private index: Index | null = null;

    override async onload(): Promise<void> {
        await this.loadSettings();
        this.addSettingTab(new GnosisSettingTab(this.app, this));

        this.addCommand({
            id: "search",
            name: "Search vault",
            callback: () => {
                void this.openSearch();
            },
        });

        this.addCommand({
            id: "related",
            name: "Related notes",
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (file === null) {
                    return false;
                }
                if (!checking) {
                    void this.openRelated(file);
                }
                return true;
            },
        });

        this.addCommand({
            id: "index-info",
            name: "Show index info",
            callback: () => {
                void this.describeIndex().then((lines) => {
                    new Notice(lines.join("\n"), 10_000);
                });
            },
        });
    }

    override onunload(): void {
        this.closeIndex();
    }

    /**
     * The loaded index, opened on first use.
     *
     * Lazily rather than in `onload`: opening reads every shard and builds the
     * lexical index, which is work a vault that never searches should not pay
     * for at startup. A vault with no artifact is an ordinary state, not an
     * error, so it is reported once and not retried until asked again.
     */
    private async withIndex(): Promise<Index | null> {
        if (this.index !== null) {
            return this.index;
        }
        try {
            this.index = await openArtifact(this.app, this.settings.artifactDir);
            return this.index;
        } catch (error) {
            if (error instanceof ArtifactMissing) {
                new Notice(
                    `gnosis: no index in ${this.settings.artifactDir}. Build one with\n` +
                        `  gnosis export --out ${this.settings.artifactDir}`,
                    10_000,
                );
            } else {
                // A hash mismatch lands here, and it is worth showing
                // verbatim: it means the artifact is half-synced, which is
                // fixed by waiting rather than by re-exporting.
                new Notice(`gnosis: ${describe(error)}`, 10_000);
            }
            return null;
        }
    }

    /** Drop the loaded index, so the next search re-reads the artifact. */
    closeIndex(): void {
        this.index?.free();
        this.index = null;
    }

    private async openSearch(): Promise<void> {
        const index = await this.withIndex();
        if (index === null) {
            return;
        }
        new LexicalSearchModal(
            this.app,
            (query) => {
                try {
                    return index.lexicalSearch(query, this.settings.limit, undefined) as Hit[];
                } catch (error) {
                    new Notice(`gnosis: ${describe(error)}`);
                    return [];
                }
            },
            (message) => {
                new Notice(`gnosis: ${message}`, 8000);
            },
        ).open();
    }

    private async openRelated(file: TFile): Promise<void> {
        const index = await this.withIndex();
        if (index === null) {
            return;
        }
        let hits: Hit[];
        try {
            hits = index.related(file.path, this.settings.limit, false, undefined) as Hit[];
        } catch (error) {
            // The commonest case by far: the note was written or renamed after
            // the index was built. Saying so beats "no related notes found",
            // which would read as an answer rather than as a stale index.
            new Notice(`gnosis: ${describe(error)}`, 8000);
            return;
        }
        new RelatedModal(this.app, file, hits, (message) => {
            new Notice(`gnosis: ${message}`, 8000);
        }).open();
    }

    /** Human-readable lines about the loaded index, for settings and notices. */
    async describeIndex(): Promise<string[]> {
        const index = await this.withIndex();
        if (index === null) {
            return [`No index loaded from ${this.settings.artifactDir}.`];
        }
        const info = index.info() as IndexInfo;
        const built = new Date(info.createdUnix * 1000);
        const lines = [
            `${info.documents.toLocaleString()} documents, ${info.chunks.toLocaleString()} chunks`,
            `built ${built.toLocaleString()}`,
            `vectors ${info.quantization}, text ${info.compression}`,
        ];
        for (const space of info.spaces) {
            lines.push(`${space.space}: ${space.queryModel} (${space.pooling}, ${space.dim}d)`);
        }
        return lines;
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}

/** An error's message, whatever shape it arrived in from WebAssembly. */
function describe(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return typeof error === "string" ? error : JSON.stringify(error);
}
