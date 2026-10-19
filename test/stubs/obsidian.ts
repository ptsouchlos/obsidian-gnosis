//! Enough of Obsidian's API to run the plugin outside Obsidian.
//!
//! The point of this stub is to make the plugin's own behavior testable: when
//! the index loads, what a search returns, what happens when a hit's file is
//! gone. Only what the plugin actually calls is implemented, so a call it
//! starts making shows up as a missing method rather than as a silent no-op.
//!
//! Everything the real API does that cannot be faked here — rendering,
//! editors, syncing — the plugin does not do.

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

export class TFile {
    constructor(
        readonly path: string,
        readonly basename: string,
        readonly stat: { mtime: number } = { mtime: 0 },
    ) {}

    get extension(): string {
        return this.path.split(".").pop() ?? "";
    }
}

/** Reads through to a real directory, as the desktop adapter does. */
class StubAdapter {
    constructor(private readonly root: string) {}

    async exists(path: string): Promise<boolean> {
        return existsSync(join(this.root, path));
    }

    async read(path: string): Promise<string> {
        return readFile(join(this.root, path), "utf8");
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        const buf = await readFile(join(this.root, path));
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    }

    /** Every write, in order, so a test can see what a build touched. */
    readonly writes: string[] = [];

    async write(path: string, data: string): Promise<void> {
        this.writes.push(path);
        await writeFile(join(this.root, path), data);
    }

    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        this.writes.push(path);
        await writeFile(join(this.root, path), new Uint8Array(data));
    }

    async mkdir(path: string): Promise<void> {
        await mkdir(join(this.root, path), { recursive: true });
    }

    async remove(path: string): Promise<void> {
        this.writes.push(`-${path}`);
        await rm(join(this.root, path));
    }

    async copy(from: string, to: string): Promise<void> {
        this.writes.push(to);
        await copyFile(join(this.root, from), join(this.root, to));
    }

    async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        const files: string[] = [];
        const folders: string[] = [];
        for (const entry of readdirSync(join(this.root, path), { withFileTypes: true })) {
            (entry.isDirectory() ? folders : files).push(`${path}/${entry.name}`);
        }
        return { files, folders };
    }

    async rmdir(path: string, recursive: boolean): Promise<void> {
        this.writes.push(`-${path}/`);
        // As Obsidian's desktop adapter does: without `recursive` it is a
        // plain `rm`, which refuses a directory even when it is empty.
        await rm(join(this.root, path), { recursive });
    }
}

class StubVault {
    readonly adapter: StubAdapter;

    constructor(private readonly root: string) {
        this.adapter = new StubAdapter(root);
    }

    getFileByPath(path: string): TFile | null {
        if (!existsSync(join(this.root, path))) {
            return null;
        }
        const basename = path.split("/").pop()!.replace(/\.[^.]+$/, "");
        return new TFile(path, basename, { mtime: statSync(join(this.root, path)).mtimeMs });
    }

    getName(): string {
        return basename(this.root);
    }

    /** Markdown files outside dot-folders, as Obsidian's own index has them. */
    getMarkdownFiles(): TFile[] {
        const found: TFile[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (entry.name.startsWith(".")) {
                    continue;
                }
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.name.endsWith(".md")) {
                    found.push(this.getFileByPath(relative(this.root, full).split("\\").join("/"))!);
                }
            }
        };
        walk(this.root);
        return found;
    }

    async cachedRead(file: TFile): Promise<string> {
        return readFile(join(this.root, file.path), "utf8");
    }

    /** As Obsidian's: refuses a path that already exists. */
    async create(path: string, data: string): Promise<TFile> {
        if (existsSync(join(this.root, path))) {
            throw new Error(`File already exists: ${path}`);
        }
        await writeFile(join(this.root, path), data);
        return this.getFileByPath(path)!;
    }

    async modify(file: TFile, data: string): Promise<void> {
        await writeFile(join(this.root, file.path), data);
    }

    /** Vault events, fired by a test with `emit` rather than by a file watcher. */
    private readonly handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();

    on(name: string, callback: (...args: never[]) => unknown): { name: string } {
        this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback as (...args: unknown[]) => unknown]);
        return { name };
    }

    emit(name: string, ...args: unknown[]): void {
        for (const handler of this.handlers.get(name) ?? []) {
            handler(...args);
        }
    }
}

