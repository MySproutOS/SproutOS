# The Rust proxies, built static and shipped on nothing.
#
# Identical to `search-proxy.Dockerfile` and `valkey-proxy.Dockerfile` bar the crate name and the
# port. Kept as four files rather than one parameterised build because a `--build-arg` for the crate
# name means a typo produces an image that builds, tags, and runs the wrong proxy.
#
# `aarch64-unknown-linux-musl` into `scratch`: a few megabytes with no shell, no package manager and
# no libc to have a CVE in. That matters more here than for most images — these three sit on the
# network edge of the data plane, and the smallest useful thing an attacker can do inside a container
# is run something that is already there.
#
# Also why the release profile sets `panic = "abort"` and `strip = true`: nothing unwinds, nothing
# carries symbols, and the binary boots instantly on a node that is billed by the second.
# `$TARGETPLATFORM`, not `$BUILDPLATFORM`.
#
# `$BUILDPLATFORM` runs the compiler natively and cross-compiles, which is faster and does not work:
# `ring` builds C, and cross-compiling it needs `x86_64-linux-musl-gcc`, which Alpine's `musl-dev`
# does not provide for a foreign target. The build fails at `ring`'s build script.
#
# Worse than failing, it failed *quietly* the first time: a `-q` build hides the error, the tag still
# resolves to the previous image, and the container that then starts is the stale one. An arm64
# binary shipped inside an image labelled amd64, and Kubernetes said `exec format error` two steps
# later.
#
# So the build runs on the target platform — natively on CI, under emulation on a developer's
# machine of the other architecture. Slower there, and correct on both. That matters more now than
# speed does: these images run on amd64 GKE nodes and on arm64 Graviton metal from the same file.
FROM --platform=$TARGETPLATFORM rust:1.93-alpine AS build

RUN apk add --no-cache musl-dev pkgconfig
WORKDIR /src

# Manifests first, so a source change does not invalidate the dependency layer. The workspace is
# copied whole because the proxies depend on `lib/rust/*` by path — copying only one crate's
# `Cargo.toml` produces a workspace that does not resolve.
COPY Cargo.toml Cargo.lock ./
COPY lib/rust ./lib/rust
COPY services ./services

# No `--target`: the toolchain is already the target's, so the host triple is the right one and
# naming it again would only be a second place to get it wrong.
#
# The cache mount is keyed per architecture. Sharing one across both would let an arm64 `target/`
# satisfy an amd64 build's freshness check and hand back the wrong binary — which is the same
# failure this file already had once, arriving by a different route.
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=cargo-registry-$TARGETARCH \
    --mount=type=cache,target=/src/target,id=cargo-target-storage-proxy-$TARGETARCH \
    cargo build --release --locked -p storage-proxy \
    && cp target/release/storage-proxy /storage-proxy

FROM scratch
# The CA bundle, because the proxy speaks TLS to S3 — and, unlike the others, always will: the
# backing store is a public endpoint even when everything else is in-cluster. `scratch` has no certificates,
# and the failure without this is a handshake error that reads like a network problem.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /storage-proxy /storage-proxy

# 65534:65534 is `nobody`. Declared here as well as in the pod spec: `runAsNonRoot` in Kubernetes
# fails a pod whose image declares no user, and an image that only works because the orchestrator
# overrode it is one that runs as root everywhere else.
USER 65534:65534
EXPOSE 9000
ENTRYPOINT ["/storage-proxy"]
