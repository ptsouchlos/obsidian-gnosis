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

import { Notice, Platform, Plugin } from "obsidian";
import type { TFile } from "obsidian";
import type { Index } from "../vendor/gnosis-wasm/gnosis_wasm.js";
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
import { runBuild, type BuildProgress, type BuildSpec, type Note } from "./build/job.js";
import { replaceWarning, specForNewIndex, specFromManifest, statusLine } from "./build/plan.js";
import { copyArtifact, manifestHash, removeArtifact, writeArtifact } from "./build/write.js";
import { askConsent, confirm, downloadsFor, megabytes, type Download } from "./consent.js";
import {
    RUNTIME,
    queryVectors,
    startWorkerEmbedder,
    unsupportedReason,
    type DownloadProgress,
    type EmbedderFactory,
    type TextEmbedder,
} from "./embedder.js";
import { LexicalSearchModal, RelatedModal, SemanticSearchModal, type Display } from "./modals.js";
import { queryModelFor } from "./models.js";
import { withPresets } from "./ranking.js";
import { DEFAULT_SETTINGS, GnosisSettingTab, type GnosisSettings } from "./settings.js";
import { BrowserModelStore, type ModelStore } from "./model-store.js";
import { indexStatus, modelStatus, type IndexStatus, type ModelStatus } from "./status.js";
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
    isMobile = (): boolean => Platform.isMobile;

    private building: AbortController | null = null;
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
        if (this.index !== null) {
            return this.index;
        }
        try {
            this.index = await openArtifact(this.app, this.settings.artifactDir);
            this.applySearchConfig();
            return this.index;
        } catch (error) {
            if (error instanceof ArtifactMissing) {
                new Notice(
                    `Gnosis: no index in ${this.settings.artifactDir} yet. Run "Build index" to ` +
                        `build one here, or with the gnosis CLI:\n` +
                        `  gnosis export --out ${this.settings.artifactDir}`,
                    10_000,
                );
            } else {
                // A hash mismatch lands here, and it is worth showing
                // verbatim: it means the artifact is half-synced, which is
                // fixed by waiting rather than by re-exporting.
                new Notice(`Gnosis: ${describe(error)}`, 10_000);
            }
            return null;
        }
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
        const base = this.index.searchConfig() as { dense_weight: number; title_boost: number };
        this.index.setSearchConfig(withPresets(base, this.settings.strategy, this.settings.titleBonus));
    }

    /** How pickers show and open results, as the settings say now. */
    private display(): Display {
        const { modOpen, keyboardHints, showScores } = this.settings;
        return { modOpen, keyboardHints, showScores };
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
                new Notice(`Gnosis: ${describe(error)}`);
                return [];
            }
        };
        const notify = (message: string) => {
            new Notice(`Gnosis: ${message}`, 8000);
        };

        const space = this.settings.semanticSearch ? this.semanticSpace(index) : null;
        if (space === null) {
            new LexicalSearchModal(this.app, this.display(), lexical, notify).open();
            return;
        }

        // Started here as well as when the setting is turned on: after a
        // restart the model is cached but not loaded.
        this.startEmbedder(space).catch(() => {});
        new SemanticSearchModal(
            this.app,
            this.display(),
            async (query) => {
                const embedder = this.embedder?.ready ?? null;
                if (embedder === null) {
                    return lexical(query);
                }
                try {
                    const vectors = await queryVectors(embedder, space, query);
                    return index.search(query, vectors, this.settings.limit, undefined) as Hit[];
                } catch (error) {
                    new Notice(`Gnosis: ${describe(error)}`);
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
        const key = embedderKey(space);
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
        this.embedderError = null;
        this.statusChanged();
        starting.then(
            (embedder) => {
                progress.hide();
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
        const held = model === null ? null : await this.modelStore.held(model, RUNTIME.url).catch(() => null);
        return modelStatus({
            modelId: id,
            dim,
            supported: model !== null,
            heldBytes: held === null ? null : held.modelBytes + held.runtimeBytes,
            complete: held?.modelComplete ?? false,
            downloadBytes: (model?.downloadBytes ?? 0) + RUNTIME.bytes,
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
        const freed = await this.modelStore.remove(model, RUNTIME.url);
        new Notice(`Gnosis: deleted the model — ${megabytes(freed)} freed`);
        this.statusChanged();
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
            new Notice(`Gnosis: ${describe(error)}`, 8000);
            return;
        }
        new RelatedModal(this.app, this.display(), file, hits, (message) => {
            new Notice(`Gnosis: ${message}`, 8000);
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

    /**
     * Build or update the vault's index, here.
     *
     * Incremental whenever there is something to start from: an interrupted
     * build's checkpoint first, else the live index. Only changed notes are
     * embedded either way. The live index is replaced only by a build that
     * completed, and only after the reader has agreed if another device or
     * the CLI wrote it.
     */
    async buildIndex(): Promise<void> {
        if (this.building !== null) {
            new Notice("Gnosis: an index build is already running");
            return;
        }
        if (this.isMobile()) {
            // Embedding a whole vault on a phone is a different proposition:
            // build on a desktop, and let this device read the result.
            new Notice("Gnosis: building an index is desktop-only — build on a desktop and sync it here", 10_000);
            return;
        }
        const controller = new AbortController();
        this.building = controller;
        this.statusChanged();
        try {
            await this.runBuildCommand(controller.signal);
        } catch (error) {
            new Notice(`Gnosis: the index build failed — ${describe(error)}. The existing index is unchanged.`, 10_000);
        } finally {
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

    private async runBuildCommand(signal: AbortSignal): Promise<void> {
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

        const planned = live === null
            ? specForNewIndex(this.settings.buildModel, vaultName)
            : specFromManifest(live.manifestJson, vaultName);
        if ("refuse" in planned) {
            new Notice(`Gnosis: ${planned.refuse}`, 10_000);
            return;
        }
        const spec = planned.spec;

        const liveHash = live === null ? null : await manifestHash(live.manifestJson);
        if (live !== null && liveHash !== this.lastWritten()) {
            if (!(await this.confirmReplace(replaceWarning(live.manifestJson, vaultName)))) {
                return;
            }
        }

        const space = specSpace(spec);
        const model = queryModelFor(spec.model)!;
        const consented = this.settings.semanticSearch && this.embedder?.key === embedderKey(space);
        if (!consented && !(await this.askConsent(downloadsFor(spec.model, model, RUNTIME)))) {
            return;
        }
        const embedder = await this.startEmbedder(space);
        await startWasm();

        const vault = this.vaultKey();
        const specKey = JSON.stringify(spec);
        const saved = await this.checkpoints.load(vault);
        const resuming = saved !== null && saved.specKey === specKey;
        if (saved !== null && !resuming) {
            await this.checkpoints.clear(vault);
        }
        if (resuming) {
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
        });

        if (result.canceled || result.artifact === null) {
            new Notice(
                "Gnosis: index build canceled. The existing index is unchanged; " +
                    `"Build index" picks up where this one stopped.`,
                10_000,
            );
            return;
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
            if (!(await this.confirmReplace(replaceWarning(current.manifestJson, vaultName)))) {
                return;
            }
        }

        const written = await writeArtifact(this.app.vault.adapter, dir, result.artifact);
        await this.checkpoints.clear(vault);
        if (written.upToDate) {
            new Notice(`Gnosis: the index is already up to date — ${result.documents.toLocaleString()} notes`);
            return;
        }
        this.app.saveLocalStorage(LAST_WRITTEN_KEY, await manifestHash(result.artifact.manifestJson));
        this.closeIndex();

        // The model is downloaded and consented to: search uses it from now on.
        if (!this.settings.semanticSearch) {
            this.settings.semanticSearch = true;
            await this.saveSettings();
        }
        new Notice(
            `Gnosis: indexed ${result.documents.toLocaleString()} notes, ` +
                `${result.chunks.toLocaleString()} chunks — ${result.chunksEmbedded.toLocaleString()} ` +
                `embedded, ${result.notesReused.toLocaleString()} notes unchanged; ` +
                `${written.written} of ${written.written + written.unchanged} shard(s) written.`,
            10_000,
        );
    }

    /**
     * Every markdown note, read lazily: most of an incremental build is
     * reused. Notes Obsidian's "Excluded files" covers are left out unless the
     * reader says otherwise, so an archive they hid from Obsidian's search
     * stays out of this one too.
     */
    private notes(): Note[] {
        // Obsidian's own matcher, not public API: without it, nothing is
        // excluded rather than anything guessed.
        const ignored = (this.app.metadataCache as { isUserIgnored?: (path: string) => boolean }).isUserIgnored;
        const skip = (path: string) =>
            this.settings.honorExcluded && typeof ignored === "function" && ignored.call(this.app.metadataCache, path);
        return this.app.vault
            .getMarkdownFiles()
            .filter((file) => !skip(file.path))
            .map((file) => ({
            path: file.path,
            mtime: file.stat.mtime,
            read: () => this.app.vault.cachedRead(file),
        }));
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

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}

/** Where this device remembers the manifest it last wrote, in `localStorage`. */
const LAST_WRITTEN_KEY = "gnosis-last-written-manifest";

function embedderKey(space: SpaceInfo): string {
    return `${space.queryModel}/${space.pooling}`;
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
