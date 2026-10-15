//! The plugin: gnosis's own retrieval pipeline, running in the vault.
//!
//! What is here is deliberately thin. Every ranking decision — the lexical
//! channel, BM25+'s parameters, the title bonus, the fusion weight, the
//! vector comparison behind `related` — lives in the WebAssembly module, which
//! is the same code the gnosis CLI runs and the same code its measurements
//! describe. This file reads bytes, calls into it, and shows what comes back.
//!
//! Lexical search and related notes need no model and download nothing: both
//! work from the artifact alone. Semantic search embeds the query with the
//! index's own model, which the reader has to agree to download first; the
//! model runs in a worker, and only the query text crosses to it.

import { Notice, Plugin } from "obsidian";
import type { TFile } from "obsidian";
import type { Index } from "../vendor/gnosis-wasm/gnosis_wasm.js";
import { ArtifactMissing, openArtifact } from "./artifact.js";
import { askConsent, downloadsFor, megabytes, type Download } from "./consent.js";
import {
    RUNTIME,
    queryVectors,
    startWorkerEmbedder,
    unsupportedReason,
    type DownloadProgress,
    type EmbedderFactory,
    type TextEmbedder,
} from "./embedder.js";
import { LexicalSearchModal, RelatedModal, SemanticSearchModal } from "./modals.js";
import { queryModelFor } from "./models.js";
import { DEFAULT_SETTINGS, GnosisSettingTab, type GnosisSettings } from "./settings.js";
import type { Hit, IndexInfo, SpaceInfo } from "./types.js";

/** An embedder for one model, from the moment it starts loading. */
interface EmbedderState {
    /** Model id and pooling: a different index may need a different model. */
    key: string;
    starting: Promise<TextEmbedder>;
    /** Set once loaded, so a search can tell "ready" without awaiting. */
    ready: TextEmbedder | null;
}

export default class GnosisPlugin extends Plugin {
    override settings: GnosisSettings = DEFAULT_SETTINGS;
    private index: Index | null = null;
    private embedder: EmbedderState | null = null;

    /** How an embedder is started; tests replace the worker with a stand-in. */
    embedderFactory: EmbedderFactory = startWorkerEmbedder;
    /** How the reader is asked; tests answer for them. */
    askConsent: (downloads: Download[]) => Promise<boolean> = (downloads) =>
        askConsent(this.app, downloads);

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
        this.stopEmbedder();
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
        const lexical = (query: string): Hit[] => {
            try {
                return index.lexicalSearch(query, this.settings.limit, undefined) as Hit[];
            } catch (error) {
                new Notice(`gnosis: ${describe(error)}`);
                return [];
            }
        };
        const notify = (message: string) => {
            new Notice(`gnosis: ${message}`, 8000);
        };

        const space = this.settings.semanticSearch ? this.semanticSpace(index) : null;
        if (space === null) {
            new LexicalSearchModal(this.app, lexical, notify).open();
            return;
        }

        // Started here as well as when the setting is turned on: after a
        // restart the model is cached but not loaded.
        this.startEmbedder(space).catch(() => {});
        new SemanticSearchModal(
            this.app,
            async (query) => {
                const embedder = this.embedder?.ready ?? null;
                if (embedder === null) {
                    return lexical(query);
                }
                try {
                    const vectors = await queryVectors(embedder, space, query);
                    return index.search(query, vectors, this.settings.limit, undefined) as Hit[];
                } catch (error) {
                    new Notice(`gnosis: ${describe(error)}`);
                    return [];
                }
            },
            this.embedder?.ready != null,
            notify,
        ).open();
    }

    /**
     * The index's text space, if semantic search can run on it.
     *
     * Says why not, once per search, when it cannot: an index built with a
     * model the plugin cannot fetch is a real state, and lexical search is
     * still the right answer for it rather than nothing.
     */
    private semanticSpace(index: Index): SpaceInfo | null {
        const info = index.info() as IndexInfo;
        const space = info.spaces.find((s) => s.space === "text");
        const reason = space === undefined ? "the index has no text space" : unsupportedReason(space);
        if (reason !== null) {
            new Notice(`gnosis: ${reason}`, 8000);
            return null;
        }
        return space ?? null;
    }

    /**
     * Turn semantic search on, if the reader agrees to the download.
     *
     * Asks with the index in hand, because what is downloaded is the model
     * *that index* was built with. Returns whether it is now on.
     */
    async enableSemanticSearch(): Promise<boolean> {
        const index = await this.withIndex();
        if (index === null) {
            return false;
        }
        const space = this.semanticSpace(index);
        if (space === null) {
            return false;
        }
        const model = queryModelFor(space.queryModel);
        if (model === null || !(await this.askConsent(downloadsFor(space.queryModel, model, RUNTIME)))) {
            return false;
        }
        this.settings.semanticSearch = true;
        await this.saveSettings();
        this.startEmbedder(space).catch(() => {});
        return true;
    }

    async disableSemanticSearch(): Promise<void> {
        this.settings.semanticSearch = false;
        await this.saveSettings();
        this.stopEmbedder();
    }

    /** Start (or reuse) the embedder for `space`'s model, reporting the download. */
    private startEmbedder(space: SpaceInfo): Promise<TextEmbedder> {
        const key = `${space.queryModel}/${space.pooling}`;
        if (this.embedder?.key === key) {
            return this.embedder.starting;
        }
        this.stopEmbedder();

        const model = queryModelFor(space.queryModel);
        if (model === null) {
            return Promise.reject(new Error(`no download is known for '${space.queryModel}'`));
        }
        const progress = new DownloadNotice();
        const starting = this.embedderFactory(model, space.pooling as "cls" | "mean", (p) =>
            progress.update(p),
        );
        const state: EmbedderState = { key, starting, ready: null };
        this.embedder = state;
        starting.then(
            (embedder) => {
                progress.hide();
                if (this.embedder === state) {
                    state.ready = embedder;
                } else {
                    // Turned off, or replaced by another index's model, while
                    // it was still loading.
                    embedder.dispose();
                }
            },
            (error: unknown) => {
                progress.hide();
                if (this.embedder === state) {
                    this.embedder = null;
                }
                new Notice(`gnosis: could not load the model — ${describe(error)}`, 10_000);
            },
        );
        return starting;
    }

    private stopEmbedder(): void {
        this.embedder?.ready?.dispose();
        this.embedder = null;
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

/**
 * One notice for the whole load, updated in place.
 *
 * Several files arrive at once — the model, its tokenizer, the runtime — so
 * progress is summed across them rather than shown file by file. "Loading",
 * not "downloading": transformers.js reports the same progress when it reads
 * a cached model as when it fetches one, and the second is the common case.
 */
class DownloadNotice {
    private readonly files = new Map<string, { loaded: number; total: number }>();
    private notice: Notice | null = null;

    update(progress: DownloadProgress): void {
        // A compressed response announces its compressed length and then
        // delivers more bytes than that, so a total can trail what arrived.
        this.files.set(progress.file, {
            loaded: progress.loaded,
            total: Math.max(progress.total, progress.loaded),
        });
        let loaded = 0;
        let total = 0;
        for (const file of this.files.values()) {
            loaded += file.loaded;
            total += file.total;
        }
        const message = `gnosis: loading the model — ${megabytes(loaded)} of ${megabytes(total)}`;
        if (this.notice === null) {
            this.notice = new Notice(message, 0);
        } else {
            this.notice.setMessage(message);
        }
    }

    hide(): void {
        this.notice?.hide();
        this.notice = null;
    }
}
