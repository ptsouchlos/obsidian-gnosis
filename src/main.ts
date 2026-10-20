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
//!
//! Building an index uses the same model and the same consent, and gnosis's
//! own `Builder` for everything the index contains — see `build/job.ts`.

import { Notice, Platform, Plugin, apiVersion } from "obsidian";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { contentHash, type Index } from "../vendor/gnosis-wasm/gnosis_wasm.js";
import {
    ArtifactMissing,
    MANIFEST_NAME,
    join,
    openArtifact,
    parseManifest,
    readArtifact,
    startWasm,
    type RawArtifact,
} from "./artifact.js";
import { IndexedDbCheckpoints, type CheckpointStore } from "./build/checkpoints.js";
import { runBuild, type BuildProgress, type BuildResult, type BuildSpec, type Note } from "./build/job.js";
import { replaceWarning, specForNewIndex, specFromManifest, statusLine } from "./build/plan.js";
import { copyArtifact, manifestHash, removeArtifact, writeArtifact } from "./build/write.js";
import { askConsent, confirm, downloadsFor, megabytes, type Download } from "./consent.js";
import {
    Diagnostics,
    REPORT_PATH,
    Redactor,
    renderReport,
    type BuildRecord,
    type ModelLoadRecord,
} from "./diagnostics.js";
import {
    BATCH_CHUNKS,
    RUNTIMES,
    queryVectors,
    startWorkerEmbedder,
    unsupportedReason,
    webgpuAdapter,
    type Device,
    type DownloadProgress,
    type EmbedderFactory,
    type TextEmbedder,
} from "./embedder.js";
import { LexicalSearchModal, SemanticSearchModal, type Display } from "./modals.js";
import { queryModelFor } from "./models.js";
import type { RelatedState } from "./related/follow.js";
import { RELATED_VIEW, RelatedView } from "./related/view.js";
import { withPresets } from "./ranking.js";
import { DEFAULT_SETTINGS, GnosisSettingTab, type GnosisSettings } from "./settings.js";
import { BrowserModelStore, type ModelStore } from "./model-store.js";
import { AutoUpdater } from "./auto-update.js";
import { vaultStaleness, stalenessLine, type Staleness } from "./staleness.js";
import { indexStatus, modelStatus, type IndexStatus, type ModelStatus } from "./status.js";
import type { Hit, IndexInfo, SpaceInfo } from "./types.js";

/** An embedder for one model, from the moment it starts loading. */
interface EmbedderState {
    /** Model id, pooling and device: a different index may need a different model. */
    key: string;
    device: Device;
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
    /** Whether this device has a WebGPU adapter; tests answer for it. */
    hasWebgpu: () => Promise<boolean> = webgpuAdapter;
    /** The adapter check, once per session: it does not change while Obsidian runs. */
    private webgpu: Promise<boolean> | null = null;
    /** How the reader is asked; tests answer for them. */
    askConsent: (downloads: Download[]) => Promise<boolean> = (downloads) =>
        askConsent(this.app, downloads);
    /** Asked before replacing an index this device did not write. */
    confirmReplace: (lines: string[]) => Promise<boolean> = (lines) =>
        confirm(this.app, "Replace the existing index?", lines, "Build and replace");
    /** Where an unfinished build keeps its progress; per device, never synced. */
    checkpoints: CheckpointStore = new IndexedDbCheckpoints();
    checkpointEveryMs = 60_000;
    /** What this device holds of a model; tests replace Cache Storage. */
    modelStore: ModelStore = new BrowserModelStore();
    /** Asked before deleting the model. */
    confirmDelete: (lines: string[]) => Promise<boolean> = (lines) =>
        confirm(this.app, "Delete the model from this device?", lines, "Delete");
    /** Asked before resetting settings. */
    confirmReset: (lines: string[]) => Promise<boolean> = (lines) =>
        confirm(this.app, "Reset Gnosis's settings?", lines, "Reset");
    isMobile = (): boolean => Platform.isMobile;
    /** This session's events and timings, for the diagnostics report. */
    readonly diagnostics = new Diagnostics();
    /** Updates the index once edits settle; tests drive it with a fake clock. */
    autoUpdater = new AutoUpdater(() => this.autoUpdate());
    /** Why the last automatic update was skipped, until a build settles it. */
    autoSkipped: string | null = null;

    private building: AbortController | null = null;
    /** An open in progress, shared by everyone who asks meanwhile. */
    private opening: Promise<{ index: Index } | { error: unknown }> | null = null;
    /** Why the model last failed to load, until it is tried again. */
    private embedderError: string | null = null;
    /** The build's latest report, for the settings tab's card. */
    private buildProgress: BuildProgress | null = null;
    private status: HTMLElement | null = null;
    /** Whoever is showing the index's state: the settings tab, while open. */
    private readonly statusListeners = new Set<(progressOnly: boolean) => void>();

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

