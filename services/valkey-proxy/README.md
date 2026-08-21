# valkey-proxy

A tenant points BullMQ or Celery at this as though it were Valkey. It terminates the protocol,
works out who is connecting, rewrites every key into that tenant's namespace, and forwards to a
shared backend.

> TASK 20: Workflows use BullMQ or Celery which uses a shared valkey instance. We use a proxy that
> receives valkey commands and adds it to a master valkey queue such that this proxy consumer
> continuously receives jobs from all projects and spins up services as needed.

## Why a proxy rather than a Valkey per project

A Valkey per project is a container per project, sitting idle between jobs. A project that runs one
nightly report would pay for a process that is awake 24 hours to be useful for forty seconds. A
prefix per project costs a few dozen bytes.

That is the entire cost argument for the product, applied to queues.

## Tenancy is a key prefix, not a database

Valkey has numbered databases and they are the obvious answer. They are the wrong one: **Valkey
Cluster supports database 0 only**, so a tenancy design built on `SELECT` cannot ever be sharded —
and the point of a shared instance is that one day it will not fit on one machine.

So every key is prefixed, and the prefix carries a **hash tag**:

```
{kv:01j4pkz2hbfh6sw7sa7d65tvkz}:bull:emails:wait
 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ hashed for shard placement
```

Cluster hashes only what is between the braces, so every key belonging to one queue lands on one
shard. That is not a performance nicety: BullMQ's Lua scripts touch several keys at once, and
Cluster refuses a script whose keys live on different shards. Without the tag, BullMQ does not work
at all past a single node.

**The prefix is per resource, not per organization.** A customer with a queue for emails and a queue
for video encoding would otherwise find both writing `bull:jobs:wait` into the same place.

## The command table is an allowlist, and unknown means refuse

`commands.rs` maps each verb to where its keys are — a fixed position, a range, a range with a
trailing timeout, or a `numkeys` count for `EVAL`. **A verb that is not in the table is refused.**

A key the proxy fails to namespace is a key in the shared root of the keyspace, which every tenant
can reach. Forwarding an unrecognised command hoping it has no keys is a bet that loses silently,
so the default is no.

Deliberately absent, and refused: `SELECT`, `FLUSHALL`, `FLUSHDB`, `KEYS`, `SCAN`, `RANDOMKEY`,
`CONFIG`, `SHUTDOWN`, `DEBUG`, `SCRIPT`, `CLIENT`, `CLUSTER`, `ACL`, `REPLICAOF`, `MONITOR`,
`SWAPDB`, `MIGRATE`. Each is either a way to reach past a namespace or a way to take the instance
down for everyone sharing it.

A refused command is an error the tenant can read; **the connection stays open**, because one stray
command from a library should not take a worker down.

## The reply that echoes a key

Replies are forwarded byte for byte — a proxy that reinterprets every reply shape breaks the day the
server grows a new one. There is exactly one exception:

```
BLPOP jobs 0   →   1) "jobs"      ← the key, as the client sent it
                   2) "payload"
```

The key the _server_ saw is the namespaced one. Sent back unchanged, the tenant reads
`{kv:…}:jobs` out of the reply — and BullMQ does read it — then sends it as the next command's key,
where it is namespaced a second time. The queue splits in two and jobs stop being delivered.

So for `BLPOP`, `BRPOP`, `BZPOPMIN`, `BZPOPMAX`, `BLMPOP` and `BZMPOP` the first element is
un-namespaced on the way out. That is the only reason `reply.rs` parses reply framing at all.

## One client connection, one backend connection

Not multiplexed, deliberately, for two reasons:

- BullMQ blocks on `BZPOPMIN` and `BRPOPLPUSH`. A blocking command on a shared backend connection
  stalls every other tenant on it.
- **RESP has no request ids.** It relies entirely on ordering, so the only safe way to interleave
  two clients on one backend connection is not to.

The same fact is what makes reply rewriting possible: a FIFO of pending verbs is an exact record of
which reply is arriving next. It is bounded (`MAX_PENDING`), because a client can pipeline without
ever reading, and an unbounded queue would let one connection grow the proxy's memory without limit.

## Authentication

`AUTH <username> <secret>`, where the username _is_ the routing information:

```
kv_<resource-short-id>.<organization-short-id>
```

The wire protocol hands a proxy a username and a secret and nothing else — no header, no token, no
routing hint — so the username has to carry which resource the connection is for. `lib/rust/tenant-auth`
parses it, and parsing is **identification, not authentication**: it says who the connection claims
to be.

`credentials.rs` makes the claim true. It reads `service_credential` from the control-plane Postgres
directly rather than calling the internal API, because a queue must keep draining while the API is
deploying. The presented secret is hashed and compared to the stored value.

Three properties worth stating outright:

- **"No such tenant" and "wrong secret" are the same answer.** Distinguishing them is an oracle for
  enumerating which tenants exist, one `AUTH` at a time.
