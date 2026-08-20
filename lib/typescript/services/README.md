# @lib/services

Backend services a customer can provision: one driver interface, one connection URI.

## TASK 37, and why it is one abstraction

> The user can also spin up connection uris for each individual backend service that they want.

`backend_service.project_id` is nullable, so the same table covers a database attached to a project
and one standing entirely on its own. Postgres, Valkey, and Elasticsearch differ in almost every
detail and in **none of the five things a control plane does to them**: provision, hand back a URI,
rotate, suspend, destroy. So there is one `ServiceDriver` interface and adding a kind is a driver,
not a second set of endpoints with their own shapes.

Today only `postgres` is implemented. An unimplemented kind returns _"valkey services are not
available yet"_ — a different answer from "something broke", and one the customer can act on.

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
