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

## What has actually been built and run

All three Node images have been built and run, and every one of them was broken in a way that only
running it revealed. `CMD` pointing at a file the build never produced is not visible in a passing
`pnpm run build`, in a lint, or in a green test suite — the image builds clean and the container
exits.

- **`internal-api`** — four bugs. `tsc -b` emits extensionless ESM imports Node cannot resolve, so
  the app is bundled with esbuild instead (`apps/internal-api/build.mjs`); esbuild's
  `packages: "external"` externalised the *workspace* packages too, so Node resolved `@lib/dao` to
  TypeScript source; the bundle needed a `createRequire` banner for `node:https`; and the `CMD`
  pointed at a module that only *exports* the Hono app. Nothing listened. `src/server.ts` is the
  production entrypoint that had never been written.
- **`website`** — three bugs. `output: "standalone"` was not set, so `apps/website/server.js` did
  not exist; the three `@fontsource-variable` packages were imported by the app but declared only by
  `@ui/base`, which resolved locally through pnpm's hoisted `.pnpm/node_modules` and nowhere else;
  and Next's file tracer copies `@swc/helpers` by static analysis, catching 3 files of 452 and
  missing the ESM build the server loads through the package's `exports` map at runtime. The last
  one is repaired in the Dockerfile, with a `test` that fails the build if the repair stops working.
- **`worker`** — built and run clean, and observed executing real recurring jobs against the compose
  Postgres.

Verified for each: the container starts, serves or works, and runs as a non-root user.

`pg-proxy` has been built and run (1.1 MiB, uid 65534, exits on its own config error). The other
three Rust images are the same file with a name substituted, which is a good reason to expect them
to work and not the same as knowing.

## Probes

`internal-api` serves `/health` and `/ready`, and the split is deliberate — see
`apps/internal-api/src/health.ts`. A liveness probe that checked Postgres would restart every API
pod during a database blip and crash-loop the fleet through its own recovery, so `/health` checks
nothing but the process and `/ready` is where the database check lives. Both were verified against a
refused connection *and* a blackholed one; the readiness timeout fires in 2 seconds rather than
waiting out the OS TCP timeout.