- **A lookup failure is not a wrong password.** If the control plane is unreachable or a stored hash
  is corrupt, the tenant is told the service is unavailable and an operator is told the truth. Saying
  "wrong password" sends whoever is on call to debug the tenant instead of the database.
- **There is no cache.** A lookup happens once per connection and connections are long-lived, so the
  saving would be small — and a cache is exactly what makes a revoked credential keep working after
  a rotation commits, which is the one thing rotation exists to prevent.

An unauthenticated connection can send `AUTH`, `PING` and `QUIT`. Nothing else reaches the backend,
and no backend connection is opened until authentication succeeds — otherwise an unauthenticated
flood exhausts the connection pool.

### The secret is stored as SHA-256, not Argon2

Argon2 exists to make a _guessable_ secret expensive to guess. These secrets are 256 bits from the
OS CSPRNG and the tenant never chooses one, so a work factor buys nothing against 2^256 candidates.
What it would buy is a denial-of-service lever: at 19 MiB and tens of milliseconds per attempt, a few
hundred concurrent connections exhaust the proxy before any of them sends a command.

`verify_secret` reads both encodings and dispatches on the stored value, so a credential a human
chose can still be Argon2 and rotating one upgrades it without a migration.

## Why Rust

This is per-command work on every job a tenant enqueues. A Node process between BullMQ and Valkey
pays an event-loop hop and a GC pause for what is byte shuffling. It also ships as a sidecar on
metal that is metered by the second, so a static musl binary that starts instantly is worth real
money.

## Configuration

| Variable                    | Default                      | What it is                                                                                |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| `VALKEY_PROXY_LISTEN`       | `0.0.0.0:6379`               | Where tenants connect                                                                     |
| `VALKEY_PROXY_BACKEND`      | `127.0.0.1:6379`             | The shared Valkey                                                                         |
| `VALKEY_PROXY_DATABASE_URL` | falls back to `DATABASE_URL` | Control plane, for credential lookups                                                     |
| `VALKEY_PROXY_DB_POOL`      | `4`                          | Control-plane connections. Small on purpose: one lookup per _connection_, not per command |

The database role needs `select` on `service_credential` and `backend_service`, and `update` on
`service_credential.last_used_at`. Nothing else. It is not the migration role.

The URL is checked at boot, so a misconfiguration stops a deploy rather than turning every tenant's
authentication into an operational error.

## Testing

```bash
docker compose up -d
pnpm --filter=dbmigrator run migrate:latest
DATABASE_URL=... cargo test -p valkey-proxy
```

Unit tests cover the RESP parser, the command table, and reply framing. `tests/proxy.rs` is the one
that matters: it provisions two real tenants in Postgres, drives real clients through the proxy to
the real Valkey, and asserts that neither can see the other's keys — checked **from outside the
proxy**, by reading the raw keys the backend actually holds. A proxy that forwarded one command
unnamespaced would still pass an inside-the-proxy check, because the tenant that wrote the key would
read its own value back.

The integration tests skip rather than fail when the services are not running.

## The master queue

TASK 20's second half, and the reason this proxy is the only place it can live: it sees every
enqueue, so it can report one without polling a keyspace that holds every tenant's keys.

```
ZADD sproutos:master:wake GT <epoch_ms> "<resource-short-id>/<queue>"
```

Not the job — a job belongs to the tenant, and copying one into a shared structure would put a
customer's payload somewhere another customer's dispatcher could read. Only the smallest fact that
lets the control plane act: *this queue was written to, at this time*.

A sorted set rather than a list, and that is the whole design. The member is the queue, so a
thousand enqueues in a second collapse to one entry; the score is when work last arrived, which is
exactly what a scale-to-zero decision needs; `GT` keeps the newest so two replicas cannot make a
queue look staler than it is.

**On its own connection.** RESP has no request ids, so this proxy tracks replies by position in a
FIFO. An extra command on a client's backend connection would put a reply in that stream nothing is
waiting for, and every reply after it would be attributed to the wrong request. The master queue
therefore owns one connection, fed by a channel, and every failure in it — a full channel, an
unreachable backend, a failed write — is logged and dropped. A tenant's command must never fail
because the platform's bookkeeping did.

Off unless `VALKEY_PROXY_MASTER_QUEUE` is set: reporting into a set nothing consumes is write
amplification on the tenant instance.

`dispatchQueues` in `@lib/jobs` is the consumer.

## Not built yet

- **Metering.** TASK 25's queue-dwell dimension has `workflow_run.bytes_enqueued` and
  `valkey_dwell_ms` as columns with no writer. This proxy is the only place that can honestly fill
  them, via `metering-proto`.
- **TLS.** `SERVICE_VALKEY_SCHEME` defaults to `rediss` in the driver, but the proxy speaks plain
  TCP; termination is expected in front of it and that is not wired.
- **A key reaper.** `destroy` revokes the credential, which makes the keys unreachable — the prefix
  is derived from the service id and nothing else can name it — but does not delete them. Reclaiming
  the memory needs an out-of-band walk, because scanning a shared instance is the one operation this
  proxy refuses on principle.
