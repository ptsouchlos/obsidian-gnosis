//! Enough of Obsidian's API to run the plugin outside Obsidian.
//!
//! The point of this stub is to make the plugin's own behavior testable: when
//! the index loads, what a search returns, what happens when a hit's file is
//! gone. Only what the plugin actually calls is implemented, so a call it
//! starts making shows up as a missing method rather than as a silent no-op.
//!
//! Everything the real API does that cannot be faked here — rendering,
//! editors, syncing — the plugin does not do.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export class TFile {
    constructor(
        readonly path: string,
        readonly basename: string,
    ) {}
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
        return new TFile(path, basename);
    }
}

/** Records what the plugin opened, so a test can assert on it. */
class StubWorkspace {
    activeFile: TFile | null = null;
    opened: string[] = [];

    getActiveFile(): TFile | null {
        return this.activeFile;
    }

    getLeaf(_newLeaf: boolean): { openFile(file: TFile): Promise<void> } {
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

    constructor(root: string) {
        this.vault = new StubVault(root);
    }
}

/** Every notice raised, in order — the plugin's whole user-facing channel. */
export const notices: string[] = [];

export class Notice {
    constructor(message: string, _timeout?: number) {
        notices.push(message);
    }
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

    /** Choose one of the listed results. */
    choose(value: T): void {
        this.onChooseSuggestion(value);
    }
}

export class PluginSettingTab {
    containerEl = {} as HTMLElement;

    constructor(
        readonly app: App,
        readonly plugin: Plugin,
    ) {}

    display(): void {}
}

export class Setting {
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
}
