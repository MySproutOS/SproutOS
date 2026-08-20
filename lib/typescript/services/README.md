# @lib/services

Backend services a customer can provision: one driver interface, one connection URI.

## TASK 37, and why it is one abstraction

> The user can also spin up connection uris for each individual backend service that they want.

`backend_service.project_id` is nullable, so the same table covers a database attached to a project
and one standing entirely on its own. Postgres, Valkey, and Elasticsearch differ in almost every
detail and in **none of the five things a control plane does to them**: provision, hand back a URI,
rotate, suspend, destroy. So there is one `ServiceDriver` interface and adding a kind is a driver,
not a second set of endpoints with their own shapes.

`postgres` and `valkey` are implemented. An unimplemented kind returns _"elasticsearch services are
not available yet"_ — a different answer from "something broke", and one the customer can act on.

## `sprout`, not Neon, and that is deliberate

`database_instance.provider` allows `neon | byo | sprout`. This driver is `sprout`: a database and
a role on an ordinary Postgres server we run.

Self-hosted Neon — branching, scale-to-zero, TASK 30 — is a separate provider on the same
interface, and it needs a pageserver and safekeepers that do not exist yet. `sprout` works today,
which makes it the honest starting point rather than a stub pretending to be branching storage.

## Provisioning is DDL, and DDL cannot be parameterized

Every identifier that reaches a statement is **derived from the service's UUID** and asserted
before use:

```
sprout_db_01a01e433cd375a38b15e142b9ba6e73
sprout_r_01a01e433cd375a38b15e142b9ba6e73
```

A customer's chosen name lives in `backend_service.name` and never goes anywhere near `CREATE
ROLE`. A UUID with the dashes stripped is 32 hex characters and cannot carry a quote, a semicolon,
or a newline — and `assertSafeIdentifier` checks that rather than assuming it. Both names are 39
characters, inside Postgres's 63-byte limit, where two long names would otherwise truncate to the
same identifier and collide.

The generated password _is_ interpolated, because Postgres has no bind parameters in DDL. It is
base64url and cannot close a quote, and it is escaped anyway.

## The URI

`postgresUri` percent-encodes the password, because a generated password can contain characters
that mean something in a URI. `@` ends the userinfo:

```
postgresql://user:p@ss@db.sprout.run:5432/x   →   host is "ss@db.sprout.run"
postgresql://user:p%40ss@db.sprout.run:5432/x →   host is "db.sprout.run"
```

A URI that parses to the wrong host is worse than one that fails to parse: the client connects
somewhere else, with the customer's credentials.

## Where the secret is, and is not

The password is sealed with `@lib/envelope` under `{ field: "database_role.password",
databaseRoleId }` — one exported context function shared by the writer and the reader, because
`@lib/agent` already learned what a one-word mismatch costs: it stores fine and never opens.

**The list endpoint never carries a URI.** It returns host, port, database, and username, and
nothing else. A URI in a list response is cached by clients, logged by proxies, and rendered on
pages nobody meant to expose. Revealing is a separate `POST .../connection`, gated on
`database:connect`, and audited — the audit row records _that_ the credential was read and by
whom, never the credential.

Rotation is gated on `database:admin` separately, because issuing a new password breaks every
client using the old one. It is also the only recovery from a leaked URI, and there is a test that
the old URI stops working.

## Verified against real Postgres

The tests provision real databases on the compose Postgres and **connect with the URI they get
back**. A mocked `pg` would confirm the SQL I wrote, not that Postgres accepts it or that the
credential can log in.

Driven through the HTTP API end to end: create → connect → reveal → rotate → destroy.

```
old URI after rotation: FATAL: password authentication failed
new URI after rotation: sprout_r_01a01ecd…
after destroy:          0 databases matching sprout_db_%
```

`drop database … with (force)` disconnects lingering sessions; without it one idle client keeps a
customer's deleted database alive indefinitely.

Suspension is `alter role … nologin`, not dropping anything — a suspension that lost data would
not be a suspension, and there is a test that the database survives it.

## Valkey, which is a credential and nothing else

There is no server to create. Every tenant shares one Valkey instance and is separated by a
hash-tagged key prefix that `services/valkey-proxy` applies to every command, so provisioning is
exactly: mint a username, mint a secret, store the hash the proxy will check against. The first
command the tenant sends creates their first key, and nothing existed before it.

### The stored secret is one-way, and `connectionUri` therefore throws

`database_role.password_ciphertext` is _reversible_ because a real Postgres role has to be created on
a real server with that exact password — something outside our process needs the plaintext back.
Nothing outside our process needs a Valkey secret: the proxy **is** the authenticator, so it only
ever answers "does this match".

So `connectionUri` cannot do what its name promises, and it throws `SecretNotRecoverableError`
rather than pretending. `rotateCredentials` is the answer, and it is a _different_ answer — the old
URI stops working — which is why the caller has to handle it rather than getting a silent rotation.

### Rotation revokes before it inserts

`service_credential_live_username_key` is a **partial** unique index, so Postgres evaluates it per
statement and cannot defer it to commit (`DEFERRABLE` needs a constraint, and a constraint cannot be
partial). Inserting the new credential first raises a duplicate key on the spot.

Inside one transaction that is not a window anyone can observe: a concurrent proxy lookup sees the
state before the commit or the state after it, never the moment in between.

The consequence is that the old secret dies the instant the rotation commits, with no grace period.
That is intended. Rotation exists to recover from a leaked credential, and a leaked credential that
keeps working for another ten minutes has not been recovered from.

### `suspend` revokes; `destroy` does not delete keys

Revoking the credential _is_ the suspension — the proxy refuses the next connection and the tenant's
data is untouched. `destroy` does the same and marks the service deleted; everything under
`{kv:<short-id>}:` becomes unreachable, because the prefix is derived from the service id and no
other tenant can name it. Actually reclaiming the memory needs an out-of-band reaper, because
scanning a shared instance is the one operation the proxy refuses on principle.

## `tenant-auth.ts` is half of a cross-language contract

The control plane issues connection credentials in TypeScript; the Rust data-plane proxies verify
them. The two share no code, so they share fixtures: `tenant-auth.test.ts` asserts the same
username grammar, short-id encoding and hash format that `lib/rust/tenant-auth`'s tests assert.

**A divergence there is a security bug, not a formatting one.** The username _is_ the routing
information, so if the encodings drift a proxy either rejects a valid tenant or routes one tenant's
connection into another's keyspace. Changing one side without the other should turn a test red on
both.
