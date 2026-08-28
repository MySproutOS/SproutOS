# 0057: Postgres teardown chose the control plane

## What was wrong

Project teardown always constructed `sproutPostgresDriver`, even when the database's recorded
provider was Neon. That driver's administrator connection falls back to `DATABASE_URL`, which is
the control-plane RDS connection in production.

Before the ECS environment repair this failed early because the worker lacked
`SERVICE_POSTGRES_PUBLIC_HOST`. Adding the correct public proxy hostname would have completed the
wrong driver's configuration and allowed a Neon project teardown to execute `DROP DATABASE` and
`DROP ROLE` against the control-plane cluster.

## Why a global flag is not the answer

`SERVICE_POSTGRES_PROVIDER` selects the provider for a newly created database. It cannot identify an
existing database during a provider migration. `database_instance.provider` is the durable fact
that says where that particular database lives.

## What stops it recurring

Teardown reads the live `database_instance.provider` for the backend service and dispatches to the
Neon or shared-cluster driver from that value. An absent or unsupported provider is an error; it
never falls back to `DATABASE_URL`. Unit tests assert that selecting Neon does not even construct
the shared-cluster driver, and the database-backed teardown suite exercises the full job.
