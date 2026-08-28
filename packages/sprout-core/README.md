# sprout-core

Reusable deployment machinery shared by the `sprout` CLI and the Node worker binding. This crate
owns resolution, authenticated API transport, OCI artifact verification, bounded plugin execution,
and workspace-diff validation. It deliberately does not own CLI rendering, credential storage,
Git operations, commits, or pushes.

The wire format is also deliberately outside this crate. `sprout-template-protocol` implements
`TemplateProtocol`; keeping that adapter at the boundary lets the protocol evolve without a second
copy of its request and response structs here.

Plugin execution is fail-closed: callers must supply an `IsolationProvider`. An implementation is
responsible for constructing an OS-contained command with no network access, only the workspace
writable, and descendant-process containment. There is no public "run directly" fallback.

`template resolve`, `template verify`, and `template apply` frontends must report the corresponding
structured unavailable error until all three production providers are wired: the canonical
catalogue resolver, a verifier for the pinned Deployment-Templates GitHub keyless provenance, and
an OS isolation provider. A missing provider is not permission to download by tag, skip provenance,
or launch the executable directly.
