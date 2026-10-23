//! Loading a portable gnosis artifact out of the vault.
//!
//! The artifact is a manifest plus shards that `gnosis export` wrote. Nothing
//! here interprets them: the bytes go straight into the WebAssembly module,
//! which verifies each shard against the manifest's hash and refuses to open a
//! partially synced one — exactly the state a vault being synced on two
//! machines can be caught in.

import type { App } from "obsidian";
import init, { Index, artifactFormatVersion } from "../vendor/gnosis-wasm/gnosis_wasm.js";
import wasmBytes from "../vendor/gnosis-wasm/gnosis_wasm_bg.wasm";

/** The manifest, as far as the plugin needs to know. */
export interface Manifest {
    shards: { name: string; hash: string }[];
}

/** An artifact as bytes: what is on disk, before anything opens it. */
export interface RawArtifact {
    manifestJson: string;
    shards: Map<string, Uint8Array>;
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
export function startWasm(): Promise<unknown> {
    started ??= init({ module_or_path: wasmBytes });
    return started;
}

/** Join vault-relative path segments the way the adapter expects them. */
export function join(dir: string, name: string): string {
    const base = dir.replace(/\/+$/, "");
    return base === "" ? name : `${base}/${name}`;
}

/**
 * Whether an index is in a format this build cannot open, and so has to be
 * rebuilt rather than reused: `{ found, supported }` if it is, else `null`.
 * The module has to be started first, since it knows the version it reads.
 */
export async function olderFormat(manifestJson: string): Promise<{ found: number; supported: number } | null> {
    await startWasm();
    let found: unknown;
    try {
        found = (JSON.parse(manifestJson) as { format_version?: unknown }).format_version;
    } catch {
        return null;
    }
    const supported = artifactFormatVersion();
    return typeof found === "number" && found !== supported ? { found, supported } : null;
}

/** What the reader is told about an index in another format. */
export function olderFormatMessage(format: { found: number; supported: number }): string {
    return (
        `this index is in format v${format.found}, and this version reads v${format.supported} — ` +
        `run "Rebuild index" to rebuild it`
    );
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
    const raw = await readArtifact(app, dir);
    const format = await olderFormat(raw.manifestJson);
    if (format !== null) {
        throw new Error(olderFormatMessage(format));
    }
    return Index.open(raw.manifestJson, raw.shards);
}

/** Parse a manifest's JSON, naming the file when it is not JSON at all. */
export function parseManifest(json: string, where: string): Manifest {
    try {
        return JSON.parse(json) as Manifest;
    } catch (cause) {
        throw new Error(`${where} is not valid JSON`, { cause });
    }
}

/**
 * Read the artifact in `dir` as bytes, without verifying or opening it.
 *
 * Throws `ArtifactMissing` when there is no manifest, which callers treat as
 * an ordinary state.
 */
export async function readArtifact(app: App, dir: string): Promise<RawArtifact> {
    const adapter = app.vault.adapter;
    const manifestPath = join(dir, MANIFEST_NAME);
    if (!(await adapter.exists(manifestPath))) {
        throw new ArtifactMissing(dir);
    }

    const manifestJson = await adapter.read(manifestPath);
    const manifest = parseManifest(manifestJson, manifestPath);
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
                        `if it is still syncing, wait; otherwise run "Build index" or \`gnosis export\``,
                );
            }
            shards.set(shard.name, new Uint8Array(await adapter.readBinary(path)));
        }),
    );

    return { manifestJson, shards };
}
