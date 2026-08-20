# 0020. Container images are built on the target platform, not cross-compiled

- Status: Accepted
- Date: 2026-08-20

## Context

The four Rust images used `FROM --platform=$BUILDPLATFORM`, which runs the compiler natively on the
build machine. That is the standard trick for fast multi-architecture builds and it is why the line
was written: an arm64 Mac compiles at arm64 speed rather than under emulation.

It only works if the build then names a target. No `--target` was passed, so the output was a binary
for the _build_ machine wearing the label of the target. On an arm64 Mac, `docker build --platform
linux/amd64` produced an arm64 binary inside an image tagged amd64, and Kubernetes answered
`exec format error` two steps later.

Adding `--target` does not fix it. `ring` — reached through `reqwest`'s TLS stack, so present in
every one of these binaries — builds C, and cross-compiling it needs `x86_64-linux-musl-gcc`, which
Alpine's `musl-dev` does not provide for a foreign target. The build fails in `ring`'s build script.

This became load-bearing when tenant workloads stopped being a single architecture. The same four
images now have to run on amd64 GKE and Azure nodes and on arm64 Graviton metal.

## Decision

Build on `$TARGETPLATFORM`. Native on CI, emulated on a developer's machine of the other
architecture.

The cargo cache mounts are keyed per architecture (`id=cargo-target-<svc>-$TARGETARCH`). A single
shared `target/` would let an arm64 build satisfy an amd64 build's freshness check and hand back the
wrong binary — the same failure arriving by a different route.

## Consequences

Building an image for the other architecture on a laptop is slow, because it runs under QEMU. CI
builds the architecture it runs on and is unaffected.

The `rust-toolchain.toml` target list stops being the thing that decides output architecture; the
platform does. That is less surprising, not more: there is now one place that says what is being
built for, and it is the same flag Docker already uses.

## Alternatives considered

**Install a cross toolchain.** `x86_64-linux-musl-cross` is not in Alpine's repositories and would
have to be fetched and trusted from elsewhere, inside an image whose whole argument is that it
contains almost nothing.

**`cargo-zigbuild`.** Genuinely solves cross-compiling C dependencies, and adds Zig to the build
image plus a second toolchain to keep current. Worth revisiting if emulated build times become the
bottleneck; they are not.

**Keep `$BUILDPLATFORM` and drop TLS.** Removing `ring` would mean the agent could not reach an
HTTPS ingest endpoint. Not a trade worth making to save build minutes.
