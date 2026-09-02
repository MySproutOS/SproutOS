# Every deployment in production history failed, and nothing said why

**Found:** 2026-08-26, by trying to write a deploy workflow for a real repository and asking what
would happen at the next step.

## What was true

```
select coalesce(string_agg(distinct status, ', '), '(none)') from deployment;
→ error
```

Every deployment ever created in the production account has status `error`. Not most — all of them.
ADR 0026 moved customer compute to Lambda in a design that reads correctly end to end, and the
compute path it describes has never served a single HTTP request.

Two separate causes, one behind the other:

1. `provision.ts` queued a release with no build artifact on every fork and marked the step
   `succeeded`. `publishRelease` refused it on sight — "No build artifact was uploaded for this
   release" — so every project carried a failed deployment it never asked for. Fixed earlier the
   same day; it is what made the second cause invisible, because every row already said `error` for
   a reason that had an explanation.

2. **There was no Lambda handler.** `publishFunction` published every build with
   `handler: "index.handler"`. What the presets collect is a _web server_: the `next` preset takes
   `.next/standalone`, whose entry point is `server.js` — a program that listens on a port — and the
   `hono` preset takes a `dist` of the same shape. Neither exports `index.handler`. Nothing in this
   repository, in the deploy action, or in either ADR ever bridged the two. A real artifact reaching
   a real function would have answered `Runtime.HandlerNotFound` on its first invocation.

## Why nothing caught it

The gap is between two repositories and two languages. The deploy action decides what goes into the
archive; the control plane decides what Lambda is told to call. Each is internally consistent and
each is tested against its own idea of the other. There is no test that opens an archive the action
produced and checks that the thing the control plane names is inside it — and there could not be,
while the only test artifacts were fixtures written to match whichever side was under test.

The first cause hid the second. Cause 1 produced a failed deployment for every project on creation,
with a message that made sense. A list of deployments that is entirely `error` looks explained.

And nothing ever pressed the button. The same sentence appears in finding 0017 and in the note about
`git` not being installed on the instances. Three findings in one day, all of the same shape: code
that was correct, tests that passed, and a path nobody had walked.

## What now stops it

`lib/typescript/lambda/src/web-adapter.ts`. AWS's Lambda Web Adapter is a layer that starts the
customer's server inside the sandbox and forwards each invocation to it as an ordinary HTTP request,
so a Next.js or Hono build deploys exactly as it runs locally. The alternative — requiring every
customer to export a Lambda handler — contradicts the product: "fork this app and it runs" cannot
also mean "first learn Lambda's calling convention".

Three things have to be true together, and each is a silent failure on its own:

- the layer is attached,
- `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap` is set — **without it the layer is present and inert**,
  the function still looks for a handler export, and the configuration looks right,
- the archive contains `run.sh`, which is what `handler` names.

For a `provided.al2023` native web build the same layer runs as an extension, but the startup
contract is deliberately different: Lambda executes the archive's `bootstrap` directly, so the
wrapper variable must be absent. The `web` preset records that custom-runtime convention and still
attaches the adapter layer and injects the shared port. Treating an unknown `web` preset as a plain
custom runtime once produced a healthy deployment record whose function could only return 502.

They are applied from one place each. `publishFunction` takes a single `webAdapterLayerArn` and
derives both the layer and the environment from it, so a caller cannot set one without the other.
The action writes `run.sh` into the build output _before_ packaging, so the digest covers it.
`deployment.web_adapter` records which convention a release was built for, because a rollback must
republish the old version the way that version expected.

**The publish refuses rather than guesses.** A deployment marked `web_adapter` with no layer
configured is failed with a message naming the variable to set, before the alias moves. Publishing
and hoping is how this subsystem spent its entire history in a state where every row said `error`
and none of them said which field was wrong.

## The question worth asking

Not "does the deploy path have tests" — it did. It is: _what would have to be true for a deployment
to succeed?_ Answering that requires naming the artifact, the entry point inside it, and the string
Lambda is given, in one sentence. Nobody had written that sentence down, so nobody noticed that its
three halves came from three places that had never met.

## Addendum, same day: the action nobody could use

Driving the first real deploy found a sixth thing of the same shape.
`MySproutOS/sproutos-deploy-action` — the action every customer workflow is told to call, the one
the generated YAML names, the one this repository carries as a submodule — **is a private
repository**. A workflow in any other organization fails before its first step:

```
##[error]Unable to resolve action `mysproutos/sproutos-deploy-action`, not found
```

