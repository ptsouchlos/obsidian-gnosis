# Test fixtures

`vault/` is a four-document vault with a gnosis artifact in `.gnosis/artifact`,
the folder the plugin defaults to. The artifact is the one
`gnosis`'s own `cargo test -p gnosis-wasm --test fixture` writes, so it is
produced by the same shard writer `gnosis export` uses rather than by hand.

`work/planner.md` is **deliberately absent** while the artifact still lists it.
That is the state a vault reaches whenever a note is deleted or renamed after
the index was built, and the plugin has to report it rather than fail silently.
