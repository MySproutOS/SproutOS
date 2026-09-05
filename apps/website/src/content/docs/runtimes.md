---
slug: runtimes
title: Runtimes and framework presets
summary: Choose a project runtime, understand deployment overrides, and prepare arm64-compatible artifacts.
audience: developer
category: Deploying
order: 9
---

Every Lambda-backed SproutOS project owns a framework preset and runtime default. Project creation
shows the recommended combination—Node.js 24 for a new Next.js, Hono, or Node Function project,
and `provided.al2023` for a generic Web executable—and lets you change it before creating the
project. Changes in **Modify** apply only to future deployments.

Run `sprout runtime list` for the live catalogue. The dashboard groups versions by language and
shows the underlying Amazon Linux generation when it affects compatibility or lifecycle.

## Choose an execution contract

- `next` and `hono` run Node.js HTTP servers through Lambda Web Adapter.
- `web` runs an executable `run.sh` HTTP server through Lambda Web Adapter on any compatible ZIP
  runtime. SproutOS supplies the custom-runtime `bootstrap` bridge.
- `function` invokes a Lambda handler directly. Set the handler exported by the finished package,
  such as `index.handler`; Node.js 24 handlers must be async and cannot use callback-style handlers.
- `static` publishes immutable files at the edge and has no Lambda runtime.
- `android` uploads an APK for signing and distribution and has no Lambda runtime.

Groups and repository workflow projects do not inherit a Lambda runtime. In a monorepo, configure
the website, API, and each other deployable child independently.

## Defaults, overrides, and rollback

The project setting is the normal default. `sprout deploy --runtime ... --handler ...` and the
equivalent GitHub Action inputs override it for one release; they do not edit the project. There is
no checked-in SproutOS runtime configuration file.

Every deployment records its resolved preset, runtime, and handler. Changing project settings does
not rewrite an existing deployment, and rollback restores the old deployment without rebuilding or
substituting today’s runtime.

## Build for the runtime

SproutOS uploads a finished artifact; runtime selection does not reinstall or rebuild dependencies.
Set the CI build toolchain separately and use the same language version you selected for SproutOS.
Customer Lambda functions run on Linux `arm64`, so native packages and compiled binaries must
target that architecture.

AWS applies compatible patch updates inside a managed runtime identifier. Moving between major
runtime identifiers remains your application upgrade. The catalogue shows deprecation and
selection cutoff dates; a runtime can remain selectable with a warning during a transition, but
disabled identifiers are rejected for new deployments. Previously published versions remain valid
rollback targets.
