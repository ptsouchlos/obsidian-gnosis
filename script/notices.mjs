// Write THIRD_PARTY_NOTICES.md: every npm package `main.js` bundles, with the
// license text it ships.
//
// The list is what esbuild actually reads for the production build, the
// embedding workers included, so a dependency tree-shaken away is not listed
// and a new one cannot be missed.
//
//   node script/notices.mjs           rewrite THIRD_PARTY_NOTICES.md
//   node script/notices.mjs --check   fail if it is out of date (npm test runs this)
//
// A bundled package that ships no license file needs one in script/notices/,
// named after the package (a scope's "/" as "__"), or this fails.
import esbuild from "esbuild";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOptions } from "../esbuild.config.mjs";

const OUT = "THIRD_PARTY_NOTICES.md";
const OVERRIDES = "script/notices";
const LICENSE_FILE = /^(licen[cs]e|copying)([-._].*)?$/i;
const NOTICE_FILE = /^notice(\..*)?$/i;

// A path into another package left in a prebuilt dist — a bundler's region
// comment, or a source map's `sources` — as npm (`node_modules/<name>/`) or
// pnpm (`node_modules/.pnpm/<name>@<version>/node_modules/<name>/`) lays it out.
const INLINED = /node_modules\/(?:\.pnpm\/[^/\s"'`]+@([^/@\s"'`]+)\/node_modules\/)?((?:@[\w.-]+\/)?[\w.-]+)\//g;

/** The package directory an input path is in, or null for the plugin's own files. */
function packageDir(input) {
    const at = input.lastIndexOf("node_modules/");
    if (at < 0) {
        return null;
    }
    const rest = input.slice(at + "node_modules/".length).split("/");
    const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    return input.slice(0, at) + "node_modules/" + name;
}

function readVersion(dir) {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
}

/**
 * Packages a bundled file carries inside it, which esbuild never reads: a
 * prebuilt dist that was itself bundled from other packages. Each is resolved
 * to its installed copy, which must be the version that was inlined.
 */
function inlinedPackages(input, dir) {
    const texts = [readFileSync(input, "utf8")];
    if (existsSync(`${input}.map`)) {
        texts.push(JSON.parse(readFileSync(`${input}.map`, "utf8")).sources.join("\n"));
    }
    const found = new Map();
    for (const text of texts) {
        for (const [, version, name] of text.matchAll(INLINED)) {
            found.set(name, version ?? found.get(name));
        }
    }
    const dirs = [];
    for (const [name, version] of found) {
        const installed = [join(dir, "node_modules", name), join("node_modules", name)].find(existsSync);
        if (!installed) {
            throw new Error(`${input} inlines ${name}, which is not installed`);
        }
        if (version && readVersion(installed) !== version) {
            throw new Error(`${input} inlines ${name} ${version}, but ${readVersion(installed)} is installed`);
        }
        dirs.push(installed);
    }
    return dirs;
}

async function bundledPackages() {
    const inputs = new Set();
    const result = await esbuild.build({
        ...buildOptions({ production: true, inputs }),
        write: false,
        metafile: true,
        logLevel: "warning",
    });
    for (const input of Object.keys(result.metafile.inputs)) {
        inputs.add(input);
    }
    const dirs = new Set();
    for (const input of inputs) {
        const dir = packageDir(input);
        if (dir) {
            dirs.add(dir);
            for (const inlined of inlinedPackages(input, dir)) {
                dirs.add(inlined);
            }
        }
    }
    return [...dirs];
}

function repositoryUrl(pkg) {
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    if (!repo) {
        return null;
    }
    return repo.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://");
}

function licenseTexts(dir, name) {
    const files = readdirSync(dir).sort();
    const texts = files.filter((f) => LICENSE_FILE.test(f)).map((f) => readFileSync(join(dir, f), "utf8"));
    if (texts.length === 0) {
        const override = join(OVERRIDES, `${name.replace("/", "__")}.txt`);
        if (!existsSync(override)) {
            throw new Error(`${name} ships no license file; add one at ${override}`);
        }
        texts.push(readFileSync(override, "utf8"));
    }
    // Apache-2.0 asks that a NOTICE file travel with the code too.
    for (const f of files.filter((f) => NOTICE_FILE.test(f))) {
        texts.push(readFileSync(join(dir, f), "utf8"));
    }
    return texts;
}

function render(dirs) {
    const packages = dirs
        .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) }))
        .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name, "en"));
    const missing = packages.flatMap(({ dir, pkg }) => {
        try {
            licenseTexts(dir, pkg.name);
            return [];
        } catch (e) {
            return [e.message];
        }
    });
    if (missing.length > 0) {
        throw new Error(missing.join("\n"));
    }
    const lines = [
        "# Third-party notices",
        "",
        "`main.js` bundles the npm packages below, each followed by the license text it",
        "ships. The gnosis query client, compiled to WebAssembly and also bundled, is",
        "MIT; it and the Rust crates it links are listed in",
        "[`vendor/gnosis-wasm/THIRD_PARTY_NOTICES.txt`](vendor/gnosis-wasm/THIRD_PARTY_NOTICES.txt).",
        "",
        "Generated by `npm run notices` from what the build reads; `npm test` fails",
        "when it is out of date.",
        "",
    ];
    for (const { dir, pkg } of packages) {
        const repo = repositoryUrl(pkg);
        lines.push(`## ${pkg.name} ${pkg.version}`, "");
        lines.push(`License: ${pkg.license ?? "see below"}${repo ? ` · <${repo}>` : ""}`, "");
        for (const text of licenseTexts(dir, pkg.name)) {
            lines.push("````text", text.replace(/\r\n/g, "\n").trimEnd(), "````", "");
        }
    }
    return lines.join("\n");
}

const notices = render(await bundledPackages());
if (process.argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== notices) {
        console.error(`${OUT} is out of date: run \`npm run notices\` and commit it.`);
        process.exit(1);
    }
} else {
    writeFileSync(OUT, notices);
}
