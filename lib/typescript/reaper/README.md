# `@lib/reaper`

Deleting a tenant's data from the three stores Postgres does not know about.

## Why this exists at all

`destroy` on a backend service revokes the tenant's credential, stamps `deleted_at`, and stops.
That is the right shape for the request — a customer clicking delete gets an answer immediately —
but on its own it is a promise rather than a deletion. The keys, the indices and the log rows are
still there.

They are also _unreachable_, which is a genuinely useful property and not the same promise. Every
namespace is derived from the service's UUID and no other tenant can name it, so a revoked
credential means nobody can get at the data. "Nobody can reach it" is what a suspension owes a
customer. "It is gone" is what a deletion owes them, and it is what this module does.

## Why it is a separate pass and not part of the delete

Failure, not latency.

Deleting an OpenSearch index is a cluster operation that can fail, be retried, and fail again.
Inside the request, that means a customer's delete returns 500 with the credential already revoked
and nothing scheduled to try again — the worst of both, because the service is unusable _and_ the
data is still billed to us. As a job, a failure is a row in `background_job` that runs again in an
hour, and the only thing an unfinished purge costs is disk.

The queue is `deleted_at is not null and purged_at is null`, indexed partially so that the index
holds only the work outstanding and empties itself as the reaper drains it.

## The three stores

| Store      | What is deleted                             | Why it cannot be left alone                                                                                      |
| ---------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Valkey     | Every key under `{kv:<short-id>}:`          | Memory. A shared instance's is the smallest of the three.                                                        |
| OpenSearch | Every index under `t<short-id>_`            | **Shards** — the resource a shared cluster actually runs out of, held whether or not anyone can reach the index. |
| ClickHouse | Every `log_record` row for the organization | Nothing owns them: the rows live in another database with no foreign key and no cascade.                         |

Postgres is deliberately absent. Its driver drops the database and the role inside `destroy`,
because it can — two statements against a server we administer, and `drop database … with (force)`
cannot be left half-done. There is nothing for a reaper to finish.

## The hash tag pays off twice

Valkey keys are namespaced `{kv:<short-id>}:` rather than `kv:<short-id>:`, and the braces are a
Valkey Cluster hash tag: everything a tenant owns hashes to one slot. That was chosen so a tenant's
`MULTI` and Lua scripts stay legal on a cluster.

It pays off again here. `CLUSTER GETKEYSINSLOT` reads the slot's key index directly, so deleting a
tenant costs what the tenant holds. The fallback — `SCAN MATCH` on a standalone instance — costs
what the _whole instance_ holds, because `SCAN` filters after reading each key and there is no index
from a prefix to the keys under it.

Two things in that path are easy to get wrong and are commented where they live:

- There are 16384 slots and more tenants than that, so a slot routinely holds several namespaces.
  `GETKEYSINSLOT` will hand back a neighbour's keys. The slot narrows the search; the **prefix** is
  what decides, and a test asserts the neighbour survives.
- `GETKEYSINSLOT` has no cursor. Every call returns the first _n_ keys of the slot from the
  beginning, so the window is widened rather than paged — otherwise a tenant whose keys sit behind a
  full page of somebody else's are never found.

`UNLINK`, never `DEL`. Both remove the key immediately, but `DEL` also frees the value on the main
thread, so deleting one tenant's large hash stalls every other tenant for as long as the free takes.

## Ordering

An organization is stamped only once every service it owns has been. Both stamps are independent,
so an organization marked finished while its services' purge kept failing would look done with its
indices still on the cluster — and nothing would be looking at the organization any more to notice.

## Tests

`reap.test.ts` runs against the compose Valkey and OpenSearch, and fails rather than skips under
`CI`. Every claim this module makes is a claim about another system's behaviour, and a mock would
assert a reading of the documentation — which is the thing most likely to be wrong about a reaper,
because it is the code path nobody watches and its failure mode is data that quietly stays.

## Not done here

- **Retention** is separate and lives where the data does: `log_record` has a per-row TTL,
  `agent_event` has `expires_at` and a purge job in `@lib/jobs`. This module is for deletion, which
  is a customer's request rather than a schedule.
- **Object storage** — build artefacts and container images — has no reaper yet, because nothing
  writes to it in a deployment we can run. It belongs here when it does.
