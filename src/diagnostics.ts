//! What the diagnostics report knows, and how it is written.
//!
//! Everything here is held in memory for this session only: nothing is
//! persisted, so a report describes what happened since Obsidian started.
//! It never holds note contents or search queries — the plugin records only
//! its own events, timings and counts. Paths can reach it inside an error
//! message, which is what redaction is for.

import type { IndexStatus, ModelStatus } from "./status.js";

/** Where "Generate report" writes, at the vault root so it is easy to find and attach. */
export const REPORT_PATH = "gnosis-report.md";

export interface LogEvent {
    at: number;
    kind: "error" | "build" | "model" | "index";
    message: string;
}

/** The last build of this session, whatever became of it. */
export interface BuildRecord {
    startedAt: number;
    durationMs: number;
    /** "not written": built, then the reader kept an index that changed meanwhile. */
    outcome: "indexed" | "already up to date" | "canceled" | "not started" | "not written" | "failed";
    notes: number | null;
    chunks: number | null;
    chunksEmbedded: number | null;
    notesReused: number | null;
    shardsWritten: number | null;
    error: string | null;
}

/** The last time this session loaded a model. */
export interface ModelLoadRecord {
    model: string;
    startedAt: number;
    durationMs: number | null;
    outcome: "loading" | "loaded" | "failed";
    error: string | null;
}

/** Enough to say what went wrong without asking the reader to reproduce it. */
export class Diagnostics {
    private readonly events: LogEvent[] = [];
    lastBuild: BuildRecord | null = null;
    modelLoad: ModelLoadRecord | null = null;

    constructor(
        private readonly capacity = 100,
        readonly now: () => number = () => Date.now(),
    ) {}

    record(kind: LogEvent["kind"], message: string): void {
        this.events.push({ at: this.now(), kind, message });
        if (this.events.length > this.capacity) {
            this.events.shift();
        }
    }

    /** Oldest first. */
    recent(): readonly LogEvent[] {
        return this.events;
    }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces vault paths with stable tokens: the same note is the same
 * `note-N` everywhere in one report, numbered in order of first appearance.
 *
 * It matches a note's path, its path without the extension, and its file
 * name — the forms a path takes in the plugin's own messages. A bare title
 * or folder name is not matched, because a folder called "Notes" or a note
 * called "Build" would otherwise eat ordinary words; the plugin never puts
 * either in a message on its own.
 */
export class Redactor {
    private readonly owner = new Map<string, string>();
    private readonly tokens = new Map<string, string>();
    private readonly pattern: RegExp | null;

    constructor(paths: readonly string[]) {
        for (const path of paths) {
            const name = path.split("/").pop()!;
            const forms = [path, name];
            if (path.includes("/")) {
                forms.push(path.replace(/\.[^./]+$/, ""));
            }
            for (const form of forms) {
                // A file name two folders share stays with the first; both
                // are redacted either way, which is what matters.
                if (!this.owner.has(form)) {
                    this.owner.set(form, path);
                }
            }
        }
        const forms = [...this.owner.keys()].sort((a, b) => b.length - a.length);
        this.pattern = forms.length === 0 ? null : new RegExp(forms.map(escape).join("|"), "g");
    }

    text(s: string): string {
        if (this.pattern === null) {
            return s;
        }
        return s.replace(this.pattern, (form) => {
            const path = this.owner.get(form)!;
            let token = this.tokens.get(path);
            if (token === undefined) {
                token = `note-${this.tokens.size + 1}`;
                this.tokens.set(path, token);
            }
            return token;
        });
    }
}

export interface ReportInput {
    generatedAt: number;
    pluginVersion: string;
    obsidianVersion: string;
    platform: string;
    artifactDir: string;
    index: IndexStatus;
    model: ModelStatus;
    settings: object;
    diagnostics: Diagnostics;
    /** Null when the reader turned redaction off. */
    redactor: Redactor | null;
}

const when = (ms: number) => new Date(ms).toISOString();
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The report, as markdown. */
export function renderReport(input: ReportInput): string {
    const r = (s: string) => (input.redactor === null ? s : input.redactor.text(s));
    const lines: string[] = [
        "# Gnosis report",
        "",
        `Generated ${when(input.generatedAt)}. It holds no note contents and no search queries` +
            (input.redactor === null
                ? ". Redaction is off: note paths appear as they are."
                : "; note paths are replaced by tokens (note-1, note-2, …)."),
        "",
        "## Versions",
        "",
        `- Gnosis ${input.pluginVersion}`,
        `- Obsidian ${input.obsidianVersion}`,
        `- Platform: ${input.platform}`,
        "",
        "## Index",
        "",
        `- State: ${input.index.label}${input.index.detail === "" ? "" : ` — ${r(input.index.detail)}`}`,
        `- Folder: ${input.artifactDir}`,
    ];
    if (input.index.notes !== null && input.index.chunks !== null) {
        lines.push(`- ${input.index.notes} notes, ${input.index.chunks} chunks`);
    }
    if (input.index.builtAt !== null) {
        lines.push(`- Last updated: ${when(input.index.builtAt)}`);
    }
    if (input.index.model !== null) {
        lines.push(`- Model: ${input.index.model}`);
    }
    if (input.index.writtenBy !== null) {
        lines.push(`- Built by: ${input.index.writtenBy}`);
    }

    lines.push(
        "",
        "## Model",
        "",
        `- ${input.model.label} · ${r(input.model.detail)}`,
        `- ${input.model.model}`,
    );
    const load = input.diagnostics.modelLoad;
    if (load !== null) {
        lines.push(
            `- Last load: ${load.model}, ${load.outcome}` +
                (load.durationMs === null ? "" : ` in ${seconds(load.durationMs)}`) +
                (load.error === null ? "" : ` — ${r(load.error)}`),
        );
    }

    lines.push("", "## Settings", "", "| Setting | Value |", "| --- | --- |");
    for (const [key, value] of Object.entries(input.settings)) {
        lines.push(`| ${key} | ${JSON.stringify(value)} |`);
    }

    lines.push("", "## Last build this session", "");
    const build = input.diagnostics.lastBuild;
    if (build === null) {
        lines.push("None.");
    } else {
        lines.push(`- Started ${when(build.startedAt)}, ${build.outcome} after ${seconds(build.durationMs)}`);
        if (build.notes !== null) {
            lines.push(
                `- ${build.notes} notes, ${build.chunks} chunks: ${build.chunksEmbedded} embedded, ` +
                    `${build.notesReused} notes unchanged`,
            );
        }
        if (build.shardsWritten !== null) {
            lines.push(`- ${build.shardsWritten} shard(s) written`);
        }
        if (build.error !== null) {
            lines.push(`- Error: ${r(build.error)}`);
        }
    }

    lines.push("", "## Recent events", "");
    const events = input.diagnostics.recent();
    if (events.length === 0) {
        lines.push("None.");
    }
    for (const event of events) {
        lines.push(`- ${when(event.at)} · ${event.kind} · ${r(event.message)}`);
    }
    lines.push("");
    return lines.join("\n");
}
