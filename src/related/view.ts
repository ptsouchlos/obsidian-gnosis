//! The related-notes panel: notes like the one you are reading, without asking.
//!
//! The same `related` the CLI's `gnosis related` runs — vectors the index
//! already holds, so no model and no download, on any device. This file only
//! draws what `RelatedFollower` decides and opens what the reader clicks.

import { ItemView, Menu, setIcon } from "obsidian";
import type { TFile, WorkspaceLeaf } from "obsidian";
import type GnosisPlugin from "../main.js";
import { paneFor } from "../modals.js";
import { formatScore, hitSnippet, noteName, resolveHit } from "../results.js";
import type { Hit } from "../types.js";
import { RelatedFollower, type RelatedState } from "./follow.js";

export const RELATED_VIEW = "gnosis-related";

/** Long enough to skip the notes passed through while switching quickly. */
const FOLLOW_DEBOUNCE_MS = 200;

export class RelatedView extends ItemView {
    readonly follower: RelatedFollower;
    private headerEl!: HTMLElement;
    private bodyEl!: HTMLElement;
    private pinButton!: HTMLElement;
    private timer: number | null = null;
    private readonly unsubscribes: (() => void)[] = [];

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: GnosisPlugin,
    ) {
        super(leaf);
        this.follower = new RelatedFollower((path) => plugin.relatedState(path));
    }

    override getViewType(): string {
        return RELATED_VIEW;
    }

    override getDisplayText(): string {
        return "Related notes";
    }

    override getIcon(): string {
        return "sparkles";
    }

    override async onOpen(): Promise<void> {
        const root = this.contentEl;
        root.empty();
        root.addClass("gnosis-related");

        const bar = root.createDiv({ cls: "gnosis-related-bar" });
        this.pinButton = bar.createEl("button", { cls: "clickable-icon" });
        this.pinButton.addEventListener("click", () => this.togglePin());
        const more = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Options" } });
        setIcon(more, "more-horizontal");
        more.addEventListener("click", (evt) => this.showMenu(evt));
        this.headerEl = bar.createDiv({ cls: "gnosis-related-header" });
        this.bodyEl = root.createDiv({ cls: "gnosis-related-body" });
        this.drawPin();

        this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleFollow()));
        this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleFollow()));
        // A rebuilt or moved index changes every answer.
        this.unsubscribes.push(
            this.plugin.onIndexClosed(() => {
                this.follower.invalidate();
                void this.redraw();
            }),
        );
        await this.followActive();
    }

    override async onClose(): Promise<void> {
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
        }
        for (const unsubscribe of this.unsubscribes.splice(0)) {
            unsubscribe();
        }
    }

    private scheduleFollow(): void {
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
        }
        this.timer = window.setTimeout(() => {
            this.timer = null;
            void this.followActive();
        }, FOLLOW_DEBOUNCE_MS);
    }

    private async followActive(): Promise<void> {
        const file = this.app.workspace.getActiveFile();
        // Only notes: a canvas or a PDF has no place in a notes index.
        const path = file !== null && file.extension === "md" ? file.path : null;
        if (path !== null && path !== this.follower.path && !this.follower.pinned) {
            this.draw({ kind: "loading", path });
        }
        const state = await this.follower.follow(path);
        if (state !== null) {
            this.draw(state);
        }
    }

    private async redraw(): Promise<void> {
        const state = await this.follower.current();
        if (state !== null) {
            this.draw(state);
        }
    }

    private togglePin(): void {
        this.follower.pinned = !this.follower.pinned;
        this.drawPin();
        if (!this.follower.pinned) {
            // Unpinned: catch up with whatever is open now.
            void this.followActive();
        }
    }

    private drawPin(): void {
        const pinned = this.follower.pinned;
        setIcon(this.pinButton, pinned ? "pin-off" : "pin");
        this.pinButton.setAttribute("aria-label", pinned ? "Unpin: follow the active note" : "Pin to this note");
        this.pinButton.toggleClass("is-active", pinned);
    }

    private showMenu(evt: MouseEvent): void {
        const menu = new Menu();
        menu.addItem((item) =>
            item
                .setTitle("Include notes it already links to")
                .setChecked(this.plugin.settings.relatedIncludeLinked)
                .onClick(async () => {
                    this.plugin.settings.relatedIncludeLinked = !this.plugin.settings.relatedIncludeLinked;
                    await this.plugin.saveSettings();
                    this.follower.invalidate();
                    await this.redraw();
                }),
        );
        menu.addItem((item) =>
            item
                .setTitle("Refresh")
                .setIcon("refresh-cw")
                .onClick(() => {
                    this.follower.invalidate();
                    void this.redraw();
                }),
        );
        menu.showAtMouseEvent(evt);
    }

    private drawHeader(path: string): void {
        this.headerEl.empty();
        const folder = path.split("/").slice(0, -1).join(" › ");
        if (folder !== "") {
            this.headerEl.createDiv({ cls: "gnosis-related-folder", text: folder });
        }
        this.headerEl.createDiv({ cls: "gnosis-related-title", text: noteName({ path } as Hit) });
    }

    private message(text: string): HTMLElement {
        return this.bodyEl.createDiv({ cls: "gnosis-related-message", text });
    }

    private draw(state: RelatedState): void {
        this.bodyEl.empty();
        if ("path" in state) {
            this.drawHeader(state.path);
        } else if (state.kind === "no-note") {
            this.headerEl.empty();
        }
        switch (state.kind) {
            case "no-note":
                this.message("Open a note to see the notes most like it.");
                return;
            case "loading":
                this.message("Finding related notes…");
                return;
            case "no-index": {
                this.message(`There is no index in ${state.dir} yet.`);
                const button = this.bodyEl.createEl("button", { text: "Build index", cls: "mod-cta" });
                button.addEventListener("click", () => void this.plugin.buildIndex());
                return;
            }
            case "unreadable":
                this.message(`The index cannot be read: ${state.message}.`);
                return;
            case "stale":
                this.message(
                    "This note is newer than the index, so it has nothing to compare yet. Update the " +
                        "index to include it.",
                );
                return;
            case "empty":
                this.message(
                    this.plugin.settings.relatedIncludeLinked
                        ? "Nothing related found."
                        : "Nothing related that it does not already link to.",
                );
                return;
            case "ready":
                this.drawList(state.hits);
                return;
        }
    }

    private drawList(hits: Hit[]): void {
        const list = this.bodyEl.createDiv({ cls: "gnosis-related-list" });
        for (const hit of hits) {
            const row = list.createDiv({ cls: "gnosis-related-row" });
            const line = row.createDiv({ cls: "gnosis-related-line" });
            const toggle = line.createEl("button", {
                cls: "clickable-icon gnosis-related-toggle",
                attr: { "aria-label": "Show why", "aria-expanded": "false" },
            });
            setIcon(toggle, "chevron-right");
            line.createSpan({ cls: "gnosis-hit-score", text: formatScore(hit.score) });
            const link = line.createEl("a", { cls: "gnosis-related-link", text: noteName(hit), href: "#" });
            link.addEventListener("click", (evt) => {
                evt.preventDefault();
                this.openHit(hit, evt);
            });
            // A middle click opens a new tab, as everywhere else in Obsidian.
            link.addEventListener("auxclick", (evt) => {
                if (evt.button === 1) {
                    evt.preventDefault();
                    this.openHit(hit, evt);
                }
            });

            // Why it is related: the passage that matched, under its heading.
            const detail = row.createDiv({ cls: "gnosis-related-detail" });
            detail.hide();
            if (hit.heading_path !== "") {
                detail.createDiv({ cls: "gnosis-hit-detail", text: hit.heading_path });
            }
            detail.createDiv({ cls: "gnosis-related-snippet", text: hitSnippet(hit, 400) });
            toggle.addEventListener("click", () => {
                const open = !detail.isShown();
                detail.toggle(open);
                toggle.setAttribute("aria-expanded", String(open));
                row.toggleClass("is-open", open);
            });
        }
    }

    // Not `open`: that is `View.open`, which Obsidian calls to show the view.
    private openHit(hit: Hit, evt: MouseEvent): void {
        const file: TFile | null = resolveHit(this.app, hit);
        if (file === null) {
            this.message(`${noteName(hit)} is in the index but not in the vault — update the index.`);
            return;
        }
        void this.app.workspace.getLeaf(paneFor(evt, this.plugin.settings.modOpen)).openFile(file);
    }
}
