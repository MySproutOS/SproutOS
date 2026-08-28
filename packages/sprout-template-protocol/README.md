# Sprout template protocol integration pin

This workspace package is a zero-logic facade over the canonical
`sprout-template-protocol` crate owned by
[`MySproutOS/Deployment-Templates`](https://github.com/MySproutOS/Deployment-Templates).
It re-exports the exact canonical API so `sprout-core`, `sprout-node`, and the CLI cannot acquire a
second wire implementation.

The Git dependency is pinned to canonical crate version `0.1.0` and exact commit
`fea608ab7c8da209354e89df5fa4a98ee2cfcf45`, the commit named by the annotated
[`protocol-v0.1.0`](https://github.com/MySproutOS/Deployment-Templates/releases/tag/protocol-v0.1.0)
release tag. The SHA-256 of
`git archive --format=tar fea608ab7c8da209354e89df5fa4a98ee2cfcf45` is
`90faf62f2a3e044a05adbc1d711cdad61fa7227eb33499112b23a48bf87c774b`.

The release's `sprout-template-protocol-0.1.0.crate` asset has SHA-256
`1d27782f98cff576d297a7817b2411c80d6baa0322ecf0c76e4e5b5bef3a322d`. Its attached GitHub OIDC
SLSA provenance from Actions run
[`33161882057`](https://github.com/MySproutOS/Deployment-Templates/actions/runs/33161882057) verifies
against `MySproutOS/Deployment-Templates` with `gh attestation verify`. The annotated tag itself is
not GPG/SSH-signed; artifact identity is established by the exact Git revision and the attested
release asset.

Do not copy schemas, fixtures, or types into this repository. Protocol upgrades require a new
canonical release/tag and a reviewed update to the exact revision and checksums here.
