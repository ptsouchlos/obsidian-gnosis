# Test fixtures

`vault/` is a five-document vault with a gnosis artifact in `.gnosis/artifact`,
the folder the plugin defaults to. The artifact is the one
`gnosis`'s own `cargo test -p gnosis-wasm --test fixture` writes, so it is
produced by the same shard writer `gnosis export` uses rather than by hand.

`notes/sample.pdf` is listed by the artifact but is present on disk only for
the artifact: the plugin walks markdown and images, so a rebuild or replace
ignores it — which is the state the rebuild and replace warnings exist to
name.

`work/planner.md` is **deliberately absent** while the artifact still lists it.
That is the state a vault reaches whenever a note is deleted or renamed after
the index was built, and the plugin has to report it rather than fail silently.
