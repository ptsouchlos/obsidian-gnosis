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
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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
