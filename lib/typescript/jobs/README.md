# @lib/jobs

One background job runner: Postgres, `SKIP LOCKED`, leases, and a dead letter.

## Why there is exactly one

Nine independent schedulers were proposed during design — for fork upkeep, retention sweeps, hold
expiry, usage rating, upstream sync — and every one of them was a job type wearing a scheduler
costume. They all enqueue a row into `background_job` and are claimed by the same loop.

A second scheduling mechanism is a second place for work to get stuck, and a second thing to check
at three in the morning when something did not run.

There is no cron table either. **A recurring job is a row whose idempotency key names the window it
belongs to** (`billing.expire_holds:2026-08-20T10`). Every worker calls `scheduleRecurring` on a
timer; all but one collide on the unique constraint and insert nothing. No leader election, no
coordination.

## `claim` is a CTE, and that is not a style choice

```sql
WITH ready AS (
  SELECT id FROM background_job
   WHERE state = 'queued' AND run_at <= now()
   ORDER BY priority DESC, run_at ASC
   LIMIT $n FOR UPDATE SKIP LOCKED
)
UPDATE background_job SET … FROM ready WHERE background_job.id = ready.id RETURNING …
```

The obvious alternative — `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` — reads
identically and **does not reliably bound the UPDATE**. Written that way, `claim(limit: 1)` was
observed returning _three_ jobs against the real table. The worker ran one and left the other two
in `running` until their leases expired, so the queue advanced one job per lease interval and
looked like a hang.

Run again by hand, the same statement returned one row. It is plan-dependent, which is worse than
being consistently wrong: it behaves in a small test and misbehaves under load. A CTE is an
optimization fence, so the limit and the row locks are evaluated exactly once — correct by
construction rather than by luck. This is why the canonical SKIP LOCKED queue is always a CTE.

`queue.test.ts` pins the contract but does **not** reliably reproduce the failure, and says so.

## Leases, not locks

The claiming transaction commits immediately. A worker that dies mid-job therefore does not hold a
database connection open until someone notices — it holds a `lease_expires_at` that passes.

`reclaimExpired` returns those jobs to the queue **without resetting `attempt`**. A job that
reliably kills its worker should dead-letter, not take out every worker in the pool one at a time,
forever.

`attempt` is incremented at **claim**, not at failure, for the same reason: a worker killed mid-job
never reaches `fail()`, and an attempt counted there would make such a job immortal.

`heartbeat` is scoped to the holder, so a worker whose lease was already reclaimed and handed on
cannot extend it back out from under its new owner.

## `run_at` defaults to the database clock

`enqueue` writes `now()` rather than `new Date()`. `claim` compares `run_at <= now()` **in
Postgres**, so a default taken from the application clock makes a freshly enqueued job briefly
unclaimable whenever the two disagree — which they do, by the round trip if nothing else. This
showed up as tests that passed three times and failed the fourth. An explicit `runAt` is a real
schedule and is left exactly as the caller gave it.

## What ships with it

