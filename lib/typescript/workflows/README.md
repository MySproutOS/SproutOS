# @lib/workflows

Workflow graphs: validation, versioning, and what a run costs.

## A graph that cannot run should fail in the editor

TASK 20 asks for an n8n-shaped editor, so the stored artifact is a graph rather than a script.
Everything in `validateGraph` exists so a broken workflow is rejected at save time, with the
offending node named — rather than at 3am, half-executed, with a partial run to reconcile.

The checks run in the order a person would want to hear about them: structural problems first (a
node with no id is not a graph), then problems of meaning. Reporting a cycle before noticing that
an edge points at a node which does not exist would send someone hunting for a loop that is really
a typo.

| rejected                        | because                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no trigger                      | nothing starts it                                                                                                                                                       |
| two triggers                    | two entry points, and no single answer to "what ran, and why" — two workflows sharing a sub-graph is the shape that works                                               |
| a cycle                         | reported by DFS, naming **the node the loop closes on**, because the editor needs something to highlight; a topological sort could only say "some nodes were left over" |
| a self-edge                     | a cycle of length one, named as itself rather than as "there is a cycle"                                                                                                |
| an edge back into the trigger   | same                                                                                                                                                                    |
| a node the trigger cannot reach | a node the editor draws and the runner never executes is a lie about what the workflow does, and it is invariably a disconnected edge someone meant to attach           |

`topologicalOrder` breaks ties on node id rather than leaving them to Map iteration order. A run's
step order lands in a log someone compares across runs, and "the same graph produced a different
order" is a bug report nobody can act on.

## A version per change, not per nudge

`hashGraph` excludes canvas coordinates and sorts config keys, so dragging a node around and
saving produces the same hash and no new version. Verified against the running API:

```
first save                → version 1, unchanged: false
same graph, nodes moved   → version 1, unchanged: true
changed a node's config   → version 2
changed the cron          → version 3
```

A version per nudge makes the history useless for the question it exists to answer: what actually
changed about what this runs.

## What a run costs (TASK 25)

> billing based on number of jobs, size of the job in valkey, and how long it's been in valkey in
> addition to the actual execution

Four dimensions. The middle two are why `workflow_run.bytes_enqueued` and `valkey_dwell_ms` are
separate columns rather than a single "queue cost": the charge is bytes **×** seconds, computed at
rating time against the price book that was in force, and either factor alone means nothing.

The dwell charge is the one people find surprising and the one that reflects reality — a job
sitting in a queue for six hours holds memory on a Valkey instance we pay for the whole time,
whether or not it ever runs.

The arithmetic is bigint throughout. 1 MB held for a day is 9.06 × 10¹⁰ byte-seconds, past the
point where a float is a promise rather than a number, and the rate is 0.000001 micro-USD per
byte-second — the dimension that would floor to zero as an integer, and the reason
`price_book_item.unit_micro_usd` is `numeric(38,9)`.

## TASK 35, and the half that is missing

**Peering into a job is here.** `GET .../runs/{runId}` returns the run, its steps with inputs and
outputs, and what it cost. It is gated on `workflow:job:read` rather than `workflow:read`, because
step inputs carry whatever the workflow was processing — a customer record, an invoice, an API
response. Being allowed to see that a workflow exists is a different thing from being allowed to
read what it handled.

**Modifying job data is not.** The payload is not in Postgres: `workflow_run` has no `input`
column, because a queued job lives in Valkey where the tenant's BullMQ or Celery client put it.
Editing it means writing to that queue through the proxy TASK 20 describes, which does not exist
yet.

`workflow_job_edit_audit` is waiting for it, with a `RESTRICT` foreign key so the history cannot be
deleted along with the run, and a `NOT NULL` reason — because an audit row saying only who and when
answers none of the questions asked after someone edits what a customer's workflow will do to a
customer's data. Shipping the endpoint now would mean recording an edit that never reached the
queue.
