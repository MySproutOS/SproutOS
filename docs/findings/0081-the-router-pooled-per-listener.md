# 0081 — The router created one pool per listener

The combined router ran route resolution, Valkey, search, PostgreSQL, LLM, and sandbox-egress
authorization in one process, but each component constructed its own `deadpool_postgres::Pool`.
`storage-proxy`, a separate process on the same instance, constructed a seventh pool.

Every component checked its database dependency at boot. A check acquired a connection and returned
it to that component's private pool, where it remained idle. Six router instances therefore retained
approximately 42 control-plane sessions before customer traffic. Production RDS reported 45 total
connections, leaving almost no space below the small instance's connection ceiling for the web/API,
workers, a migration, or an operator.

## Why the previous check passed

Each pool was individually bounded, most to one connection in production. That proved no listener
could exhaust RDS alone and concealed the multiplier: six pools per router process, plus the separate
storage process, times the Auto Scaling group size. "Uses a pool" was treated as equivalent to
"shares the process pool."

## What stops it coming back

The router constructs one TLS `deadpool_postgres::Pool` and passes cheap pool clones to every
database-backed listener and route store. The pool allows four connections under real concurrent
lookup pressure but opens lazily, so sequential boot checks reuse one retained session.

`storage-proxy` remains a separate process and therefore retains its own pool, explicitly capped at
one. The website, API, and worker remain separate Node processes and each uses Kysely's
`PostgresDialect` over `pg.Pool`; their independent pool ceilings are a separate capacity budget.

`bin/router-shared-db-pool.test.sh` fails if router `main` constructs more than one pool, if a
combined listener calls a pool-constructing `connect` function, if production user data restores a
per-listener pool variable, or if the separate storage pool loses its bound.