| kind                                 | what it does                                                                                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing.expire_holds`               | Frees reservations whose runner never came back. `availableBalance` subtracts active holds, so an abandoned one makes a customer's money unspendable. Charges nothing.                                                                                                |
| `billing.generate_statements`        | Daily idempotent reconciliation of immutable usage debits into UTC-month statements, followed by finalization of elapsed periods. New charges attach their detail in the ledger transaction itself; the job repairs exact older debits without inventing attribution. |
| `catalogue.discover_signed`          | Daily bootstrap and reconciliation entrypoint. Resolves the latest immutable Deployment-Templates release even with an empty database, checks its asset digest, verifies the exact trusted workflow provenance, then idempotently queues `catalogue.import_signed`.   |
| `catalogue.import_signed`            | Pulls the discovered immutable GHCR digest, repeats signature/provenance verification, validates all signed catalogue documents, and transactionally reconciles listings. Blocked manifests remain drafts and removed entries are archived.                           |
| `agent.purge_events`                 | Deletes agent transcripts past `expires_at`. `agent_event.payload` holds file contents from a customer's repository, and the 30-day default was a promise nothing kept. Bounded batches, so a neglected table cannot produce one statement that locks for minutes.    |
| `platform.purge_deleted`             | Finishes a deletion in the stores Postgres has no foreign key into — Valkey keys, OpenSearch indices, ClickHouse log rows. See `@lib/reaper`. Hourly, and retried more than the others because it talks to three systems we do not run in-process.                    |
| `platform.reconcile_search_security` | Hourly repair of missing or drifted OpenSearch users, roles, and mappings for live services. Reports orphan-shaped documents without deleting them, measures list/reload latency, and warns at the measured cardinality soft limit.                                   |
| `platform.reconcile_valkey_acl`      | Hourly bounded repair of missing or drifted Valkey ACL users for live queue services. Rotates drift inspection, reports orphan-shaped users without deleting them, and warns at the measured cardinality soft limit.                                                  |
| `platform.retention_sweep`           | Deletes rows whose retention window has closed, across seven tables. One job rather than seven schedules to keep in step. Nightly. See `docs/RETENTION.md` and `retention.ts`.                                                                                        |
| `upkeep.scan` / `upkeep.repository`  | Fork upkeep — see below.                                                                                                                                                                                                                                              |
| `analysis.repository`                | Reads a repository and says what it needs (TASKS 38–39).                                                                                                                                                                                                              |

Every one of them exists because something earlier promised a thing and left nothing to do it.

### Retention lives here, deletion does not

`platform.retention_sweep` is a **schedule**: rows stop being useful after a period, and the period
is defended in `retention.ts` next to the rule that enforces it. `platform.purge_deleted` answers a
**customer's request**, and runs against tables in three other systems. They are separate jobs
because they answer to different things — a retention period is our policy to change, and a deletion
is not.

The subtle one is refresh tokens, which are keyed on the token's own expiry rather than on when it
was consumed: reuse detection reads consumed tokens, so a sweep keyed on consumption would silently
delete a security control. `docs/RETENTION.md` has the reasoning, and a test holds the line.

## Running it

```bash
pnpm --filter=@api/internal run worker
```

A separate process from the API on purpose: a long job holding an event-loop turn inside the API
delays every request behind it, and a worker that needs restarting should not take the API down
with it. Both read the same table and nothing else coordinates them.

`runOne` is exported so a single job can be driven directly — which is what makes a new job type
testable without a poller running.

## Fork upkeep (TASK 27)

Two job kinds, and a rule about when to stop.

**`upkeep.scan`** finds repositories due under their `tag`, daily, weekly, or monthly policy and
enqueues one `upkeep.repository` job each, keyed on the repository and the day. Off is represented
only by `auto_update_enabled = false`. Interval eligibility is derived from the last durable sync
run, so missed scheduler windows catch up instead of disappearing. Scan-then-fan-out rather than one large job, because a single
job holding a lease while it reconciles two hundred forks is two hundred failures riding on one
lease.

Tag mode polls the complete upstream tag set once per day and fingerprints tag names plus target
commits. A changed fingerprint triggers the same guarded upstream sync; an unchanged poll advances
only `repository.upstream_tag_checked_at`. No `upstream_sync_run` is written for work that did not
happen.

**One job per _repository_, not per project.** TASK 21 lets several projects share a repository —
in this schema that means a monorepo, since `project_repository_target_live_key` is unique on
`(organization, repository, root_dir, production_branch)`. One reconciliation serves all of them,
and enqueueing per project would bill three times for one piece of work.

### When upkeep stops

Five consecutive `failed` runs pause a repository. Upkeep costs money on every run, and a fork
whose upstream has diverged past reconciliation fails identically every night forever.

**Derived from `upstream_sync_run`, not a counter column.** A counter is a second copy of something
the history already records, and the two disagree the first time a run is written by a path that
forgets to bump it — at which point the honest answer is in the history and the counter is a lie
that silently stops a customer's updates. Deriving it also means recovery needs no reset: one
successful run and the repository is due again.

**A `conflict` is not a failure.** It means upstream and the fork both changed the same lines,
which is the normal state of a fork someone is actually working on, and it produces a pull request
a person resolves. Counting it would pause exactly the repositories that are being used.

Runs are recorded for _every_ outcome, `up_to_date` included — otherwise a repository that failed
once and then had nothing to do for four nights would read as five failures in a row.

### What triggers work, and what it costs

`decideUpkeepAction` turns a comparison into one of three answers, and the ordering is the point:

| comparison               | action       | tokens |
| ------------------------ | ------------ | ------ |
| not behind               | skip         | none   |
| behind, no local commits | fast-forward | none   |
| behind **and** ahead     | reconcile    | none†  |

The middle row is the common case — someone forked an app and changed configuration, not code —
and paying a model to perform a mechanical fast-forward would be absurd.

The decision reads `behindBy`, not GitHub's `status` label: a comparison can report `diverged`
while `behindBy` is 0 depending on the base.

Forks go through GitHub's `merge-upstream` endpoint, server-side. Template-generated copies cannot:
GitHub gives them unrelated history. The trusted worker instead finds the upstream commit whose
tree matches the copy's generated root, performs an explicit three-way `ort` tree merge, and pushes
the result with an exact remote-head lease. It never checks out or executes repository files. A
missing base match, textual conflict, concurrent push, or Git older than 2.38 refuses the update.

The upstream is nevertheless a supply-chain trust boundary. A clean update may change a GitHub
Actions workflow, and pushing it can cause GitHub to execute that workflow under the repository's
own policy. Store templates are curated for that reason. This is the same boundary a fork accepts
when GitHub's `merge-upstream` moves its production branch; “the worker executes no files” does not
mean “the resulting repository can never execute them.”

### † The agent reconciliation is not built yet

`decideUpkeepAction` has always had three answers and the handler has three branches, but the third
one is not yet what TASK 27 ultimately asks for. Today a `reconcile` is attempted as a server-side
merge, which resolves everything that is not a genuine textual conflict. What comes back as a
conflict is recorded as `conflict` and raised to every subscribed project as a
`project_update_suggestion` — visible to a person, rather than silently dropped.

What is missing is the agent resolving a real conflict. The trusted worker can now perform and push
the deterministic merge for a template copy, but the agent sandbox is still never given its write
credential. An agent-assisted resolution therefore needs a bounded diff returned to this trusted
push path; it must not move the credential into the sandbox.

Until then a conflicted fork produces a suggestion, not a pull request. The `pr_opened` outcome and
the `sproutos/upkeep-<sha12>` branch name are reserved for that work and are not yet written by
anything.

### How this was found

`upkeep.repository` was declared in `JOB_KINDS` for weeks with **no handler registered**. `claim`
selects by the kinds the worker has handlers for, so the fanned-out jobs were never claimed, never
failed, never retried, and never appeared in any failure count — they simply accumulated at state
`queued` while the scan logged that it had scheduled them.

`handlers.test.ts` now asserts the two halves cannot drift apart in either direction: every declared
kind has a handler, and every handler answers to a declared kind.
