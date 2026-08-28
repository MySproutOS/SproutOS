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

## Native plugin isolation

`NativeIsolationProvider` is fail closed. Linux requires a root-owned, non-writable
`/usr/bin/bwrap` or `/bin/bwrap` and accepts only statically linked ELF plugins; Bubblewrap exposes
only the plugin, its workspace, and `/dev/null`, with all namespaces unshared, the private root
remounted read-only, `.git` separately remounted read-only, every capability dropped, and nested
namespace syscalls denied after setup by a sealed classic-BPF filter consumed from one explicitly
inherited descriptor. Docker's outer profile permits only Bubblewrap's argument-scoped setup
calls; the inner filter is installed in both Bubblewrap's PID-namespace init and the plugin before
plugin execution. macOS and Windows return `IsolationUnavailable`: the
available macOS Seatbelt interface cannot both default-deny arbitrary credential mounts and launch
a general native executable without a broader file-read exception, and Windows has no implemented
provider. Hosts missing the Linux primitive are likewise unsupported; the plugin is never run
without the full boundary.

The runner clears the environment, marks every non-stdio file descriptor close-on-exec, bounds
stdout/stderr and runtime, kills the Unix process group on failure, and validates the declared
before/after workspace diff.

Before enabling catalogue plugins in production, the ECS worker image and task definition must be
proven with a real static-musl plugin: verify Bubblewrap user namespaces work under the task's exact
kernel, capabilities, seccomp profile, and UID; then prove the plugin has zero effective
capabilities, nested user namespaces remain disabled, network and credential access are denied,
`.git` remains read-only even under a remount attempt, the process tree dies on timeout, and
declared workspace output succeeds. Local or CI tests are not evidence for that production gate.