Not "authentication failed" and not "permission denied": _not found_, because a private repository is
invisible rather than forbidden. So the error a customer sees says the action does not exist.

It has never been noticed because the only workflows that use it live in this organization, where it
resolves. A marketplace action in a private repository is not an action anyone can use, and the
generated workflow route hands out a file that cannot run.

Recording it here rather than fixing it silently: making a repository public is not reversible in the
way that matters — the history becomes fetchable and indexable — so it is a decision, not a
correction.

## The chain underneath, found one link at a time

The adapter made the code correct. Driving a real deploy through it then found that **nothing on
the path from a customer's CI to a running function had ever been granted**. Each link failed in the
customer's log as a bare number:

| What the customer saw                    | What was actually missing                                               |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `Unable to resolve action ... not found` | the action's repository is private                                      |
| `curl: (22) ... 404`                     | `SERVICE_BUILD_BUCKET` unset; the fallback names a bucket in no account |
| `curl: (22) ... 403`                     | the instance role has no `s3:PutObject` on that bucket at all           |
| (would have been) `AccessDenied`         | no `lambda:CreateFunction`, no `PublishVersion`, no `iam:PassRole`      |

Four links, one path, none of them exercised. The shape repeats inside the repository too: the grant
for the _assets_ bucket exists in `compute.tf` with a comment explaining exactly why it must — "a
presigned URL carries the signer's authority" — and the **build archive, the other half of the same
deploy, has no grant at all**. `tenant-static.tf` opens by describing the missing-bucket bug for the
assets bucket, fixed, one line above the identical bug in its neighbour.

The assets grant would not have worked either: `kms:GenerateDataKey` was absent, so a PUT into that
SSE-KMS bucket would have been refused by KMS and reported by S3 as `AccessDenied` on PutObject —
the displaced error the comment three statements above already warns about for reads.

So the recurring failure is not "somebody forgot a permission". It is that **each fix was made where
the symptom appeared and never applied to its neighbour**, and nothing walked the path end to end
because the path terminated in a failure that had a different, plausible explanation.

## What would have caught it

Not a review. A deploy. `bin/check-app-config.mjs` now reads the application as well as the three
configuration lists, which closes the `SERVICE_BUILD_BUCKET` shape — but no static check would have
found an IAM statement that is absent rather than wrong. The only thing that finds an ungranted
permission is exercising it, and until this week nothing in this repository ever had.

## The asset path that goes nowhere

One more of the same family, found by reading forward rather than by a failure. The deploy action
uploads a customer's static assets to `static/<project_id>/<digest>.zip` and names the key in the
release; `POST /deploy/release` accepts `static_key` in its schema and **never reads it**. Nothing
records it on the deployment, nothing unpacks the archive, and nothing serves from that bucket — the
only CloudFront distribution in `tofu/` fronts the platform's own SPAs.

Next's standalone output _excludes_ `.next/static` and `public/` because it assumes a CDN. So a Next
site deployed here would have answered 200 for every page and 404 for every stylesheet, script and
font: correct HTML, unstyled site. `resolve-preset.sh` opens by describing exactly this failure and
calling it invisible to a health check and to `curl /` — and then the upload it introduced had
nowhere to go.

For now the action copies both directories into the archive, which is Next's own documented
instruction and needs no CDN. The separate upload stays, because serving assets from Lambda is the
wrong long-run answer — but "wrong long-run answer" beats "the site has no CSS", and the difference
between the two was one unread field.

### Addendum, 2026-08-27: the static path now has a destination

The gap above became blocking while executing Phase 9 of the legacy
`read-the-readme-md-to-eventual-dusk` plan. That plan requires the dashboard and admin children to
deploy through the `static` preset; recording a successful deployment row while no browser could
load it would have repeated the original finding. The sandbox handoff's warning applies here too:
an interface demonstrated against a substitute is not the production path demonstrated.