/** Records what the plugin opened, so a test can assert on it. */
class StubWorkspace {
    activeFile: TFile | null = null;
    /** The editor a link is inserted into, when a test opens one. */
    activeEditor: { file: TFile | null; editor?: { replaceSelection(text: string): void } } | null = null;
    opened: string[] = [];
    /** Where each open went: `false` for the current tab, else a pane type. */
    panes: unknown[] = [];

    getActiveFile(): TFile | null {
        return this.activeFile;
    }

    /** The plugin opens its panel once layout is ready; tests run that by hand. */
    readonly layoutReady: (() => void)[] = [];

    onLayoutReady(callback: () => void): void {
        this.layoutReady.push(callback);
    }

    on(_name: string, _callback: (...args: unknown[]) => unknown): { name: string } {
        return { name: _name };
    }

    /** Leaves the plugin asked for, by the view type set on them. */
    readonly leaves: { type: string | null; setViewState(state: { type: string }): Promise<void> }[] = [];

    getLeavesOfType(type: string): unknown[] {
        return this.leaves.filter((leaf) => leaf.type === type);
    }

    getRightLeaf(_split: boolean): unknown {
        const leaf = {
            type: null as string | null,
            setViewState: async (state: { type: string }) => {
                leaf.type = state.type;
            },
        };
        this.leaves.push(leaf);
        return leaf;
    }

    async revealLeaf(_leaf: unknown): Promise<void> {}

    getLeaf(newLeaf?: unknown): { openFile(file: TFile): Promise<void> } {
        this.panes.push(newLeaf ?? false);
        return {
            openFile: async (file: TFile) => {
                this.opened.push(file.path);
            },
        };
    }
}

export class App {
    readonly vault: StubVault;
    readonly workspace = new StubWorkspace();
    /** Obsidian's "Excluded files", as path prefixes; the real one compiles patterns. */
    readonly excluded: string[] = [];
    /** Per-file metadata, as Obsidian's cache would parse it; tests fill it in. */
    readonly fileCaches = new Map<string, { frontmatter?: Record<string, unknown>; tags?: { tag: string }[] }>();
    readonly metadataCache = {
        isUserIgnored: (path: string): boolean => this.excluded.some((prefix) => path.startsWith(prefix)),
        getFileCache: (file: TFile) => this.fileCaches.get(file.path) ?? null,
    };
    /** Links as Obsidian writes them with wikilinks on. */
    readonly fileManager = {
        generateMarkdownLink: (file: TFile, _sourcePath: string): string => `[[${file.basename}]]`,
    };
    /** Obsidian's per-vault, per-device `localStorage`. */
    readonly local = new Map<string, unknown>();

    constructor(root: string) {
        this.vault = new StubVault(root);
    }

    loadLocalStorage(key: string): unknown {
        return this.local.get(key) ?? null;
    }

    saveLocalStorage(key: string, data: unknown): void {
        this.local.set(key, data);
    }
}

export const Platform = {
    isMobile: false,
    isMacOS: false,
    isWin: false,
    isLinux: true,
    isIosApp: false,
    isAndroidApp: false,
};

export const apiVersion = "0.0.0-test";

/** Tags from the body and the frontmatter, `#`-prefixed, as Obsidian's does. */
export function getAllTags(cache: { frontmatter?: Record<string, unknown>; tags?: { tag: string }[] }): string[] {
    const fromFront = cache.frontmatter?.["tags"];
    const front = Array.isArray(fromFront) ? fromFront.map((t) => `#${String(t)}`) : [];
    return [...(cache.tags ?? []).map((t) => t.tag), ...front];
}

/** The test's own events say which modifiers are held. */
export const Keymap = {
    isModEvent(evt?: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean } | null): string | boolean {
        if (!evt?.ctrlKey) return false;
        if (evt.altKey && evt.shiftKey) return "window";
        return evt.altKey ? "split" : "tab";
    },
};

/** Every notice raised, in order — the plugin's whole user-facing channel. */
export const notices: string[] = [];

export class Notice {
    constructor(message: string, _timeout?: number) {
        notices.push(message);
    }

    /** An updated message is a new entry, so a test sees every state shown. */
    setMessage(message: string): this {
        notices.push(message);
        return this;
    }

    hide(): void {}
}

/** A plain modal: the consent prompt is the only one, and tests answer it directly. */
export class Modal {
    constructor(readonly app: App) {}
    open(): void {}
    close(): void {}
}

