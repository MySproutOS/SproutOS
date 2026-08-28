# sprout-node

The narrow asynchronous N-API boundary between the TypeScript ECS worker and `sprout-core`.
`applyTemplate` accepts the canonical protocol request plus a content-addressed plugin reference;
the Rust core downloads it anonymously, verifies the exact keyless signature, runs it through the
native isolation provider, and validates its reported diff.

The addon contains no Git, service provisioning, commit, push, or deployment logic. Those stay in
the parent worker, which is the only process that holds GitHub and control-plane credentials.

Production ships exactly `sprout-node.linux-arm64-gnu.node`. The loader rejects musl, x86, and
unrecognized platforms instead of trying an ABI-adjacent binary.