        this.registerView(RELATED_VIEW, (leaf) => new RelatedView(leaf, this));
        // Listed in Settings → Page preview, where the reader chooses whether
        // hovering needs Cmd/Ctrl; it does by default, as in Obsidian's own
        // sidebars.
        this.registerHoverLinkSource(RELATED_VIEW, { display: "Gnosis related notes", defaultMod: true });
        // The id is kept from when this opened a picker, so hotkeys survive.
        this.addCommand({
            id: "related",
            name: "Show related notes",
            callback: () => {
                void this.revealRelated();
            },
        });
        // Shown once, the first time the plugin loads; after that the panel
        // is wherever the reader left it, or closed if they closed it —
        // Obsidian restores its layout.
        this.app.workspace.onLayoutReady(() => {
            if (!this.settings.relatedPanelShown) {
                this.settings.relatedPanelShown = true;
                void this.saveSettings().then(() => this.revealRelated(false));
            }
        });

        // Not before layout is ready: while it loads, Obsidian reports every
        // file in the vault as created.
        this.app.workspace.onLayoutReady(() => {
            const changed = (path: string) => {
                if (this.isIndexed(path)) {
                    this.autoUpdater.poke();
                }
            };
            this.registerEvent(this.app.vault.on("modify", (file) => changed(file.path)));
            this.registerEvent(this.app.vault.on("create", (file) => changed(file.path)));
            this.registerEvent(this.app.vault.on("delete", (file) => changed(file.path)));
            this.registerEvent(
                this.app.vault.on("rename", (file, oldPath) => {
                    changed(file.path);
                    changed(oldPath);
                }),
            );
            // Notes may have changed while Obsidian was closed, or synced in.
            this.autoUpdater.poke(STARTUP_DELAY_MS);
        });

        this.addCommand({
            id: "build-index",
            name: "Build index",
            callback: () => {
                void this.buildIndex();
            },
        });

