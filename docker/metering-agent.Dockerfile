# The Rust proxies, built static and shipped on nothing.
#
# `aarch64-unknown-linux-musl` into `scratch`: a few megabytes with no shell, no package manager and
# no libc to have a CVE in. That matters more here than for most images — these three sit on the
# network edge of the data plane, and the smallest useful thing an attacker can do inside a container
# is run something that is already there.
#
# Also why the release profile sets `panic = "abort"` and `strip = true`: nothing unwinds, nothing
# carries symbols, and the binary boots instantly on a node that is billed by the second.
FROM --platform=$BUILDPLATFORM rust:1.93-alpine AS build

RUN apk add --no-cache musl-dev pkgconfig
WORKDIR /src

# Manifests first, so a source change does not invalidate the dependency layer. The workspace is
# copied whole because the proxies depend on `lib/rust/*` by path — copying only one crate's
# `Cargo.toml` produces a workspace that does not resolve.
COPY Cargo.toml Cargo.lock ./
COPY lib/rust ./lib/rust
COPY services ./services

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p metering-agent \
    && cp target/release/metering-agent /metering-agent

FROM scratch
# The CA bundle: the agent POSTs to the ingest endpoint over TLS. `scratch` has no certificates, and
# the failure without this is a handshake error that reads like a network problem.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /metering-agent /metering-agent

# 65534:65534 is `nobody`. Declared here as well as in the pod spec: `runAsNonRoot` in Kubernetes
# fails a pod whose image declares no user, and an image that only works because the orchestrator
# overrode it is one that runs as root everywhere else.
USER 65534:65534
ENTRYPOINT ["/metering-agent"]
