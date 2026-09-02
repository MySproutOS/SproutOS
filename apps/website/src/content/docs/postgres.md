---
slug: postgres
title: Use Postgres
summary: Attach a tenant-scoped Postgres database, manage connection credentials, and create disposable branches.
audience: user
category: Backend services
order: 11
---

Create a Postgres service from **Databases → New database**. Attach it to a project to inject
`DATABASE_URL`, or leave it standalone and store the returned URI in the authorized consumers
yourself.

## Connect through SproutOS

Applications connect with the standard Postgres URI in `DATABASE_URL`. The public endpoint is a
SproutOS tenant proxy: it resolves the tenant database, checks suspension state, and drops its own
elevated role before forwarding the session. Customers do not receive the underlying provider
credential.

The connection URI is shown once. If it is lost or exposed, rotate it from the service menu and
replace the old value in every environment that uses it.

## Use branches for development and agents

A database branch is a temporary, isolated copy derived from the service's primary branch. Use one
for schema experiments, migration tests, previews, and hosted Agent work that must not touch
production data.

From the Postgres service, create a named branch, capture its one-time connection URI, and delete
the branch when the work is complete. Rotation replaces only that branch's credential. Hosted Agent
sandboxes can request their own 24-hour branch through a scoped action and clean it up when the
session ends.

A successful sandbox migration proves the migration against that branch. It does not migrate
production. Production remains an explicit customer-owned CI step; see [Run database migrations](/docs/database-migrations).

## Manage connections in serverless code

Reuse a small pool across warm invocations when your library supports it, but close or release work
before the handler returns. Do not leave a blocking connection or worker loop alive solely to wait
for future work. See [Background workers](/docs/background-workers).
