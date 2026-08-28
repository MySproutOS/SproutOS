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

`template resolve`, `template verify`, and `template apply` compose the authenticated catalogue
resolver, the verifier for the pinned Deployment-Templates GitHub keyless provenance, and the OS
isolation provider here. The native consumer repeats the exact repository, workflow, ref, source
commit, digest, and protocol-identity checks after resolution. A missing provider returns its
structured unavailable or rejected error; it is never permission to download by tag, skip
provenance, or launch the executable directly.

## Native plugin isolation

`NativeIsolationProvider` is fail closed. Linux requires a root-owned, non-writable
`/usr/bin/bwrap` or `/bin/bwrap` and accepts only statically linked ELF plugins; Bubblewrap exposes
only the plugin, its workspace, and `/dev/null`, with all namespaces unshared, the private root
remounted read-only, `.git` separately remounted read-only, every capability dropped, and nested
namespace syscalls denied after setup by a sealed classic-BPF filter consumed from one explicitly
inherited descriptor. Docker's outer profile permits only Bubblewrap's argument-scoped setup
calls; the inner filter is installed in both Bubblewrap's PID-namespace init and the plugin before
plugin execution. macOS uses Apple's deny-default `system.sb` runtime baseline, denies network,
grants the exact verified-plugin and workspace reads, grants writes only below the workspace, and
denies `.git` writes. Windows stages the checkout and verified executable into a per-run
AppContainer ACL tree, launches with `SECURITY_CAPABILITIES` and no network capabilities, and
attaches the child to a kill-on-close Job Object with CPU, memory, process-count, and time limits.
Only validated declared changes are replayed into an unchanged source workspace; the profile and
staged ACL tree are removed on exit. A host missing its complete native primitive is unsupported;
the plugin is never run directly.

The runner clears the environment, marks every non-stdio file descriptor close-on-exec, bounds
stdout/stderr and runtime, kills the complete process tree on failure, and validates the declared
before/after workspace diff.

Before enabling catalogue plugins in production, the ECS worker image and task definition must be
proven with a real static-musl plugin: verify Bubblewrap user namespaces work under the task's exact
kernel, capabilities, seccomp profile, and UID; then prove the plugin has zero effective
capabilities, nested user namespaces remain disabled, network and credential access are denied,
`.git` remains read-only even under a remount attempt, the process tree dies on timeout, and
declared workspace output succeeds. Local or CI tests are not evidence for that production gate.
