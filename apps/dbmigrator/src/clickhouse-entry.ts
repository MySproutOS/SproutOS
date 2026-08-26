import { closeClickhouse, ensureSchema, observabilityConfigured } from "@lib/observability"

/*
  ClickHouse's schema, applied on deploy for the same reason Postgres's is.

  `ensureSchema()` has existed since the observability service was written and was called from
  exactly two places, both of them tests. So the table existed on every developer's machine and on
  no deployment — and the failure was not a missing table, it was a log viewer that answered:

      Unknown table expression identifier 'log_record'

  The Postgres migrator has a whole delivery path — packaged into the release, run over SSM against
  the idle colour, between fill and cutover. This has the same need and had none of it, which is
  `docs/findings/0015` again: something the application requires, that exists in the repository, and
  that no step carries to the machine.

  Note what was *not* missing. ClickHouse was reachable, authenticated and holding the runtime-log
  tables — the Kafka pipeline's `runtime_log`, `runtime_log_mv`, `runtime_log_queue`, all created by
  `ovh/clickhouse-init/01-runtime-logs.sql` on the OVH host. Two pipelines land in one database and
  only one of them had its DDL anywhere the deployment could reach it.

  Idempotent, because it runs on every deploy: every statement is `if not exists`.
*/
if (!observabilityConfigured()) {
  // Not an error. An empty `CLICKHOUSE_URL` is how a deployment says it has no log store, and the
  // observability routes already read it that way — the logs UI is simply absent. A migrate step
  // that failed here would make the log store a hard dependency of deploying at all.
  console.info("[clickhouse] CLICKHOUSE_URL is not set; no log schema to apply")
  process.exit(0)
}

try {
  await ensureSchema()
  console.info("[clickhouse] log schema is up to date")
} catch (cause) {
  console.error("[clickhouse] failed:", cause)
  process.exitCode = 1
} finally {
  await closeClickhouse()
}