        this.addCommand({
            id: "cancel-build",
            name: "Cancel index build",
            checkCallback: (checking) => {
                if (this.building === null) {
                    return false;
                }
                if (!checking) {
                    this.cancelBuild();
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
        this.autoUpdater.stop();
        // A build in flight checkpoints on its way out, so the next one resumes.
        this.building?.abort();
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
        const opened = await this.openIndex();
        if ("index" in opened) {
            return opened.index;
        }
        if (opened.error instanceof ArtifactMissing) {
            new Notice(
                `Gnosis: no index in ${this.settings.artifactDir} yet. Run "Build index" to ` +
                    `build one here, or with the gnosis CLI:\n` +
                    `  gnosis export --out ${this.settings.artifactDir}`,
                10_000,
            );
        } else {
            // A hash mismatch lands here, and it is worth showing verbatim: it
            // means the artifact is half-synced, which is fixed by waiting
            // rather than by re-exporting.
            new Notice(`Gnosis: ${describe(opened.error)}`, 10_000);
        }
        return null;
    }

    /**
     * Open the index, or say why not — without saying it to the reader.
     *
     * Commands report a failure as a notice; the related panel shows it in
     * place, and would otherwise raise one on every note it follows. Opening
     * is shared, so the panel and a search asking at once read the shards once.
     */
    private openIndex(): Promise<{ index: Index } | { error: unknown }> {
        if (this.index !== null) {
            return Promise.resolve({ index: this.index });
        }
        const dir = this.settings.artifactDir;
        const startedAt = this.diagnostics.now();
        this.opening ??= openArtifact(this.app, dir).then(
            (index) => {
                this.opening = null;
                this.index = index;
                this.applySearchConfig();
                const info = index.info() as IndexInfo;
                this.diagnostics.record(
                    "index",
                    `opened ${dir} in ${this.diagnostics.now() - startedAt} ms: ${info.documents} documents, ` +
                        `${info.chunks} chunks, vectors ${info.quantization}, text ${info.compression}`,
                );
                return { index };
            },
            (error: unknown) => {
                this.opening = null;
                this.diagnostics.record(
                    error instanceof ArtifactMissing ? "index" : "error",
                    error instanceof ArtifactMissing ? `no index in ${dir}` : `could not open ${dir}: ${describe(error)}`,
                );
                return { error };
            },
        );
        return this.opening;
    }

    /** What the related panel shows for `path`. */
    async relatedState(path: string): Promise<RelatedState> {
        const opened = await this.openIndex();
        if ("error" in opened) {
            return opened.error instanceof ArtifactMissing
                ? { kind: "no-index", dir: this.settings.artifactDir }
                : { kind: "unreadable", message: describe(opened.error) };
        }
        let hits: Hit[];
        try {
            hits = opened.index.related(path, this.settings.limit, this.settings.relatedIncludeLinked, undefined) as Hit[];
        } catch {
            // The one way `related` fails on a readable index: the note is
            // not in it, because it was written or renamed after the build.
            return { kind: "stale", path };
        }
        if (hits.length === 0) {
            return { kind: "empty", path };
        }
        // Pair scores between the results, for the map. A few milliseconds:
        // it reads only these notes' chunks.
        let pairs: (number | null)[][] | null;
        try {
            pairs = opened.index.similarities(hits.map((h) => h.path)) as (number | null)[][];
        } catch {
            // An index with no text space; the list still stands on its own.
            pairs = null;
        }
        return { kind: "ready", path, hits, pairs };
    }

    /**
     * Apply the reader's ranking presets to the loaded index, if one is.
     *
     * The artifact carries no search configuration — it is a client's own
     * choice — so this runs each time the index opens and whenever a preset
     * changes, and the next search uses it.
     */
    applySearchConfig(): void {
        if (this.index === null) {
            return;
        }
        const base = this.index.searchConfig() as {
            dense_weight: number;
            title_boost: number;
            recency_weight: number;
            recency_half_life_days: number;
        };
        this.index.setSearchConfig(
            withPresets(base, this.settings.strategy, this.settings.titleBonus, this.settings.recency, Date.now()),
        );
    }

    /** How pickers show and open results, as the settings say now. */
    /**
     * How pickers show and open results, as the settings say now. With
     * `keywordsOnly`, scores are on the keyword scale, so the score line is
     * told the keywords' share of the blend this index searches with.
     */
    private display(keywordsOnly = false): Display {
        const { modOpen, keyboardHints, showScores } = this.settings;
        const denseWeight = (this.index?.searchConfig() as { dense_weight?: number } | undefined)?.dense_weight;
        const keywordShare = keywordsOnly && denseWeight !== undefined ? 1 - denseWeight : null;
        return { modOpen, keyboardHints, showScores, keywordShare };
    }

    /** Drop the loaded index, so the next search re-reads the artifact. */
    closeIndex(): void {
        this.index?.free();
        this.index = null;
        this.opening = null;
        this.indexClosed();
    }

    /** Listeners told when the loaded index is dropped: the related panel's cache. */
    private readonly closeListeners = new Set<() => void>();

    onIndexClosed(listener: () => void): () => void {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    private indexClosed(): void {
        for (const listener of this.closeListeners) {
            listener();
        }
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
                // The query stays out of the log: it is the reader's own words.
                this.diagnostics.record("error", `keyword search failed: ${describe(error)}`);
                new Notice(`Gnosis: ${describe(error)}`);
                return [];
            }
        };
        const notify = (message: string) => {
            new Notice(`Gnosis: ${message}`, 8000);
        };

        const space = this.settings.semanticSearch ? this.semanticSpace(index) : null;
        if (space === null) {
            new LexicalSearchModal(this.app, this.display(true), lexical, notify).open();
            return;
        }

        // Started here as well as when the setting is turned on: after a
        // restart the model is cached but not loaded. Unattended: opening the
        // search box never downloads the GPU runtime.
        void this.chooseDevice(true)
            .then((device) => this.startEmbedder(space, device))
            .catch(() => {});
        new SemanticSearchModal(
            this.app,
            this.display(),
            async (query) => {
                const embedder = this.embedder?.ready ?? null;
                if (embedder === null) {
                    // Keywords alone while the model loads, scored on their scale.
                    return { hits: lexical(query), keywordShare: this.display(true).keywordShare };
                }
                try {
                    const vectors = await queryVectors(embedder, space, query);
                    const hits = index.search(query, vectors, this.settings.limit, undefined) as Hit[];
                    return { hits, keywordShare: null };
                } catch (error) {
                    this.diagnostics.record("error", `semantic search failed: ${describe(error)}`);
                    new Notice(`Gnosis: ${describe(error)}`);
                    return { hits: [], keywordShare: null };
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
            new Notice(`Gnosis: ${reason}`, 8000);
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
        const device = await this.chooseDevice(false);
        if (model === null || !(await this.askConsent(downloadsFor(space.queryModel, model, RUNTIMES[device], device)))) {
            return false;
        }
        this.settings.semanticSearch = true;
        await this.saveSettings();
        this.startEmbedder(space, device).catch(() => {});
        return true;
    }

    async disableSemanticSearch(): Promise<void> {
        this.settings.semanticSearch = false;
        await this.saveSettings();
        this.stopEmbedder();
    }

    /** Whether this device can use the GPU, as far as WebGPU says. */
    gpuAvailable(): Promise<boolean> {
        this.webgpu ??= this.hasWebgpu().catch(() => false);
        return this.webgpu;
    }

    /**
     * Where the model should run: the GPU when the Compute setting allows it
     * and WebGPU has an adapter, else the CPU.
     *
     * `unattended` is for starts nobody is asked about — a search, an
     * automatic update. They use the GPU only if its runtime is already on
     * this device, since it is a 25.6 MB download the reader has not agreed
     * to; the next start that asks (turning semantic search on, or a build by
     * hand) names it in the prompt.
     */
    async chooseDevice(unattended: boolean): Promise<Device> {
        if (this.settings.compute === "cpu" || !(await this.gpuAvailable())) {
            return "wasm";
        }
        if (unattended && !(await this.modelStore.hasRuntime(RUNTIMES.webgpu.url).catch(() => false))) {
            return "wasm";
        }
        return "webgpu";
    }

    /** The device the loaded (or loading) embedder runs on, if there is one. */
    runningOn(): Device | null {
        return this.embedder?.device ?? null;
    }

    /**
     * Start (or reuse) the embedder for `space`'s model on `device`,
     * reporting the download unless `quiet`: an automatic update loads it
     * unseen, as it was already downloaded with the reader's consent.
     */
    private startEmbedder(space: SpaceInfo, device: Device, quiet = false): Promise<TextEmbedder> {
        const key = embedderKey(space, device);
        if (this.embedder?.key === key) {
            return this.embedder.starting;
        }
        this.stopEmbedder();

        const model = queryModelFor(space.queryModel);
        if (model === null) {
            return Promise.reject(new Error(`no download is known for '${space.queryModel}'`));
        }
        const progress = new DownloadNotice();
        const starting = this.embedderFactory(
            model,
            space.pooling as "cls" | "mean",
            (p) => {
                if (!quiet) {
                    progress.update(p);
                }
            },
            device,
        );
        const state: EmbedderState = { key, device, starting, ready: null };
        this.embedder = state;
        this.embedderError = null;
        this.statusChanged();
        const load: ModelLoadRecord = {
            model: key,
            startedAt: this.diagnostics.now(),
            durationMs: null,
            outcome: "loading",
            error: null,
        };
        this.diagnostics.modelLoad = load;
        starting.then(
            (embedder) => {
                progress.hide();
                load.outcome = "loaded";
                load.durationMs = this.diagnostics.now() - load.startedAt;
                this.diagnostics.record("model", `loaded ${key} in ${load.durationMs} ms`);
                if (this.embedder === state) {
                    state.ready = embedder;
                    this.statusChanged();
                } else {
                    // Turned off, or replaced by another index's model, while
                    // it was still loading.
                    embedder.dispose();
                }
            },
            (error: unknown) => {
                progress.hide();
                load.outcome = "failed";
                load.durationMs = this.diagnostics.now() - load.startedAt;
                load.error = describe(error);
                this.diagnostics.record("error", `could not load ${key}: ${describe(error)}`);
                if (this.embedder === state) {
                    this.embedder = null;
                    this.embedderError = describe(error);
                    this.statusChanged();
                }
                new Notice(`Gnosis: could not load the model — ${describe(error)}`, 10_000);
            },
        );
        return starting;
    }

    private stopEmbedder(): void {
        this.embedder?.ready?.dispose();
        this.embedder = null;
        this.statusChanged();
    }

    /**
     * The model this vault's search uses: the live index's, or, with no
     * index yet, the one "Build index" would use.
     */
    private async currentModel(): Promise<{ id: string; dim: number }> {
        const path = join(this.settings.artifactDir, MANIFEST_NAME);
        try {
            if (await this.app.vault.adapter.exists(path)) {
                const manifest = JSON.parse(await this.app.vault.adapter.read(path)) as {
                    spaces: { space: string; model: { id: string; dim: number } }[];
                };
                const text = manifest.spaces.find((s) => s.space === "text");
                if (text !== undefined) {
                    return { id: text.model.id, dim: text.model.dim };
                }
            }
        } catch {
            // An unreadable manifest is the index card's to report.
        }
        const id = this.settings.buildModel;
        return { id, dim: queryModelFor(id)?.dim ?? 0 };
    }

    /** Everything the settings tab's model card shows. */
    async modelStatus(): Promise<ModelStatus> {
        const { id, dim } = await this.currentModel();
        const model = queryModelFor(id);
        const held = model === null ? null : await this.modelStore.held(model, RUNTIME_URLS).catch(() => null);
        return modelStatus({
            modelId: id,
            dim,
            supported: model !== null,
            heldBytes: held === null ? null : held.modelBytes + held.runtimeBytes,
            complete: held?.modelComplete ?? false,
            // What a first use here would download: the runtime for this device.
            downloadBytes: (model?.downloadBytes ?? 0) + RUNTIMES[await this.chooseDevice(false)].bytes,
            embedder: this.embedder === null ? null : this.embedder.ready === null ? "loading" : "ready",
            error: this.embedderError,
            building: this.building !== null,
        });
    }

    /**
     * Remove the model and the runtime from this device, after asking.
     *
     * Semantic search goes off with it: leaving it on would download the
     * model again on the next search, which is not what deleting means. The
     * index is untouched, and keyword search and related notes keep working.
     */
    async deleteModel(): Promise<void> {
        if (this.building !== null) {
            new Notice("Gnosis: an index build is using the model — cancel it first");
            return;
        }
        const { id } = await this.currentModel();
        const model = queryModelFor(id);
        if (model === null) {
            return;
        }
        const agreed = await this.confirmDelete([
            `This removes ${id} and ONNX Runtime from this device. Your index is not affected, and ` +
                "keyword search and related notes keep working.",
            "Semantic search is turned off. Turning it back on, or building an index, downloads the " +
                "model again. Another plugin that uses the same model downloads it again too.",
        ]);
        if (!agreed) {
            return;
        }
        this.stopEmbedder();
        this.embedderError = null;
        if (this.settings.semanticSearch) {
            this.settings.semanticSearch = false;
            await this.saveSettings();
        }
        const freed = await this.modelStore.remove(model, RUNTIME_URLS);
        new Notice(`Gnosis: deleted the model — ${megabytes(freed)} freed`);
        this.statusChanged();
    }

    /** Open the related-notes panel in the right sidebar, or bring it forward. */
    async revealRelated(focus = true): Promise<void> {
        const workspace = this.app.workspace;
        let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(RELATED_VIEW)[0] ?? null;
        if (leaf === null) {
            leaf = workspace.getRightLeaf(false);
            if (leaf === null) {
                return;
            }
            await leaf.setViewState({ type: RELATED_VIEW, active: focus });
        }
        if (focus) {
            await workspace.revealLeaf(leaf);
        }
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
        const stale = await this.vaultStaleness();
        if (stale !== null) {
            lines.push(stalenessLine(stale));
        }
        return lines;
    }

    /**
     * Which notes a build would add, update and remove, or null with no
     * readable index. Opens the index if nothing has yet; the related panel
     * usually has.
     */
    async vaultStaleness(): Promise<Staleness | null> {
        const opened = await this.openIndex();
        if ("error" in opened) {
            return null;
        }
        try {
            const stale = await vaultStaleness(opened.index, this.notes(), contentHash);
            this.diagnostics.record(
                "index",
                `staleness in ${stale.elapsedMs} ms (${stale.hashed} hashed): ${stale.changed.length} changed, ` +
                    `${stale.added.length} new, ${stale.removed.length} deleted`,
            );
            return stale;
        } catch (error) {
            this.diagnostics.record("error", `could not check staleness: ${describe(error)}`);
            return null;
        }
    }

    /**
     * Build or update the vault's index, here.
     *
     * Incremental whenever there is something to start from: an interrupted
     * build's checkpoint first, else the live index. Only changed notes are
     * embedded either way. The live index is replaced only by a build that
     * completed, and only after the reader has agreed if another device or
     * the CLI wrote it.
     */
    async buildIndex(auto = false): Promise<void> {
        if (this.building !== null) {
            if (!auto) {
                new Notice("Gnosis: an index build is already running");
            }
            return;
        }
        if (this.isMobile()) {
            // Embedding a whole vault on a phone is a different proposition:
            // build on a desktop, and let this device read the result.
            if (!auto) {
                new Notice("Gnosis: building an index is desktop-only — build on a desktop and sync it here", 10_000);
            }
            return;
        }
        const controller = new AbortController();
        this.building = controller;
        this.statusChanged();
        const startedAt = this.diagnostics.now();
        let run: BuildRun = { outcome: "not started" };
        try {
            run = await this.runBuildCommand(controller.signal, auto);
        } catch (error) {
            run = { outcome: "failed", error: describe(error) };
            new Notice(`Gnosis: the index build failed — ${describe(error)}. The existing index is unchanged.`, 10_000);
        } finally {
            // Any build that ran settles the question an automatic one was
            // skipped over; a skip states the new reason.
            this.autoSkipped = run.skipped ?? (run.outcome === "not started" ? this.autoSkipped : null);
            this.recordBuild(startedAt, run);
            this.building = null;
            this.buildProgress = null;
            this.status?.remove();
            this.status = null;
            this.statusChanged();
        }
    }

    /** Stop the build in flight; it checkpoints, so the next one resumes. */
    cancelBuild(): void {
        if (this.building === null || this.building.signal.aborted) {
            return;
        }
        this.building.abort();
        new Notice("Gnosis: canceling — finishing the batch in flight…");
    }

    /**
     * Be told whenever the index's or the model's state may have changed.
     * `progressOnly` marks a build's progress tick, which changes nothing but
     * the build's numbers. Returns the unsubscribe.
     */
    onStatusChange(listener: (progressOnly: boolean) => void): () => void {
        this.statusListeners.add(listener);
        return () => this.statusListeners.delete(listener);
    }

    private statusChanged(progressOnly = false): void {
        for (const listener of this.statusListeners) {
            listener(progressOnly);
        }
    }

    /**
     * Everything the settings tab's index card shows.
     *
     * Read from the manifest alone, not by opening the index: opening reads
     * every shard, which is not worth doing to show a count.
     */
    async indexStatus(): Promise<IndexStatus> {
        const dir = this.settings.artifactDir;
        const manifestPath = join(dir, MANIFEST_NAME);
        let manifestJson: string | null = null;
        let readError: string | null = null;
        try {
            if (await this.app.vault.adapter.exists(manifestPath)) {
                manifestJson = await this.app.vault.adapter.read(manifestPath);
                parseManifest(manifestJson, manifestPath);
            }
        } catch (error) {
            readError = describe(error);
        }
        const writtenHere = manifestJson !== null && (await manifestHash(manifestJson)) === this.lastWritten();

        // A build in flight is the state; a checkpoint only matters without one.
        let checkpointNotes: number | null = null;
        if (this.building === null) {
            const saved = await this.checkpoints.load(this.vaultKey()).catch(() => null);
            if (saved !== null) {
                const manifest = JSON.parse(saved.artifact.manifestJson) as { shards: { documents: number }[] };
                checkpointNotes = manifest.shards.reduce((n, s) => n + s.documents, 0);
            }
        }

        return indexStatus(
            {
                manifestJson,
                readError,
                writtenHere,
                building: this.building === null ? null : { progress: this.buildProgress },
                checkpointNotes,
                vaultNotes: this.app.vault.getMarkdownFiles().length,
            },
            dir,
        );
    }

    private recordBuild(startedAt: number, run: BuildRun): void {
        const result = run.result ?? null;
        const record: BuildRecord = {
            startedAt,
            durationMs: this.diagnostics.now() - startedAt,
            outcome: run.outcome,
            notes: result?.documents ?? null,
            chunks: result?.chunks ?? null,
            chunksEmbedded: result?.chunksEmbedded ?? null,
            notesReused: result?.notesReused ?? null,
            shardsWritten: run.shardsWritten ?? null,
            error: run.error ?? null,
        };
        this.diagnostics.lastBuild = record;
        this.diagnostics.record(
            run.outcome === "failed" ? "error" : "build",
            `build ${run.outcome} after ${record.durationMs} ms` +
                (result === null ? "" : `: ${result.chunksEmbedded} chunks embedded`) +
                (run.error === undefined ? "" : ` — ${run.error}`),
        );
    }

    /**
     * One build. `auto` is an update nobody asked for: it never prompts, so
     * each question a build would ask becomes a reason it was skipped, and it
     * keeps quiet when it succeeds. A failure or a cancel still says so.
     */
    private async runBuildCommand(signal: AbortSignal, auto: boolean): Promise<BuildRun> {
        const dir = this.settings.artifactDir;
        const vaultName = this.app.vault.getName();

        let live: RawArtifact | null = null;
        try {
            live = await readArtifact(this.app, dir);
        } catch (error) {
            if (!(error instanceof ArtifactMissing)) {
                throw error;
            }
        }

        const liveHash = live === null ? null : await manifestHash(live.manifestJson);
        const planned = live === null
            ? specForNewIndex(this.settings.buildModel, vaultName)
            : specFromManifest(live.manifestJson, vaultName, liveHash === this.lastWritten());
        if ("refuse" in planned) {
            if (auto) {
                return { outcome: "not started", error: planned.refuse, skipped: planned.refuse };
            }
            new Notice(`Gnosis: ${planned.refuse}`, 10_000);
            return { outcome: "not started", error: planned.refuse };
        }
        const spec = planned.spec;

        if (live !== null && liveHash !== this.lastWritten()) {
            if (auto) {
                return { outcome: "not started", skipped: SKIP_WRITTEN_ELSEWHERE };
            }
            if (!(await this.confirmReplace(replaceWarning(live.manifestJson, vaultName)))) {
                return { outcome: "not started" };
            }
        }

        const space = specSpace(spec);
        const model = queryModelFor(spec.model)!;
        if (auto && !this.settings.semanticSearch) {
            // Turned off, or the model deleted: either way, not a download
            // to start unasked.
            return { outcome: "not started", skipped: SKIP_NO_MODEL };
        }
        // An automatic update never downloads the GPU runtime; one by hand
        // names it in the prompt below when this device would use it.
        const device = await this.chooseDevice(auto);
        const consented = this.settings.semanticSearch && (auto || this.embedder?.key === embedderKey(space, device));
        if (!consented && !(await this.askConsent(downloadsFor(spec.model, model, RUNTIMES[device], device)))) {
            return { outcome: "not started" };
        }
        const embedder = await this.startEmbedder(space, device, auto);
        await startWasm();

        const vault = this.vaultKey();
        const specKey = JSON.stringify(spec);
        const saved = await this.checkpoints.load(vault);
        const resuming = saved !== null && saved.specKey === specKey;
        if (saved !== null && !resuming) {
            await this.checkpoints.clear(vault);
        }
        if (resuming && !auto) {
            new Notice("Gnosis: resuming the interrupted index build");
        }

        this.status = this.addStatusBarItem();
        this.status.setText("Gnosis: indexing…");
        const result = await runBuild({
            spec,
            notes: this.notes(),
            base: resuming ? saved.artifact : live,
            embed: (texts) => embedder.embed(texts),
            checkpoint: (artifact) => this.checkpoints.save(vault, { specKey, artifact, savedAt: Date.now() }),
            signal,
            onProgress: (progress: BuildProgress) => {
                this.buildProgress = progress;
                this.status?.setText(statusLine(progress));
                this.statusChanged(true);
            },
            now: () => Date.now(),
            yieldToUi: () => new Promise((resolve) => setTimeout(resolve, 0)),
            checkpointEveryMs: this.checkpointEveryMs,
            batchChunks: BATCH_CHUNKS[device],
        });

        if (result.canceled || result.artifact === null) {
            new Notice(
                "Gnosis: index build canceled. The existing index is unchanged; " +
                    `"Build index" picks up where this one stopped.`,
                10_000,
            );
            return { outcome: "canceled", result };
        }

        // The live index may have changed while this ran — the CLI, or a
        // sync from another device. Replacing it then is the same question
        // as before, asked again rather than assumed.
        let current: RawArtifact | null = null;
        try {
            current = await readArtifact(this.app, dir);
        } catch (error) {
            if (!(error instanceof ArtifactMissing)) {
                throw error;
            }
        }
        const currentHash = current === null ? null : await manifestHash(current.manifestJson);
        if (current !== null && currentHash !== liveHash && currentHash !== this.lastWritten()) {
            if (auto) {
                return { outcome: "not written", result, skipped: SKIP_WRITTEN_ELSEWHERE };
            }
            if (!(await this.confirmReplace(replaceWarning(current.manifestJson, vaultName)))) {
                return { outcome: "not written", result };
            }
        }

        const written = await writeArtifact(this.app.vault.adapter, dir, result.artifact);
        await this.checkpoints.clear(vault);
        if (written.upToDate) {
            if (!auto) {
                new Notice(`Gnosis: the index is already up to date — ${result.documents.toLocaleString()} notes`);
            }
            return { outcome: "already up to date", result, shardsWritten: 0 };
        }
        this.app.saveLocalStorage(LAST_WRITTEN_KEY, await manifestHash(result.artifact.manifestJson));
        this.closeIndex();

        // The model is downloaded and consented to: search uses it from now on.
        if (!this.settings.semanticSearch) {
            this.settings.semanticSearch = true;
            await this.saveSettings();
        }
        if (!auto) {
            new Notice(
                `Gnosis: indexed ${result.documents.toLocaleString()} notes, ` +
                    `${result.chunks.toLocaleString()} chunks — ${result.chunksEmbedded.toLocaleString()} ` +
                    `embedded, ${result.notesReused.toLocaleString()} notes unchanged; ` +
                    `${written.written} of ${written.written + written.unchanged} shard(s) written.`,
                10_000,
            );
        }
        return { outcome: "indexed", result, shardsWritten: written.written };
    }

    /**
     * Every markdown note, read lazily: most of an incremental build is
     * reused. Notes Obsidian's "Excluded files" covers are left out unless the
     * reader says otherwise, so an archive they hid from Obsidian's search
     * stays out of this one too.
     */
    private notes(): Note[] {
        return this.app.vault
            .getMarkdownFiles()
            .filter((file) => this.isIndexed(file.path))
            .map((file) => ({
            path: file.path,
            mtime: file.stat.mtime,
            read: () => this.app.vault.cachedRead(file),
        }));
    }

    /** Whether a build includes the markdown file at `path`. */
    private isIndexed(path: string): boolean {
        // The diagnostics report is about the plugin, not one of the notes.
        if (!path.endsWith(".md") || path === REPORT_PATH) {
            return false;
        }
        // Obsidian's own matcher, not public API: without it, nothing is
        // excluded rather than anything guessed.
        const ignored = (this.app.metadataCache as { isUserIgnored?: (path: string) => boolean }).isUserIgnored;
        return !(this.settings.honorExcluded && typeof ignored === "function" && ignored.call(this.app.metadataCache, path));
    }

    /**
     * Update the index now, if that is worth doing and needs nobody's say.
     *
     * Only when the setting is on, on a desktop, with an index to update and
     * notes that differ from it. Everything a build would ask the reader
     * becomes a reason it skipped (`runBuildCommand`), which the card shows.
     */
    async autoUpdate(): Promise<void> {
        if (!this.settings.autoUpdate || this.isMobile()) {
            return;
        }
        if (this.building !== null) {
            // Whatever changed since it started, the next update picks up.
            this.autoUpdater.poke();
            return;
        }
        const stale = await this.vaultStaleness();
        if (stale === null) {
            // No index, or one that will not open: a first build is the
            // reader's to start, and an unreadable index is the card's to report.
            return;
        }
        if (stale.changed.length + stale.added.length + stale.removed.length === 0) {
            return;
        }
        this.diagnostics.record(
            "build",
            `automatic update: ${stale.changed.length} changed, ${stale.added.length} new, ${stale.removed.length} deleted`,
        );
        await this.buildIndex(true);
    }

    /**
     * Move the index to another folder, keeping a working one throughout:
     * copy, check the copy opens, and only then remove the original. With no
     * index yet, only the setting changes.
     */
    async moveIndex(to: string): Promise<boolean> {
        const from = this.settings.artifactDir;
        if (to === from) {
            return true;
        }
        if (this.building !== null) {
            new Notice("Gnosis: an index build is running — move the index once it finishes");
            return false;
        }
        const adapter = this.app.vault.adapter;
        if (await adapter.exists(join(to, MANIFEST_NAME))) {
            // Someone else's index, perhaps the CLI's: never overwritten, and
            // never cleaned up below as if this move had made it.
            new Notice(`Gnosis: there is already an index in ${to} — remove it or choose another folder`, 10_000);
            return false;
        }
        if (await adapter.exists(join(from, MANIFEST_NAME))) {
            try {
                await copyArtifact(adapter, from, to);
                (await openArtifact(this.app, to)).free();
            } catch (error) {
                // Leave the original exactly as it was, and no half-copy.
                await removeArtifact(adapter, to).catch(() => {});
                this.diagnostics.record("error", `could not move the index from ${from} to ${to}: ${describe(error)}`);
                new Notice(`Gnosis: could not move the index to ${to} — ${describe(error)}`, 10_000);
                return false;
            }
        }
        // The verified copy is the index from here on, so the setting moves
        // before anything is removed: a failed cleanup leaves a stray old
        // copy, never a setting pointing at nothing.
        this.settings.artifactDir = to;
        await this.saveSettings();
        this.closeIndex();
        this.statusChanged();
        if (await adapter.exists(join(from, MANIFEST_NAME))) {
            try {
                await removeArtifact(adapter, from);
                new Notice(`Gnosis: moved the index to ${to}`);
            } catch (error) {
                new Notice(
                    `Gnosis: moved the index to ${to}, but could not remove the old copy in ${from} — ` +
                        `${describe(error)}. It is safe to delete.`,
                    10_000,
                );
            }
        }
        return true;
    }

    /** The manifest hash this device last wrote, if any. */
    private lastWritten(): string | null {
        const value: unknown = this.app.loadLocalStorage(LAST_WRITTEN_KEY);
        return typeof value === "string" ? value : null;
    }

    /**
     * Which vault checkpoints belong to. IndexedDB is shared by every vault
     * Obsidian opens; `appId` is Obsidian's own per-vault id.
     */
    private vaultKey(): string {
        const id = (this.app as unknown as { appId?: unknown }).appId;
        return typeof id === "string" ? id : this.app.vault.getName();
    }

    /**
     * Write the diagnostics report to the vault root and open it.
     *
     * Built from this session's events and the same status the settings
     * cards show. Redacted by default: every note path in it becomes a token.
     */
    async generateReport(): Promise<void> {
        let index = await this.indexStatus();
        if (index.state === "ready") {
            // The counts only: the paths would need redacting for no gain.
            const stale = await this.vaultStaleness();
            if (stale !== null) {
                index = { ...index, detail: stalenessLine(stale) };
            }
        }
        const report = renderReport({
            generatedAt: this.diagnostics.now(),
            pluginVersion: this.manifest.version,
            obsidianVersion: apiVersion,
            platform: platformName(),
            artifactDir: this.settings.artifactDir,
            index,
            model: await this.modelStatus(),
            settings: this.settings,
            diagnostics: this.diagnostics,
            redactor: this.settings.redactReport
                ? new Redactor(this.app.vault.getMarkdownFiles().map((file) => file.path))
                : null,
        });
        const vault = this.app.vault;
        let file: TFile | null = vault.getFileByPath(REPORT_PATH);
        if (file === null) {
            file = await vault.create(REPORT_PATH, report);
        } else {
            await vault.modify(file, report);
        }
        await this.app.workspace.getLeaf(false).openFile(file);
    }

    /**
     * Put every setting back to its default, after asking.
     *
     * Kept: where the index lives (resetting it would point away from the
     * index without moving it), whether semantic search is on (the reader's
     * own consent to a download), and whether the related panel has been
     * shown. The index and the downloaded model are untouched.
     */
    async resetSettings(): Promise<boolean> {
        const agreed = await this.confirmReset([
            "Every setting goes back to its default, except where the index lives and whether " +
                "semantic search is on.",
            "Your index and the downloaded model are kept.",
        ]);
        if (!agreed) {
            return false;
        }
        const { artifactDir, semanticSearch, relatedPanelShown } = this.settings;
        this.settings = { ...DEFAULT_SETTINGS, artifactDir, semanticSearch, relatedPanelShown };
        await this.saveSettings();
        this.applySearchConfig();
        new Notice("Gnosis: settings reset to defaults");
        return true;
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}

/** Where this device remembers the manifest it last wrote, in `localStorage`. */
const LAST_WRITTEN_KEY = "gnosis-last-written-manifest";
/** How a build ended, for the diagnostics report. */
interface BuildRun {
    outcome: BuildRecord["outcome"];
    result?: BuildResult;
    shardsWritten?: number;
    error?: string;
    /** Why an automatic update did not run, in words for the index card. */
    skipped?: string;
}

/** How long after startup the first automatic check runs, so it never slows opening a vault. */
const STARTUP_DELAY_MS = 30_000;

/** Why an automatic update was skipped; the card shows these as they are. */
const SKIP_WRITTEN_ELSEWHERE =
    "Not updated automatically: another device or the gnosis CLI wrote this index. Update it here to take it over.";
const SKIP_NO_MODEL = "Not updated automatically: semantic search is off, so the model is not loaded.";

function platformName(): string {
    const os = Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux"
        : Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : "unknown OS";
    return `${Platform.isMobile ? "mobile" : "desktop"}, ${os}`;
}

/** Every ONNX Runtime build Gnosis may keep, for the model card and Delete. */
const RUNTIME_URLS = [RUNTIMES.wasm.url, RUNTIMES.webgpu.url];

function embedderKey(space: SpaceInfo, device: Device): string {
    return `${space.queryModel}/${space.pooling}/${device}`;
}

/** The space a build will produce, in the shape the embedder is started from. */
function specSpace(spec: BuildSpec): SpaceInfo {
    return {
        space: "text",
        model: spec.model,
        queryModel: spec.model,
        pooling: spec.pooling,
        queryPrefix: spec.queryPrefix,
        documentPrefix: spec.documentPrefix,
        dim: spec.dim,
        chunks: 0,
    };
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
        const message = `Gnosis: loading the model — ${megabytes(loaded)} of ${megabytes(total)}`;
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
