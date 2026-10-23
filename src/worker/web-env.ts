//! Make the worker look like the browser worker it is, before transformers.js
//! decides otherwise.
//!
//! transformers.js picks its whole I/O strategy at import time from one test:
//! `process.release.name === "node"`. Obsidian is Electron, and if a worker
//! inherits Node integration that test passes, so the *web* build would take
//! its Node branches — whose filesystem and runtime are empty stubs in that
//! build — and fail on the first model load. Hiding `process` from it is what
//! keeps it on the web path, which is the path that actually works here.
//!
//! This module must be imported before transformers.js. ES module evaluation
//! follows import order, and esbuild preserves it.

const scope = self as unknown as { process?: unknown };
if (typeof scope.process !== "undefined") {
    scope.process = undefined;
}

export {};
