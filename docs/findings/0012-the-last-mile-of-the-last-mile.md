# 0012 — The last mile of the last mile

A customer could sign in, fork an application, watch the build compile it, and end up with
nothing. Every stage worked. The joins between them did not, and each join failed in a way that
looked like the stage after it had simply not started yet.

This is the third record in a row about the same shape (see [0006](0006-features-with-no-executor.md)
and [0011](0011-the-platform-was-free.md)), which is itself the finding: the components in this
repository are more reliable than the wiring between them, and the wiring is what nothing tests.

## What was actually broken

**Signing in from the front page returned 400, always.** The OAuth App has one registered callback
host. The "Sign in with GitHub" button is on the marketing pages, which are served from the apex. So
a sign-in that begins on `selloutjobs.com` finishes on `app.selloutjobs.com`, and the `state` and
PKCE cookies were host-only — the *session* cookie had been given a `Domain` and these had not. The
callback found no state and refused. It refused silently: five `return badRequest()` calls, no
reason logged, nothing in the pod's output at all.

**A fork deployed nothing.** `runProvision` forked the repository, marked `first_deploy` as
`skipped`, and set the project `ready`. The comment beside it was honest — the build pipeline
"exists elsewhere in the repository and is not wired to this job yet" — and it was the product. The
`deployment` table held one row, from a seed, on a live deployment that had taken real forks.

**`project.root_dir` had no reader.** Settable on create, settable on update, part of the uniqueness
key that decides whether two projects are the same build target, rendered in the UI. The builder
always built the repository root.

**Two thirds of the store could not be deployed.** BuildKit's dockerfile frontend looks for
`Dockerfile` at the context root. Of six listed applications, two kept one there. The rest forked
successfully and then died on `failed to read dockerfile` — after the customer had a repository.
One listing pointed at the Astro framework's monorepo and called it "Astro Blog Starter"; another
pointed at an archived repository with no Dockerfile at its final commit.

**The build had no credential.** `deploy/builds/namespace.yaml` opens by explaining that a build
"needs a credential that can *push* to the registry" and why it cannot live in a tenant namespace.
Both true. No Secret was ever created, nothing mounted one, the Job spec had no volumes. Every build
compiled the application, exported an image, and asked the registry for an anonymous token.

**The OpenAPI document had lost 25 of its 28 request bodies.** `utils/validator.ts` wraps the
library's validator to stop `Value.Convert` reshaping request bodies — a real fix for a real bug.
`hono-typebox-openapi` carries the body schema on a symbol attached to the middleware it returns,
and `every(strict, inner)` is a new function, so the symbol stayed behind.

**`install_count` counted attempts.** It moved when the job was queued, before anything was forked.
Two failed forks read as two installs on the live store.

**A library's dependency is not in the image unless the app declares it too.** `pnpm deploy --prod
--legacy` flattens one package's graph; copied workspace libraries get no `node_modules` of their
own. `@lib/envelope` has never hit this only because `@api/internal` happens to declare
`@aws-sdk/client-kms` directly as well.

## Why none of it was caught

Each of these passed every check that existed, and in most cases the check was *shaped so that it
could not fail*.

- The transient-cookie bug needs two hosts to appear. Every test uses one.
- `first_deploy` was `skipped`, and a test asserting "the job succeeds" passes on a job that skips
  everything. The step list was tested for its *shape* — that the keys exist, that progress cannot
  divide by zero — and never for whether anything moved.
- The build tests describe a spec with no registry credential, which is the correct configuration
  for the insecure local registry they assume. "No volumes" looked right.
- The OpenAPI regression was invisible for as long as nobody regenerated: the committed client
  predates the wrapper and kept working.
- The missing runtime dependency type-checks, tests, and is present in the image's virtual store.

The recurring form is a check that observes the same thing in the same configuration the code was
written in. `docs/findings/0001` put it as: the question worth asking of a check is not whether it
passes but what would have to be true for it to fail. Five of the eight above have the same answer —
*nothing, in this configuration* — and the configuration was never varied.

## What now stops them

Some of these got a test. The ones worth naming are the ones that generalise:

- `apps/website/vitest.config.mts` exists at all. The app's tests could not import the app's modules
  through its own path alias, so the only website tests were of modules reachable by a relative
  path. The coverage was shaped by what was easy to reach.
- The login-route test asserts the transient cookies are scoped **exactly like the session cookie**,
  rather than that a domain is set. A change that moves one and not the other fails.
- `provision-run.test.ts` drives `runProvision` end to end against a stubbed GitHub and asserts a
  `deployment` row and a queued job — deliberately not the step label, since marking `first_deploy`
  succeeded is precisely what the old code could have done without doing any of the work.
- `openapi.test.ts` asserts the generated document, and asserts the wrapper's document is identical
  to the library's. An internals test on the symbol would pass a change that keeps the symbol and
  loses the body.
- `bin/check-workspace-deps.mjs` reads the `pnpm deploy --filter=` lines out of `docker/*.Dockerfile`
  rather than taking a list, so a new image is covered without anyone remembering.
- The store-listing seed **reconciles** an existing row instead of skipping it. A create-only seed
  cannot correct a value it already got wrong, which is how four listings kept a `dockerfile_path`
  of `Dockerfile` after the right paths were known.

## The one that is not a check

`store_listing.dockerfile_path` is not a guard against a mistake; it is a fact the platform did not
have. The premise of the store is that a listed application deploys, and the builder could express
only one of the several perfectly ordinary places a project keeps its Dockerfile. No amount of
checking a wrong build would have produced a right one.

That distinction is worth keeping in view when reading the rest of this directory. Most of what is
here is a check that was shaped to pass. Some of it is a thing that was never built, described
confidently in a comment beside the place it should have been.
