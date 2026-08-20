# 0002. Every image was broken

Seven container images were checked in, referenced by Deployment manifests, and described in a
README. **Not one had ever been built and run.** Building them found a bug in each, and in the case
of `internal-api`, four in sequence — each one only visible after fixing the previous.

None of this is visible to a passing build, a clean lint, or a green test suite. An image whose
`CMD` names a file the build never produced builds successfully and exits instantly.

## `internal-api` — four

1. **`tsc -b` emits extensionless ESM imports** Node cannot resolve. The tsconfig says
   `moduleResolution: bundler`, so bundling was always the intended path; it had never been set up.
2. **esbuild's `packages: "external"` externalised the workspace packages too**, so Node resolved
   `@lib/dao` to TypeScript source at runtime. `external` is now computed from non-`workspace:*`
   dependencies only.
3. **`Dynamic require of "node:https" is not supported`** — the ESM bundle needed a `createRequire`
   banner.
4. **The container exited 0 with no logs.** `src/index.ts` only _exports_ the Hono app.
   `dev-server.ts` was the sole listener, and its own comment pointed at a production entrypoint
   that had never been written.

## `website` — three

1. **`output: "standalone"` was not set**, so `apps/website/server.js` — the path in `CMD` — did not
   exist.
2. **Three `@fontsource-variable` packages were imported by all three apps and declared by none.**
   They resolved locally only through pnpm's hoisted `.pnpm/node_modules`, an implementation detail.
   The vite configs reached into `@ui/base/node_modules` to compensate.
3. **Next's file tracer copies `@swc/helpers` by static analysis** — 3 files of 452 — and misses the
   ESM build the server loads through the package's `exports` map at runtime. Repaired in the
   Dockerfile, guarded by a `test` that fails the build if the repair stops working.

## `website` — a fourth, found only in a cluster

Next's standalone server binds `process.env.HOSTNAME || "0.0.0.0"`, and **every container runtime
sets `HOSTNAME` to the container's own name**, which `/etc/hosts` maps to the pod IP. So it bound one
interface. The pod passed its readiness probe and served Service traffic — both target the pod IP —
while `localhost` inside the pod refused connections. Confirmed from `/proc/1/environ` and
`/proc/net/tcp`.

## Two Rust images were built by a compiler the repo does not support

All four Rust Dockerfiles pinned `rust:1.85-alpine`; `rust-toolchain.toml` requires `1.93.0`.

The failure was **partial**, which is worse than total: `pg-proxy` and `valkey-proxy` built fine,
because their dependency trees do not reach a crate demanding newer. The two that worked read as
evidence the pin was fine. `metering-agent` and `search-proxy` failed outright on the `icu_*` crates.

**Guard:** `bin/check-rust-toolchain.mjs` fails CI when any of the five pins disagree — and fails
loudly if its own patterns stop matching, rather than passing while checking nothing. Both failure
modes are mutation-tested.

## All four Rust images built the wrong architecture

`FROM --platform=$BUILDPLATFORM` with no `--target` runs the compiler natively and produces a binary
for the _build_ machine. On an arm64 Mac that is an arm64 binary inside an image labelled amd64;
Kubernetes answers `exec format error`.

Cross-compiling properly does not work either: `ring` builds C, and Alpine's `musl-dev` provides no
cross linker. The build now runs on the target platform — native on CI, emulated on a developer's
machine of the other architecture. See [ADR 0020](../adr/0020-build-images-on-the-target-platform.md).

## The service images were 2.46 GB to run one bundled file

Both copied the build stage's `node_modules` — the monorepo's entire dev dependency graph — onto
every node on every deploy. The Dockerfile comment had described `pnpm deploy --prod --legacy` since
it was written; nothing used it. **2.46 GB → 847 MB**, of which 310 MB is the Agent SDK's native
binary.

## A mistake worth recording

One "successful" rebuild had actually failed. `-q` hid the error, the old tag still resolved, and
the container that started was the previous image — whose config error read exactly like the new
one's. It was caught by checking the ELF header of the binary rather than trusting that a build that
printed no error had produced anything.
