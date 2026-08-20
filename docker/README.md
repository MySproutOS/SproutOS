# `docker/`

One Dockerfile per deployable. arm64 only — one architecture is the point of the Graviton decision:
one build of every image, one set of base layers, and no class of bug that appears on one node type.

## The Rust images

`scratch`, from a static `aarch64-unknown-linux-musl` build. **1.1 MiB**, no shell, no package
manager, no libc to have a CVE in. That matters more for these three than for most images: they sit
on the network edge of the data plane, and the smallest useful thing an attacker can do inside a
container is run something already there.

The CA bundle is copied in explicitly. `scratch` has no certificates, and the failure without it is a
TLS handshake error that reads like a network problem.

`USER 65534:65534` is declared in the image as well as the pod spec. `runAsNonRoot` fails a pod whose
image declares no user — and an image that runs unprivileged _only because the orchestrator said so_
runs as root everywhere else.

**Verified, not assumed:** `docker build -f docker/pg-proxy.Dockerfile --platform linux/arm64` builds,
and the result runs. It exits with `PG_PROXY_DATABASE_URL is not set` — the binary's own configuration
check, executing inside an image with no shell.

## The Node images

The difficulty is the pnpm workspace: `pnpm install` in a subdirectory does not work, and copying the
repo into the build context invalidates the dependency layer on every source change. Manifests are
copied first and `--filter <app>...` installs only what that app needs, so the dependency layer
survives a source edit.

`tini` as PID 1. Node does not reap zombies and does not forward `SIGTERM` to children, so without it
a rolling deploy waits out the full termination grace period on every pod — which for the worker is
120 seconds.

`website` is the one that cannot use `readOnlyRootFilesystem`, because Next.js writes its incremental
cache to disk. See `deploy/README.md`.

## Not verified

Only `pg-proxy` has actually been built. The other three Rust images are the same file with a name
substituted, which is a good reason to expect them to work and not the same as knowing. The three
Node images have **never been built** — they depend on build outputs (`apps/*/build`, `server.js`)
produced by `pnpm run build`, and whether those land where the `CMD` expects is exactly the kind of
thing that is obvious once and never again.
