# @lib/analyzer

Read a repository and say what it needs to run here. TASKS 38 and 39.

## Two entry points, one artifact

> 38. Forking an open source project, especially if it's imported and not in our app store, means
>     we need an AI to analyze what backend services and modifications are needed to deploy the
>     full app.
> 39. Users can request to add open source projects, and we'll use AI to analyze what backend
>     services can be added on SproutOS and what modifications are needed to host it. However, the
>     AI billing comes out of the user's account.

Importing a repository and proposing one for the store want the same thing: a description of what
this project needs. So there is one analyser and one manifest, not two that drift. `manifest.services`
is what provisioning consumes; `manifest.modifications` is what becomes a pull request someone reads.

**The manifest is reviewable, not executable.** Nothing here is applied.

## The clone is unauthenticated, and that is the point

TASK 39 is about _open source_ projects, which are public by definition. So this path needs no
GitHub App — which is why it works today while the agent runner is still waiting on one.

A private repository fails at the clone with _"Could not clone owner/repo. It has to be a public
repository."_ and **costs nothing**, because the failure happens before the model is called.
`GIT_TERMINAL_PROMPT=0`, so it fails rather than hanging a worker on a username prompt.

## The model is shown a sample, not a repository

Sending everything is impossible for any real project and pointless besides: what a repository
_needs to run_ lives in a dozen well-known files, and a model reading 4,000 source files to find
them is spending the customer's money on the part it is worst at.

- A breadth-first tree, capped at 400 entries, skipping `node_modules`, `vendor`, `dist`, `.venv`
  and friends. Breadth-first so a deep vendored tree cannot consume the budget before the
  top-level files that matter.
- The contents of the files that answer the question: `package.json`, `pyproject.toml`, `go.mod`,
  `Dockerfile`, `docker-compose.yml`, `Procfile`, `.env.example`, `README.md`, and so on — each
  capped at 24 KB so a 5 MB README cannot crowd out `package.json`.

## Model output is validated, not trusted

`parseManifest` runs at the boundary, because the failure that matters is not a crash — it is a
manifest that looks fine and provisions the wrong thing.

| what a model does                         | what happens                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `"buildCommand": "none"`                  | read as `null`, because a build command of `"none"` would be _run_                            |
| `"port": "8080"`                          | coerced; `0`, `70000`, `"the default"` become `null`                                          |
| `"confidence": 0.8`                       | read as 80, not 0                                                                             |
| `"services": ["postgres", "kafka"]`       | `postgres` kept; **kafka moved to `unknowns`**, not silently dropped                          |
| `"name": "You will also need an API key"` | dropped — that is a sentence, not an env var                                                  |
| `"path": "../../etc/passwd"`              | dropped                                                                                       |
| fenced JSON, or a sentence of preamble    | extracted anyway; failing a run the customer paid for over three backticks is the wrong trade |

`unknowns` is first-class rather than prose in a summary, because an analyser that cannot say "I
don't know" produces a manifest someone trusts and shouldn't. A deploy that fails for a _stated_
unknown is a different conversation from one that fails for a reason nobody mentioned.

## It costs money, so it is a job

A clone, a tree walk, and a model call over a large prompt take about a minute. `POST /analyses`
returns `202` with a row to poll; the work happens on the background runner.

**A finished analysis is reused.** Two people proposing the same popular project on the same day is
the expected case, and the manifest describes a _commit_ rather than a moment — so the second
request returns the first result and charges nothing. A partial unique index enforces it, and only
a `failed` analysis leaves room to try again.

Two attempts, not five: an analysis that failed usually failed for a reason retrying will not fix,
and every attempt costs the customer tokens.

## Verified against a real repository

`sissbruecker/linkding`, through the API and the worker, billed to real credit:

```
POST /analyses                 → 202 queued
(worker claims, ~90s)
GET  /analyses/{id}            → succeeded, confidence 55, 117,712 micro-USD, commit 65813a75404b

runtime:       python 3.13        port: 9090        services: ["postgres"]
build:         pip install -U pip && pip install '.[postgres]' && npm ci && npm run build
env vars:      LD_DB_ENGINE, LD_DB_DATABASE, LD_DB_USER, LD_DB_PASSWORD, LD_DB_HOST, LD_DB_PORT
modifications: Dockerfile, uwsgi.ini
unknowns:      "…the exact expected port without Docker is not explicit"
               "…unclear whether Huey requires an external broker"
```

Every one of those is right, including the awkward part: linkding does not read `DATABASE_URL`, it
reads `LD_DB_*`, so a naive import that injected a connection URI would deploy an app that silently
used SQLite. That is exactly the class of problem this exists to catch.

A second request for the same repository and ref returned the same row and charged nothing. A
private repository failed with a usable message and cost nothing.
