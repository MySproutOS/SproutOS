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
  `packages: "external"` externalised the _workspace_ packages too, so Node resolved `@lib/dao` to
  TypeScript source; the bundle needed a `createRequire` banner for `node:https`; and the `CMD`
  pointed at a module that only _exports_ the Hono app. Nothing listened. `src/server.ts` is the
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

## Size

| image            | size   |
| ---------------- | ------ |
| `pg-proxy`       | 3.5 MB |
| `valkey-proxy`   | 3.5 MB |
| `metering-agent` | 5.4 MB |
| `search-proxy`   | 6.7 MB |
| `website`        | 318 MB |
| `internal-api`   | 847 MB |
| `worker`         | 847 MB |

The two Node service images were **2.46 GB** until they stopped shipping the build stage's
`node_modules`. The app is bundled, so the only thing `node_modules` still has to supply is the
handful of non-workspace packages esbuild left external — everything else being copied was the
monorepo's dev dependency graph: TypeScript, vitest, esbuild and three frontend toolchains, pulled
onto every node on every deploy to run one bundled file. `pnpm deploy --prod --legacy` produces the
runtime tree instead.

Of the 847 MB that remain, 310 MB is the Claude Agent SDK's native `linux-arm64-musl` binary. That
is the product, not waste. The rest is the Alpine base and the real production dependencies.

`website` is smaller than either because Next's standalone output already does this — it traces
what the server reaches and copies only that. See the `@swc/helpers` note above for where the
tracing gets it wrong.

All four Rust images have now been built and run, and building the other three is what exposed the
eighth bug: **every Rust Dockerfile pinned `rust:1.85-alpine` while `rust-toolchain.toml` requires
1.93.0.** `pg-proxy` and `valkey-proxy` built anyway — their dependency trees do not happen to reach
a crate that demands newer — so the two that worked read as evidence the pin was fine, while
`metering-agent` and `search-proxy` failed outright on the `icu_*` crates. Two of four images were
being produced by a compiler eight minor versions behind the one every test runs under.

The version was written down in three places that nothing connected: the workflow, the toolchain
file, and each Dockerfile. `bin/check-rust-toolchain.mjs` now fails CI when they disagree, and fails
if its own patterns stop matching rather than passing blind.

Each of the four starts, runs its own configuration validation, and exits with its own error — which
is what proves the binary executes at all in a `scratch` image with no shell. `pg-proxy` was taken
further: given a real backend it listens, accepts a `psql` connection, speaks the startup and SCRAM
exchange, and rejects a role that is not a provisioned tenant.

## Probes

`internal-api` serves `/health` and `/ready`, and the split is deliberate — see
`apps/internal-api/src/health.ts`. A liveness probe that checked Postgres would restart every API
pod during a database blip and crash-loop the fleet through its own recovery, so `/health` checks
nothing but the process and `/ready` is where the database check lives. Both were verified against a
refused connection _and_ a blackholed one; the readiness timeout fires in 2 seconds rather than
waiting out the OS TCP timeout.
