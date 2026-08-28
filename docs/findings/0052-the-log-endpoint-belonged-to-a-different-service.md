# The log endpoint belonged to a different service

## What was wrong

Production first stored `SPROUTOS_LOG_ENDPOINT=https://api.sproutos.me/v1/internal/logs` in
Parameter Store. Correcting only the path to `https://api.sproutos.me/_sproutos/logs` still returned 404. The host was the deeper error: the ALB sends `api.sproutos.me` to the internal API, while the
router is the service that ingests extension batches. Its only ingest route is
`POST /_sproutos/logs`, so the fail-open extension dropped every batch sent to either API URL.

This was not a transient broker or ClickHouse failure. The request never reached the router or its
Kafka producer.

## Why the checks missed it

The application-configuration check proved that `SPROUTOS_LOG_ENDPOINT` appeared in the Parameter
Store allowlist, the website's boot-time secret list, and the application code. It checked whether a
value could reach a process, not whether the value named a route that process actually served.

Treating the endpoint as a secret made the drift durable. Its host and path were maintained outside
the deployment template and outside the Rust handler that defined the real contract. A complete,
non-empty configuration therefore passed while pointing at a different service.

## What stops it coming back

`publishRelease` already derives a canonical hostname for each deployment. That generated tenant
hostname is guaranteed to reach the router, so it now passes
`https://<deployment-hostname>/_sproutos/logs` into `publishFunction`. Global
`SPROUTOS_LOG_ENDPOINT` configuration is removed: an old Parameter Store value cannot choose the
host or path of a newly published function.

`bin/check-app-config.mjs` and a unit test read `services/router/src/logs.rs` and extract
`INGEST_PATH`. They fail unless the TypeScript publisher uses that exact path, and the config check
also fails if the endpoint is put back into `.template.env`, Parameter Store, or the boot-time
secret list. A unit test supplies a deliberately wrong global API endpoint and proves it cannot
override the deployment-derived tenant URL.

The routing distinction was also checked against production without a token: the API host returned
404, while both a generated customer application host and the existing tenant wildcard route
reached the router and returned its expected `401 no token`. The generated deployment host is the
route the publisher now constructs.

## Launch-plan context

This is part of the production acceptance and reporting trail in both legacy Claude plans,
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`, and both private handoffs,
`private_notes/groups.md` and `private_notes/sandbox-handoff.md`. Those documents distinguish code
that exists from a live path that has actually carried traffic; this 404 is why that distinction
remains a launch requirement.
