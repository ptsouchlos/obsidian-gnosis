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
import { mapLayout, type MapPoint } from "./layout.js";

export const RELATED_VIEW = "gnosis-related";

/** Long enough to skip the notes passed through while switching quickly. */
const FOLLOW_DEBOUNCE_MS = 200;

/** The map's coordinate space: a disc of this radius, with room around it for labels. */
const MAP_RADIUS = 100;
const MAP_EXTENT = 116;

/** Hovering a dot lights its row, and the other way round. */
function linkHover(dots: SVGElement[], rows: HTMLElement[]): void {
    dots.forEach((dot, i) => {
        const row = rows[i]!;
        const on = (lit: boolean) => {
            dot.classList.toggle("is-hovered", lit);
            row.toggleClass("is-hovered", lit);
        };
        for (const el of [dot, row]) {
            el.addEventListener("mouseenter", () => on(true));
            el.addEventListener("mouseleave", () => on(false));
            el.addEventListener("focusin", () => on(true));
            el.addEventListener("focusout", () => on(false));
        }
    });
}

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
            case "ready": {
                const points = state.pairs === null ? null : mapLayout(state.hits.map((h) => h.score), state.pairs);
                const dots = points === null ? null : this.drawMap(state.path, state.hits, points);
                const rows = this.drawList(state.hits);
                if (dots !== null) {
                    linkHover(dots, rows);
                }
                return;
            }
        }
    }

    /**
     * The map: the open note at the center, each related note a dot whose
     * distance is its score and whose direction puts alike notes together
     * (see `layout.ts`). The list below is the accessible form of the same data.
     */
    private drawMap(path: string, hits: Hit[], points: MapPoint[]): SVGElement[] {
        const svg = this.bodyEl.createSvg("svg", {
            cls: "gnosis-related-map",
            attr: { viewBox: `${-MAP_EXTENT} ${-MAP_EXTENT} ${2 * MAP_EXTENT} ${2 * MAP_EXTENT}`, role: "group" },
        });
        svg.setAttribute("aria-label", `Map of the notes most related to ${noteName({ path } as Hit)}`);
        for (const r of [0.33, 0.66, 1]) {
            svg.createSvg("circle", { cls: "gnosis-related-ring", attr: { r: r * MAP_RADIUS } });
        }
        svg.createSvg("circle", { cls: "gnosis-related-center", attr: { r: 5 } });

        return hits.map((hit, i) => {
            const { x, y } = points[i]!;
            const dot = svg.createSvg("g", {
                cls: "gnosis-related-dot",
                attr: {
                    transform: `translate(${(x * MAP_RADIUS).toFixed(2)} ${(y * MAP_RADIUS).toFixed(2)})`,
                    tabindex: "0",
                    role: "link",
                    "aria-label": `${noteName(hit)}, ${formatScore(hit.score)}`,
                },
            });
            dot.createSvg("title").textContent = noteName(hit);
            dot.createSvg("circle", { attr: { r: 3.5 } });
            dot.createSvg("text", { attr: { y: -6 } }).textContent = hit.score.toFixed(2);
            dot.addEventListener("click", (evt) => this.openHit(hit, evt));
            dot.addEventListener("keydown", (evt) => {
                if (evt.key === "Enter") {
                    this.openHit(hit, evt);
                }
            });
            return dot;
        });
    }

    private drawList(hits: Hit[]): HTMLElement[] {
        const list = this.bodyEl.createDiv({ cls: "gnosis-related-list" });
        return hits.map((hit) => {
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
            // Page preview, as for any link in Obsidian: the core plugin shows
            // it, with or without Cmd/Ctrl as its settings say for this panel.
            link.addEventListener("mouseover", (evt) => {
                const file = resolveHit(this.app, hit);
                if (file === null) {
                    return;
                }
                this.app.workspace.trigger("hover-link", {
                    event: evt,
                    source: RELATED_VIEW,
                    hoverParent: this,
                    targetEl: link,
                    linktext: file.path,
                    sourcePath: this.follower.path ?? "",
                });
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
            return row;
        });
    }

    // Not `open`: that is `View.open`, which Obsidian calls to show the view.
    private openHit(hit: Hit, evt: MouseEvent | KeyboardEvent): void {
        const file: TFile | null = resolveHit(this.app, hit);
        if (file === null) {
            this.message(`${noteName(hit)} is in the index but not in the vault — update the index.`);
            return;
        }
        void this.app.workspace.getLeaf(paneFor(evt, this.plugin.settings.modOpen)).openFile(file);
    }
}
