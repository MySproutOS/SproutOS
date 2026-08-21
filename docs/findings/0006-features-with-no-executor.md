# 0006 — Features with no executor

Found by signing in on a real domain and clicking the buttons.

Every item here is a feature that exists in the database schema, in the API, in the type
definitions, and in the UI — and that nothing carries out. The schema knows the shape, the route
returns 201, the screen renders, and the work never happens.

This is a different failure from a bug. A bug produces a wrong answer; these produce **no answer,
silently, while reporting success.**

---

## 1. The fork button had no handler

`<Button size="sm">Fork this app</Button>`. No `onClick`, no request, no error.

It is the single action the product exists to perform. Clicking it did nothing at all.

**Why nothing caught it:** the page rendered, the button was enabled, the click landed, and the
network panel stayed empty. A screenshot test passes. A route smoke test passes. There is no
automatic check anywhere that says "this control should cause a request".

**Fixed** by wiring it to `POST /v1/orgs/:orgSlug/projects`, which had accepted
`source: { type: "store", … }` since the routes were written.

Two details the missing handler also had to get right. The idempotency key is minted once per visit
to the page — per click would defeat the API's idempotency, since each retry would carry a new key
and read as a new fork; a module-level constant would make a deliberate second fork impossible. And
the failure renders rather than logging, because "nothing happened" had already been mistaken for
"it worked" once.

---

## 2. Nothing executed a `project_job`

The route wrote a `project` row, a `repository` row with no `github_repo_id`, and a `project_job`
whose four steps were all `pending`.

`PROJECT_JOB_STEPS` describes them precisely:

```
fork: Forking the upstream repository
      Linking the GitHub App installation
      Detecting build settings
      Running the first deploy
```

No code moved a step out of `pending`. `crudProjectJob` had `create`, `enqueueOnce` and `update`;
`fetchProjectJob` had three readers; every writer was the API.

`lib/typescript/github` already had `forkRepository`, `createPersonalRepository`,
`createOrganizationRepository` and `generateFromTemplate` — written, documented, tested, and called
by nothing.

**How it looked:** a fork returned 201 with a project and a job, the UI showed a four-step progress
list, and GitHub was never contacted. The progress list looked like a job about to start, which is
indistinguishable from one that will never start.

**Fixed** by `lib/typescript/jobs/src/provision.ts`. The part worth keeping in mind is what it does
_not_ claim: the three steps it cannot perform — the installation link needs a GitHub App private
key this deployment does not have, settings detection is the analyzer, the first deploy is the build
pipeline — are marked `skipped`, not `succeeded`. Marking them succeeded would be the same lie the
job already told, with a progress bar reaching 100% for work nobody did.

---

## 3. TASK 9's step-up was a constant with no caller

```typescript
export const GITHUB_REPOSITORY_SCOPES = ["read:user", "user:email", "repo", "read:org"] as const
```

Exported, documented with a paragraph about why `repo` is coarse and why the step-up is deliberate —
and **never passed to anything**. `grep` found exactly two references: the declaration, and a
re-export.

So a user could sign in, click fork, and reach a token GitHub had only ever granted `read:user` and
`user:email`. The failure surfaces as a 404 on a private repository, not a 403, which sends the
reader hunting for a typo.

**Fixed** by `/login/github?scopes=repository`. Still not the default, for the reason the original
comment gave: asking at the front door would mean every visitor grants access to every private
repository they can see in order to look at a dashboard.

---

## 4. Nothing wrote `usage_rollup`

Recorded fully in the commit that fixed it; repeated here because it is the same shape. The ingest
route wrote `usage_event`. The billing library and the billing routes read `usage_rollup`. Nothing
wrote a row into the table between them, and the ingest route's own comment described "a job that
reads `rated_at IS NULL`" that did not exist.

Every project's cost rendered as `$0.00`, forever, regardless of what it consumed.

---

## The tell

All four had **documentation describing the behaviour they did not have.** The step comment listed
four steps nothing performed; the scope constant explained a step-up with no route; the ingest
comment named a job that was never written; the fork button was captioned with the action it did not
take.

That is worth stating plainly, because it inverts the usual heuristic. A well-commented, well-typed,
well-structured region of a codebase reads as _more_ trustworthy, and here the comments were the
strongest evidence available that the feature existed. They were written by someone reasoning about
what the code should do, at a time when it was going to.

The only thing that distinguished the four was pressing the button.
