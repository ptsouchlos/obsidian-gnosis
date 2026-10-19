//! The diagnostics report and resetting settings.
//!
//! The report's end-to-end case, after a real build, is in `build.test.ts`;
//! this file covers redaction on its own and the parts that need no build.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { App, notices, openedModals } from "./stubs/obsidian.js";
import GnosisPlugin from "../src/main.js";
import { Diagnostics, Redactor } from "../src/diagnostics.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

declare const GNOSIS_TEST_VAULT: string;

/** The fixture vault, copied: the report is written into it. */
async function load() {
    notices.length = 0;
    openedModals.length = 0;
    const root = join(mkdtempSync(join(tmpdir(), "gnosis-diagnostics-")), "vault");
    cpSync(GNOSIS_TEST_VAULT, root, { recursive: true });
    const app = new App(root);
    const plugin = new GnosisPlugin(app as never, { id: "gnosis", version: "0.0.0-test" } as never);
    await plugin.onload();
    return { root, app, plugin };
}

test("redaction gives each note one token, numbered as it first appears", () => {
    const redactor = new Redactor(["Book Notes/Atomic Habits.md", "Book Notes/Build.md", "Notes/Make Time.md"]);
    assert.equal(
        redactor.text("could not read Notes/Make Time.md, then Book Notes/Atomic Habits"),
        "could not read note-1, then note-2",
    );
    assert.equal(
        redactor.text("Atomic Habits.md again, and Notes/Make Time.md"),
        "note-2 again, and note-1",
        "a file name and a path are the same note",
    );
});

test("redaction leaves words that are only a note's title or a folder's name", () => {
    const redactor = new Redactor(["Book Notes/Build.md", "Notes/Index.md"]);
    assert.equal(
        redactor.text("Build index: 221 Notes in Book Notes"),
        "Build index: 221 Notes in Book Notes",
        "a bare title or folder is not a path; matching it would eat ordinary words",
    );
});

test("the event log keeps only the most recent events", () => {
    let now = 0;
    const log = new Diagnostics(3, () => now++);
    for (const message of ["a", "b", "c", "d"]) {
        log.record("error", message);
    }
    assert.deepEqual(
        log.recent().map((e) => e.message),
        ["b", "c", "d"],
    );
});

test("with redaction off the report names notes as they are, and a second report replaces the first", async () => {
    const { root, plugin } = await load();
    plugin.settings.redactReport = false;
    plugin.diagnostics.record("error", "document 'notes/sourdough.md' not found");
    await plugin.generateReport();
    await plugin.generateReport();

    const report = readFileSync(join(root, "gnosis-report.md"), "utf8");
    assert.match(report, /document 'notes\/sourdough\.md' not found/);
    assert.match(report, /Redaction is off/);
    assert.equal(report.match(/^# Gnosis report/gm)?.length, 1, "overwritten, not appended");
});

test("a search's query never reaches the report", async () => {
    const { root, plugin } = await load();
    (plugin as never as { commands: Map<string, { callback: () => void }> }).commands.get("search")!.callback();
    const deadline = Date.now() + 10_000;
    while (openedModals.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(openedModals[0]!.type("overnight proof").length > 0);

    await plugin.generateReport();
    const report = readFileSync(join(root, "gnosis-report.md"), "utf8");
    assert.match(report, /index · opened \.gnosis\/artifact in \d+ ms: \d+ documents/);
    assert.ok(!report.includes("overnight"), report);
});

test("resetting asks, restores defaults, and keeps the index's folder and semantic search", async () => {
    const { plugin } = await load();
    Object.assign(plugin.settings, {
        artifactDir: "Gnosis Index",
        semanticSearch: true,
        relatedPanelShown: true,
        strategy: "keyword",
        titleBonus: "off",
        limit: 35,
        showScores: true,
        redactReport: false,
    });
    const asked: string[][] = [];
    let answer = false;
    plugin.confirmReset = async (lines) => {
        asked.push(lines);
        return answer;
    };

    assert.equal(await plugin.resetSettings(), false);
    assert.equal(plugin.settings.strategy, "keyword", "declining changes nothing");

    answer = true;
    assert.equal(await plugin.resetSettings(), true);
    assert.deepEqual(plugin.settings, {
        ...DEFAULT_SETTINGS,
        artifactDir: "Gnosis Index",
        semanticSearch: true,
        relatedPanelShown: true,
    });
    assert.equal(asked.length, 2);
    assert.ok(asked[0]!.some((line) => line.includes("index and the downloaded model are kept")), JSON.stringify(asked));
    assert.deepEqual(await plugin.loadData(), plugin.settings, "and saved");
});
