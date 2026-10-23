//! Writing a finished build where the plugin and the CLI both read it.
//!
//! The same order `gnosis export` uses: shards first, the manifest last, then
//! stale shards removed. The manifest is what names and checksums the shards,
//! so a write interrupted part way leaves either the old manifest, or a new
//! one whose shards are all present — and a reader caught between the two
//! sees a hash mismatch and refuses to open, rather than mixing two indexes.
//!
//! Only shards whose bytes changed are written. Shard names are stable and an
//! unchanged note keeps its bytes, so an ordinary rebuild rewrites a file or
//! two; rewriting everything would have a file syncer upload the whole index
//! after every edit.

import type { DataAdapter } from "obsidian";
import { MANIFEST_NAME, join, parseManifest, type Manifest, type RawArtifact } from "../artifact.js";

export interface Written {
    /** True when the live index already held exactly this, so nothing was written. */
    upToDate: boolean;
    written: number;
    unchanged: number;
    removed: number;
    bytesWritten: number;
}

/** SHA-256 of a string, hex: how this device recognizes a manifest it wrote. */
export async function manifestHash(manifestJson: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifestJson));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** Two manifests equal in everything but when they were made. */
function sameContent(a: Manifest, b: Manifest): boolean {
    const strip = (m: Manifest) => JSON.stringify({ ...m, created_unix: 0 });
    return strip(a) === strip(b);
}

export async function writeArtifact(adapter: DataAdapter, dir: string, artifact: RawArtifact): Promise<Written> {
    const manifestPath = join(dir, MANIFEST_NAME);
    const next = parseManifest(artifact.manifestJson, "the built manifest");
    const previous = (await adapter.exists(manifestPath))
        ? parseManifest(await adapter.read(manifestPath), manifestPath)
        : null;
    const had = new Map((previous?.shards ?? []).map((s) => [s.name, s.hash]));

    // A rebuild of an unchanged vault differs from the live index only in its
    // timestamp. Rewriting the manifest for that would still be a file for
    // every syncer to upload, for nothing.
    // Only if every shard is actually there: a half-synced folder can hold the
    // right manifest beside a missing shard, and that is exactly what a build
    // should repair.
    const present = async () => {
        for (const shard of next.shards) {
            if (!(await adapter.exists(join(dir, shard.name)))) return false;
        }
        return true;
    };
    if (previous !== null && sameContent(previous, next) && (await present())) {
        return { upToDate: true, written: 0, unchanged: next.shards.length, removed: 0, bytesWritten: 0 };
    }

    if (!(await adapter.exists(dir))) {
        await adapter.mkdir(dir);
    }

    const result: Written = { upToDate: false, written: 0, unchanged: 0, removed: 0, bytesWritten: 0 };
    for (const shard of next.shards) {
        const path = join(dir, shard.name);
        if (had.get(shard.name) === shard.hash && (await adapter.exists(path))) {
            result.unchanged++;
            continue;
        }
        const body = artifact.shards.get(shard.name);
        if (body === undefined) {
            throw new Error(`the build has no bytes for '${shard.name}'`);
        }
        await adapter.writeBinary(path, toArrayBuffer(body));
        result.written++;
        result.bytesWritten += body.byteLength;
    }

    await adapter.write(manifestPath, artifact.manifestJson);

    const current = new Set(next.shards.map((s) => s.name));
    for (const name of had.keys()) {
        const path = join(dir, name);
        if (!current.has(name) && (await adapter.exists(path))) {
            await adapter.remove(path);
            result.removed++;
        }
    }
    return result;
}

/**
 * Move the artifact from one folder to another, without a moment where
 * neither holds a working index.
 *
 * Copied, not renamed: shards first and the manifest last, as a build
 * writes them, so a syncer or a reader never sees a manifest naming shards
 * that are not there yet. The caller verifies the copy opens before calling
 * `removeArtifact` on the old one.
 */
export async function copyArtifact(adapter: DataAdapter, from: string, to: string): Promise<void> {
    const manifestPath = join(from, MANIFEST_NAME);
    const manifest = parseManifest(await adapter.read(manifestPath), manifestPath);
    if (await adapter.exists(join(to, MANIFEST_NAME))) {
        throw new Error(`there is already an index in ${to}`);
    }
    if (!(await adapter.exists(to))) {
        await adapter.mkdir(to);
    }
    for (const shard of manifest.shards) {
        await adapter.copy(join(from, shard.name), join(to, shard.name));
    }
    await adapter.copy(manifestPath, join(to, MANIFEST_NAME));
}

/**
 * Remove an artifact: its manifest first, so nothing reads a half-removed
 * index, then its shards, then the folder if nothing else is in it. A parent
 * like `.gnosis/` is left alone — the CLI keeps its database there.
 */
export async function removeArtifact(adapter: DataAdapter, dir: string): Promise<void> {
    const manifestPath = join(dir, MANIFEST_NAME);
    if (!(await adapter.exists(manifestPath))) {
        return;
    }
    const manifest = parseManifest(await adapter.read(manifestPath), manifestPath);
    await adapter.remove(manifestPath);
    for (const shard of manifest.shards) {
        const path = join(dir, shard.name);
        if (await adapter.exists(path)) {
            await adapter.remove(path);
        }
    }
    const left = await adapter.list(dir);
    if (left.files.length === 0 && left.folders.length === 0) {
        // `recursive`, though it is empty: the desktop adapter's
        // non-recursive form is a plain `rm`, which refuses any directory.
        await adapter.rmdir(dir, true);
    }
}
