# Sprout template protocol integration pin

This workspace package is a zero-logic facade over the canonical
`sprout-template-protocol` crate owned by
[`MySproutOS/Deployment-Templates`](https://github.com/MySproutOS/Deployment-Templates).
It re-exports the exact canonical API so `sprout-core`, `sprout-node`, and the CLI cannot acquire a
second wire implementation.

The temporary Git dependency is pinned to both canonical crate version `0.1.0` and commit
`4cc6f56695d1f2a7e5a643973566372a329429b5`. The SHA-256 of
`git archive --format=tar 4cc6f56695d1f2a7e5a643973566372a329429b5` is
`7563b7c56f644ec429ff82bf734558e16fd367d9077c503b4ced18e76ef1dc8b`.

Do not copy schemas, fixtures, or types into this repository. After the canonical crate is reviewed,
merged, and published to crates.io, replace the Git source with the exact registry requirement
`=0.1.0`; commit the resulting `Cargo.lock` registry checksum in the same change.
