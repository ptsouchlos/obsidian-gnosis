//! The same plugin against a real vault and a real artifact.
//!
//! The fixture vault proves the wiring; it cannot prove that an index a model
//! actually built, over notes someone actually wrote, answers the queries a
//! reader would type. Point this at a vault with `gnosis export --out
//! .gnosis/artifact` already run in it:
//!
//!   GNOSIS_VAULT=/path/to/vault npm test
//!
//! Skipped — not failed — when that is unset, because most runs have no vault
//! to point at and a skipped test says so honestly.

import assert from "node:assert/strict";
import test from "node:test";

import { App, TFile, notices, openedModals } from "./stubs/obsidian.js";
import GnosisPlugin from "../src/main.js";
import type { Hit } from "../src/types.js";

const vault = process.env["GNOSIS_VAULT"];
const options = vault === undefined ? { skip: "set GNOSIS_VAULT to a vault with an artifact" } : {};

async function load(root: string) {
    notices.length = 0;
    openedModals.length = 0;
    const app = new App(root);
    const plugin = new GnosisPlugin(app as never, { id: "gnosis", version: "0.0.0-test" } as never);
    await plugin.onload();
    return { app, plugin };
}

async function waitFor(what: string, done: () => boolean, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}: ${JSON.stringify(notices)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function run(plugin: GnosisPlugin, id: string): void {
    const commands = (
        plugin as never as {
            commands: Map<string, { callback?: () => void; checkCallback?: (c: boolean) => boolean }>;
        }
    ).commands;
    const command = commands.get(id);
    assert.ok(command, `no command '${id}'`);
    if (command.callback) {
        command.callback();
    } else {
        assert.equal(command.checkCallback!(false), true);
    }
}

test("a real vault's index loads and answers", options, async () => {
    const { plugin } = await load(vault!);
    const lines = await plugin.describeIndex();
    assert.match(lines[0]!, /^[\d,]+ documents, [\d,]+ chunks$/, `got ${JSON.stringify(lines)}`);
    console.log(`  ${lines.join("\n  ")}`);
});

/**
 * Every result must resolve to a file that is actually there. This is the
 * assertion the fixture cannot make: it catches a whole class of path bug —
 * a vault indexed under a subfolder, a separator difference, a stale export —
 * that only shows up against a real vault's layout.
 */
test("every result resolves to a file in the vault", options, async () => {
    const { app, plugin } = await load(vault!);
    run(plugin, "search");
    await waitFor("the search modal", () => openedModals.length > 0);
    const modal = openedModals.at(-1)!;

    const queries = ["the", "note", "a"];
    let checked = 0;
    for (const query of queries) {
        for (const hit of modal.type(query) as Hit[]) {
            checked += 1;
            assert.ok(
                app.vault.getFileByPath(hit.path) !== null,
                `'${hit.path}' is in the index but not in the vault`,
            );
        }
    }
    assert.ok(checked > 0, "the vault's index returned nothing for any query");
    console.log(`  resolved ${checked} results`);
});

test("related notes come back for a real note", options, async () => {
    const { app, plugin } = await load(vault!);
    run(plugin, "search");
    await waitFor("the search modal", () => openedModals.length > 0);
    const first = (openedModals.at(-1)!.type("the") as Hit[])[0];
    assert.ok(first, "nothing to ask about");

    app.workspace.activeFile = new TFile(first.path, first.path.split("/").pop()!);
    run(plugin, "related");
    await waitFor("the related modal", () => openedModals.length > 1 || notices.length > 0);

    assert.deepEqual(notices, [], "related should not have needed to explain itself");
    const related = openedModals.at(-1)!.type("") as Hit[];
    assert.ok(related.length > 0, `nothing related to ${first.path}`);
    assert.ok(
        !related.some((h) => h.path === first.path),
        "a note is never related to itself",
    );
    console.log(`  ${first.path} -> ${related.slice(0, 3).map((h) => h.path).join(", ")}`);
});