This addendum is part of the audit trail requested by the legacy planning and reporting set, not a
replacement for it. The source context is
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`,
`/Users/andrew/.claude/plans/double-sorted-meteor.md`, `private_notes/groups.md`, and
`private_notes/sandbox-handoff.md`. The first plan supplied the six-deployable Phase 9 matrix; the
second and the private reports explain the surrounding sandbox, metering, and production-parity
work that must still be verified after this static-serving prerequisite lands.

The release now records the preset, archive key, and digest. The publisher verifies the uploaded
zip's digest and safety limits, expands it into immutable `sites/<project>/<digest>/` objects, then
atomically moves a CloudFront key-value-store pointer for the hostname and writes an exact DNS
record. That exact record wins over the Lambda wildcard. CloudFront's viewer-request function maps
the host through the pointer before cache lookup, so neither a failed upload nor a second tenant can
partially replace the live tree. The serving grant includes both the S3 origin policy and the KMS
decrypt policy; either one alone produces the same displaced S3 403 described above.

The integration test deliberately asserts what the former code never did: a release row becomes
real S3 objects and an edge pointer, no Lambda is invented, no Valkey route points at a nonexistent
function, and the row becomes ready only after activation. The final proof remains the legacy
plan's production Chrome pass for both SPAs after this infrastructure is applied.

## `cannot execute binary file`

The first function to publish and take traffic returned the router's error page. The chain to that
point was entirely sound — DNS, TLS, the route lookup, the alias, the invoke — and the function
itself died at init:

```
/opt/extensions/log-extension: /opt/extensions/log-extension: cannot execute binary file
INIT_REPORT Phase: init  Status: error  Error Type: Extension.Crash
```

`publishFunction` never set `Architectures`, so Lambda used its default of `x86_64`. The log
extension is built for `aarch64-unknown-linux-musl` — `AGENTS.md` names that target — and its layer
declares `arm64`. Lambda attached it to an x86_64 function without complaint and crashed every
invocation, reported as the _customer's_ function failing.

**The extension has therefore never run.** It has been attached to every publish since it was
written, and every one of those functions was the wrong architecture — which nobody could see,
because no function ever served a request.

Nothing in this repository builds or publishes that layer. `services/log-extension` is a crate; the
layer in the account was published by hand, once, and its architecture is a fact only AWS knows.
That is the same class as the certificate made by hand earlier in the week, and it is why the
architecture is now a named constant next to the code that publishes with it, rather than a default
nobody chose.

arm64 is the choice, not x86_64: Graviton is cheaper for identical work, and it is what the one
binary this platform ships is already built for. The cost is that a build produced on a GitHub
`ubuntu-latest` runner is x86-64 output, so the deploy action now refuses an archive containing
x86-64 `.node` files and names them — a module-not-found at runtime names a file, never an
architecture.

`Architectures` cannot be changed by `UpdateFunctionConfiguration`, so a function published before
this has to be deleted to move.

## The observability killed the thing it observed

With the architecture corrected the extension finally _ran_, and killed the function anyway:

```
Error: KAFKA_BROKERS is not set; the extension has nowhere to send logs
INIT_REPORT Phase: invoke  Status: error  Error Type: Extension.Crash
```

The layer in production is a build old enough to want `KAFKA_BROKERS`. The platform stopped setting
it when logs moved to the router's token endpoint — `publish.ts` still carries the comment
explaining that change — and nothing rebuilt or republished the layer, because **nothing in this
repository builds or publishes it**. `services/log-extension` is a crate; the artifact in the
account was uploaded by hand and its contents are a fact only AWS knows.

That is the deeper problem. The layer's _architecture_ was wrong and its _code_ was months stale,
and neither was visible from the source tree, because the source tree does not produce it.

Two faults, and only one is the staleness:

- `Sink::connect()` was fatal at startup. `send_batch` five lines away already says why it must not
  be — "an extension that exits takes the customer's function down with it, and losing a log line is
  not worth an outage of their application" — and that rule was applied to sending and not to
  starting, where it matters more: a send failure loses a line, a startup failure loses every
  invocation. Fixed; a sink that cannot be built now drops lines and says so.
- The extension was attached to every customer function by default, so a bad build of it was a
  platform-wide outage rather than a degraded feature. Attachment now defaults off and has two
  explicit stages: `LOG_EXTENSION_CANARY_PROJECT_IDS`, then `LOG_EXTENSION_ENABLED`. Merely leaving
  an old `LOG_EXTENSION_LAYER_ARN` in Parameter Store cannot attach it.

The rule this leaves: **an observability component must fail quieter than the thing it observes.**
An extension that can crash the application is not monitoring it, it is a dependency of it.

### 2026-08-27: the repository owns the layer

The hand-published artifact is no longer an acceptable input to production. The Deploy workflow now
builds `services/log-extension` on the same arm64 runner as the platform, targets
`aarch64-unknown-linux-musl`, packages the binary at the only path Lambda discovers
(`/extensions/log-extension`), and refuses an archive that is not an AArch64 ELF, has a dynamic
interpreter, loses its executable bit, or contains another path. CI builds and checks that exact
archive independently. Publishing requires an explicit workflow-dispatch input; an ordinary push to
`main` cannot create or select a layer version. After Lambda accepts it, the workflow records the
returned version ARN in Parameter Store before the website release can fill an idle colour.

The deployment role gains only `PublishLayerVersion` for the named layer and `PutParameter` for the
one ARN. That policy must be applied before the first explicit publish. Attachment still does not
happen then: one project id is allowlisted, its customer function is republished and invoked, and
only a successful customer response plus both durable `site_request` and `site_gib_second` rows are
evidence for the global switch. Those two dimensions now share a live integration assertion through
signed ingest, Kafka, ClickHouse, and the Valkey projection; a generic metering row is not used as a
substitute for site billing.

Putting Kafka in the TypeScript CI job exposed one more version of the same error. Its bootstrap
script said its `runtime_log` table was the same statement as the canonical schema, but omitted the
codecs, three-day TTL, and whole-part expiry setting. The retention test failed against the table the
bootstrap had actually created. The script now carries the canonical table definition; the comment
is no longer the only thing keeping them "the same."

This closes the production gap recorded across the legacy launch material without rewriting its
history: `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` established that the
Telemetry extension supplies site billing, `/Users/andrew/.claude/plans/double-sorted-meteor.md`
moved durable usage to Kafka/ClickHouse with Valkey as the fast view, `private_notes/groups.md`
records the production request path and its prior false-positive verification, and
`private_notes/sandbox-handoff.md` records the same rule for provider work: demonstrating an
interface against a substitute is not production verification. The remaining production proof is
therefore deliberately a rollout step, not a claim made by this change.

Rollback has an immutable edge: changing either attachment switch prevents future functions from
receiving the layer, but cannot remove it from a Lambda version already published. A canary that
fails must be republished without the layer. That is why the rollout begins with one disposable
project rather than relying on a switch to undo a platform-wide attachment.

## What it took to serve one request, end to end

The list, in the order each was hit, because the shape matters more than any single item:

| #   | Failure the customer would see         | What it actually was                                                   |
| --- | -------------------------------------- | ---------------------------------------------------------------------- |
| 1   | `Unable to resolve action … not found` | the deploy action's repository is private                              |
| 2   | `curl: (22) … 404`                     | `SERVICE_BUILD_BUCKET` unset; fallback names a bucket in no account    |
| 3   | `curl: (22) … 403`                     | the instance role had no `s3:PutObject` on that bucket                 |
| 4   | (never reached) `AccessDenied`         | no `lambda:CreateFunction`, `PublishVersion` or `iam:PassRole`         |
| 5   | `Runtime.HandlerNotFound`              | the presets build a web server; we published `index.handler`           |
| 6   | `Extension.Crash`                      | the log extension is `aarch64`; functions defaulted to `x86_64`        |
| 7   | `Extension.Crash`                      | that layer is a build old enough to want `KAFKA_BROKERS`, and it exits |
| 8   | `Cannot find module 'next'`            | symlinked directories not descended into: a 234 KB archive             |
| 9   | `Cannot find module '@swc/helpers/…'`  | dereferencing them instead, which destroys pnpm's resolution           |
| 10  | `app is not ready after 28000ms`       | the app read `API_PORT`; the adapter waits on `PORT`                   |
| 11  | `ECONNREFUSED 127.0.0.1:6379`          | Valkey wrote `REDIS_URL`; that app reads `VALKEY_URL`                  |
| 12  | `ECONNREFUSED 127.0.0.1:5432`          | two children of a group cannot share one database                      |

Twelve, and **not one of them was a bug in the code that was written**. Every piece was
individually correct: the publish logic, the packaging, the IAM policy file, the extension, the
presets. What was wrong was the joins between them, and every join was invisible from either side.

Three properties made them invisible together:

- **A default where configuration should have been.** `sproutos-dev-artifacts`, `x86_64`,
  `localhost:6379`, `3001`. A default cannot fail loudly, because it is indistinguishable from a
  choice.
- **An artifact nothing in the tree produces.** The extension layer's architecture and its code had
  both drifted, and no amount of reading this repository could reveal either.
- **A neighbour already fixed.** The assets bucket had the grant; the build bucket did not. The
  assets bucket's missing-bucket bug is written down at the top of `tenant-static.tf`, one line
  above the identical bug in its sibling.

The last one is the one to watch for. Every fix in this list already existed somewhere in the
repository, applied to something adjacent, with a comment explaining why it was necessary. The
question that finds these is not "is this correct" but **"what else is like this, and did the fix
reach it?"**
