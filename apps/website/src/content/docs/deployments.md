---
slug: deployments
title: Deploy an application
summary: Choose a build preset, publish a finished artifact, distinguish preview from production, and verify the release.
audience: developer
category: Deploying
order: 10
---

A SproutOS deployment publishes one finished build to one project. The project identifies the
repository target; the preset identifies how the output is served. SproutOS does not guess how to
build your source, and a deployment of one group child does not deploy its siblings.

## Choose the preset

- `static` publishes files at the edge. Use it for a SPA or generated site with no server handler.
- `next` packages a Next.js standalone server output.
- `hono` packages a Hono application using the supported entrypoint contract.
- `web` publishes a provided server runtime or adapter output.
- `function` publishes a ZIP containing a direct Node, Python, Java, .NET, Ruby, or custom-runtime
  handler.
- `android` uploads one raw unsigned APK for the protected signing and distribution flow.

Point `--path` or the Action's `directory` at the built output, not the source directory unless the
preset explicitly expects it. Static assets are immutable deployment content; mutable uploads and
user files belong in [object storage](/docs/object-storage).

The project owns the normal preset/runtime/handler default. Explicit deploy options override it for
one release, and the resolved values are recorded with that deployment. See
[Runtimes and framework presets](/docs/runtimes).

## Deploy from a terminal

```shell
sprout auth login
sprout org use my-team
sprout deploy my-site --preset next --runtime nodejs24.x --path .next/standalone
sprout deployment list my-site
sprout logs my-site
```

The CLI packages deterministically, negotiates an upload, creates a release, and waits for a
terminal result. A queued deployment is not a successful deployment; wait until it is ready and
then exercise the application URL.

## Separate preview and production

Production is the default. Use `--environment preview` for preview output. Preview releases are
isolated from the production pointer and should use preview-targeted environment values. The
deployment API also associates previews with a pull request so each one has an unambiguous
hostname.

Do not promote confidence from one environment to another. A sandbox preview proves a development
process, a preview deployment proves a built preview release, and a production request proves the
live release. Record which one you tested.

## Put migrations before deployments

Deploying code never discovers or runs a database migration. Run production migrations in GitHub
Actions and make every dependent deployment job declare `needs: migrate`. If the migration fails,
the new code must not receive traffic. See [Run database migrations](/docs/database-migrations).

## Verify in layers

After a ready result:

1. inspect the deployment's source commit, preset, kind, and hostname;
2. open the hostname and exercise a real authenticated or data-backed path;
3. check **Logs** for the same request and confirm the expected project handled it;
4. verify each attached service with a harmless read and write;
5. add or check the custom domain only after the generated hostname works.

Build failures and runtime failures are reported separately. A build failure means the artifact or
image could not be prepared. A runtime failure means the build completed but the application did
not start or serve correctly.

Runtime selection does not rebuild the artifact. Native dependencies must target Linux arm64, and
the CI toolchain should match the selected SproutOS runtime.
