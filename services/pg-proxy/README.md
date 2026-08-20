# `pg-proxy`

A tenant points `psql`, Prisma or SQLAlchemy at this and gets what looks like a Postgres server
holding exactly their database. Behind it is one shared cluster with a database and a role per
tenant, and this is what makes those two facts consistent.

## Why it terminates the connection

The obvious design — read the startup packet, then splice the sockets and let Postgres authenticate
— cannot work here. The tenant presents a secret stored as `sha256$…`; the backend expects a role
password held separately. Something has to sit between those two facts, which means being both a
server and a client.

## What one connection does

1. Answer `SSLRequest` — currently `N`.
2. Read the startup packet, take the username, and require it to be a **database** credential.
3. Ask for a password; verify against `service_credential` via the shared `CredentialStore`.
4. Connect to the cluster as the proxy's own administrative role, into _the tenant's_ database.
5. `SET ROLE` to the tenant's role.
6. Relay the backend's `ParameterStatus` and `BackendKeyData`, send `ReadyForQuery`, then copy bytes
   until one side hangs up.

**Step 5 is the one that matters.** Without it every tenant is connected as an administrator to a
cluster holding every other tenant's data.

**Step 6 is subtler than it looks.** `AuthenticationOk` alone leaves libpq waiting forever — it
expects the parameters and the ready signal too, and those were already consumed from the backend
while waiting for _its_ `ReadyForQuery`. The first version stopped at `AuthenticationOk` and every
connection hung.

## SCRAM

Postgres has defaulted to SCRAM-SHA-256 since 14, so it is the ordinary case, not an exotic one. The
first version of this handled trust, cleartext and MD5 and returned an error for SCRAM — which meant
it could not connect to the Postgres in `docker-compose`. The integration test found that in its
first run, which is the argument for having written it.

`scram.rs` is checked against **RFC 7677's own worked example**, not against itself. `client_first`
takes a username parameter purely so that vector can be used: Postgres ignores the field, but it is
part of the auth message the proof is computed over, and hard-coding it empty made the specification
untestable.

The server's signature is verified. Skipping it would complete an exchange with something that does
not know the password, which is the attack SCRAM exists to prevent.

`SCRAM-SHA-256-PLUS` is deliberately not selected even when offered: it binds to the TLS channel and
this hop has none.

## Cleartext to the client, and what that requires

The tenant is asked for a cleartext password because their secret is stored one-way — SCRAM would
need the password or a verifier derived from it, and we hold neither by design. That is the property
that makes a stolen credential table worthless.

**The consequence is that this proxy must terminate TLS in production.** It is a deployment
requirement, not optional hardening.

## Testing

`cargo test -p pg-proxy` — unit tests need nothing; integration tests need `docker compose up -d`
and migrations applied. They skip locally when Postgres is absent and **fail in CI**, because a
skipped isolation test reads exactly like a passing one.

Four guarantees, each verified by deleting it and watching a test go red:

| Guarantee                                                 | Caught by                                              |
| --------------------------------------------------------- | ------------------------------------------------------ |
| The session drops to the tenant's role                    | `a_tenant_lands_in_its_own_database_as_its_own_role`   |
| Routing follows the credential, not the client's `dbname` | `one_tenant_cannot_reach_another_tenants_database`     |
| A queue credential cannot open a database session         | `a_queue_credential_cannot_open_a_database_connection` |
| The server's SCRAM signature is checked                   | `a_wrong_server_signature_is_refused` (unit)           |

The third took three attempts to make honest, and the failures are worth recording because they are
the ordinary way a security test comes to assert nothing:

1. Rewriting `db_` to `kv_` in a username — matched no row, so the store refused it before the kind
   check ran.
2. Provisioning a real queue credential — reached the store, but the derived database did not exist,
   so the _backend_ refused it.
3. Also creating that database — now the kind check is the only thing left standing, and deleting it
   turns the test red.

The honest reading of (2) is that the check is defence in depth: a tenant's queue and database have
different resource ids, so the derived names already diverge. This is what holds if that stops being
true.

## Not built

- **Query cancellation.** `CancelRequest` arrives on a fresh connection carrying a key the _backend_
  issued, and this proxy keeps no map from those keys to sessions, so it closes silently — which is
  what Postgres does with a key it does not recognise. Making it work means holding backend keys per
  session and issuing our own.
- **Wake-on-connect.** The plan's reason for this service existing: a suspended Neon compute should
  resume when a tenant connects. There is no Neon control plane yet, so there is nothing to wake.
- **Connection pooling.** One backend connection per client connection. A shared cluster runs out of
  connection slots long before it runs out of anything else.
- **Per-tenant connection caps**, and the `metering-proto` events for connection-seconds.
- **TLS termination**, which the cleartext exchange above makes mandatory before this faces a
  network.
