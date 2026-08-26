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
