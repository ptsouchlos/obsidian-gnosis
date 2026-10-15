//! Loading a portable gnosis artifact out of the vault.
//!
//! The artifact is a manifest plus shards that `gnosis export` wrote. Nothing
//! here interprets them: the bytes go straight into the WebAssembly module,
//! which verifies each shard against the manifest's hash and refuses to open a
//! partially synced one — exactly the state a vault being synced on two
//! machines can be caught in.

import type { App } from "obsidian";
import init, { Index } from "../vendor/gnosis-wasm/gnosis_wasm.js";
import wasmBytes from "../vendor/gnosis-wasm/gnosis_wasm_bg.wasm";

/** The manifest, as far as loading needs to know. */
interface Manifest {
    shards: { name: string }[];
}

export const MANIFEST_NAME = "manifest.json";

/** Raised when the vault holds no artifact, which is an ordinary state. */
export class ArtifactMissing extends Error {
    constructor(readonly dir: string) {
        super(`no gnosis index at ${dir}/${MANIFEST_NAME}`);
        this.name = "ArtifactMissing";
    }
}

let started: Promise<unknown> | null = null;

/**
 * Instantiate the module once per app session.
 *
 * Asynchronously, deliberately: the glue also offers `initSync`, but Chromium
 * — which Obsidian is — refuses to compile a module this size synchronously on
 * the main thread, and that refusal would surface as a plugin that fails to
 * load rather than as a slow one.
 */
function startWasm(): Promise<unknown> {
    started ??= init({ module_or_path: wasmBytes });
    return started;
}

/** Join vault-relative path segments the way the adapter expects them. */
function join(dir: string, name: string): string {
    const base = dir.replace(/\/+$/, "");
    return base === "" ? name : `${base}/${name}`;
}

/**
 * Read the artifact in `dir` and open it.
 *
 * Shards are read through the vault adapter rather than `fs`, so this works
 * wherever Obsidian does — including on mobile, where there is no filesystem
 * to reach for. They are read in parallel: on a sharded artifact the read is
 * the slow part, and the manifest already names every file.
 */
export async function openArtifact(app: App, dir: string): Promise<Index> {
    const adapter = app.vault.adapter;
    const manifestPath = join(dir, MANIFEST_NAME);
    if (!(await adapter.exists(manifestPath))) {
        throw new ArtifactMissing(dir);
    }

    const manifestJson = await adapter.read(manifestPath);
    let manifest: Manifest;
    try {
        manifest = JSON.parse(manifestJson) as Manifest;
    } catch (cause) {
        throw new Error(`${manifestPath} is not valid JSON`, { cause });
    }
    if (!Array.isArray(manifest.shards) || manifest.shards.length === 0) {
        throw new Error(`${manifestPath} lists no shards`);
    }

    const shards = new Map<string, Uint8Array>();
    await Promise.all(
        manifest.shards.map(async (shard) => {
            const path = join(dir, shard.name);
            if (!(await adapter.exists(path))) {
                throw new Error(
                    `${manifestPath} lists shard '${shard.name}', which is not in ${dir} — ` +
                        `re-run \`gnosis export\``,
                );
            }
            shards.set(shard.name, new Uint8Array(await adapter.readBinary(path)));
        }),
    );

    await startWasm();
    return Index.open(manifestJson, shards as unknown as Map<unknown, unknown>);
}