export interface Command {
    id: string;
    name: string;
    callback?: () => void;
    checkCallback?: (checking: boolean) => boolean;
}

export interface PluginManifest {
    id: string;
    version: string;
}

export class Plugin {
    readonly commands = new Map<string, Command>();
    private data: unknown = null;

    constructor(
        readonly app: App,
        readonly manifest: PluginManifest = { id: "gnosis", version: "0.0.0-test" },
    ) {}

    addCommand(command: Command): Command {
        this.commands.set(command.id, command);
        return command;
    }

    addSettingTab(_tab: unknown): void {}

    registerEvent(_ref: unknown): void {}

    readonly views = new Map<string, unknown>();

    registerView(type: string, factory: unknown): void {
        this.views.set(type, factory);
    }

    readonly hoverSources = new Map<string, { display: string; defaultMod: boolean }>();

    registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }): void {
        this.hoverSources.set(id, info);
    }

    /** The status bar's text, newest last, for tests. */
    readonly statusTexts: string[] = [];

    addStatusBarItem(): { setText(text: string): void; remove(): void } {
        return {
            setText: (text: string) => this.statusTexts.push(text),
            remove: () => {},
        };
    }

    async loadData(): Promise<unknown> {
        return this.data;
    }

    async saveData(data: unknown): Promise<void> {
        this.data = data;
    }
}

/**
 * A pared-down `SuggestModal`: the test opens it, types, and chooses, which is
 * the whole interaction the plugin's pickers implement.
 */
/** Every modal the plugin opened, newest last. */
export const openedModals: SuggestModal<unknown>[] = [];

export class SuggestModal<T> {
    emptyStateText = "";
    private placeholder = "";
    opened = false;
    /** Key bindings the modal registered, as "Mod+Enter". */
    readonly keys = new Map<string, (evt: unknown) => unknown>();
    readonly scope = {
        register: (mods: string[], key: string, fn: (evt: unknown) => unknown) => {
            this.keys.set([...mods, key].join("+"), fn);
        },
    };
    instructions: { command: string; purpose: string }[] = [];

    setInstructions(instructions: { command: string; purpose: string }[]): void {
        this.instructions = instructions;
    }

    selectActiveSuggestion(_evt: unknown): void {}

    constructor(readonly app: App) {}

    setPlaceholder(text: string): void {
        this.placeholder = text;
    }

    getPlaceholder(): string {
        return this.placeholder;
    }

    open(): void {
        this.opened = true;
        openedModals.push(this as SuggestModal<unknown>);
    }

    close(): void {
        this.opened = false;
    }

    getSuggestions(_query: string): T[] {
        throw new Error("the plugin must implement getSuggestions");
    }

    renderSuggestion(_value: T, _el: HTMLElement): void {}

    onChooseSuggestion(_value: T, _evt?: unknown): void {}

    /** Type a query and read back what would be listed. */
    type(query: string): T[] {
        return this.getSuggestions(query);
    }

    /** Choose one of the listed results, optionally with a modifier event. */
    choose(value: T, evt?: unknown): void {
        this.onChooseSuggestion(value, evt);
    }
}

export class PluginSettingTab {
    containerEl = {} as HTMLElement;

    constructor(
        readonly app: App,
        readonly plugin: Plugin,
    ) {}

    display(): void {}
    hide(): void {}
}

export function setIcon(_el: unknown, _icon: string): void {}

export class Setting {
    readonly settingEl = { addClass(_cls: string): void {} };
    readonly controlEl = {} as HTMLElement;
    constructor(_containerEl: unknown) {}
    setName(_name: string): this {
        return this;
    }
    setDesc(_desc: string): this {
        return this;
    }
    setHeading(): this {
        return this;
    }
    addText(_cb: unknown): this {
        return this;
    }
    addSlider(_cb: unknown): this {
        return this;
    }
    addToggle(_cb: unknown): this {
        return this;
    }
    addButton(_cb: unknown): this {
        return this;
    }
    addDropdown(_cb: unknown): this {
        return this;
    }
}

/** The panel's base class; the plugin's view logic is tested through `RelatedFollower`. */
export class ItemView {
    contentEl = {} as HTMLElement;
    constructor(readonly leaf: unknown) {}
    registerEvent(_ref: unknown): void {}
}

export class Menu {
    addItem(_cb: unknown): this {
        return this;
    }
    showAtMouseEvent(_evt: unknown): void {}
}
