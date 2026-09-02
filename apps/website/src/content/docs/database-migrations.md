---
slug: database-migrations
title: Run database migrations
summary: Run production migrations from GitHub Actions before deploying every project that depends on them.
audience: developer
category: Deploying
order: 14
---

## The workflow owns production migrations

Your GitHub Actions workflow decides when production database migrations run. SproutOS does not
scan a repository, discover a migration command, or start a migration because application code was
deployed.

The recommended setup is a dedicated SproutOS **migrator project**. Its GitHub Actions job uploads
the built migrator, waits for SproutOS to finish running it, and only then allows the application
projects that use that database to deploy. Give one project responsibility for each database. Do
not attach the same migration to several application projects and let them race.

## Recommended: deploy a migrator project first

Build the migrator separately from the request-serving application and pass it to the deploy action
with `migration-directory`. The action waits for a terminal result, so GitHub's `needs` dependency
is the gate between the schema and the applications:

```yaml
name: Migrate and deploy to SproutOS
on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build:migrator
      - uses: MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180
        with:
          preset: hono
          directory: apps/migrator/dist
          project: my-app-migrator
          migration-directory: apps/migrator/dist
          migration-handler: migrate.handler
          api-url: https://api.sproutos.me

  deploy-web:
    needs: migrate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - uses: MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180
        with:
          preset: next
          directory: apps/website/.next/standalone
          project: my-app-web
          api-url: https://api.sproutos.me
```

Replace the commands, preset, directories, and handler with the repository's real build. The
migrator project is a deployable project, but it should not be the group's customer-facing primary
project.

Add `needs: migrate` to every job that deploys code against the migrated database. When several
applications share one database, they may deploy in parallel after that one migration succeeds.
When applications use different databases, give each database its own migrator job and depend only
on the relevant one.

SproutOS runs the uploaded migrator with that project's production environment, including its
`DATABASE_URL`, before publishing the migrator project's new version. A failed migration fails the
GitHub job and leaves dependent jobs unstarted. SproutOS does not retry a migration automatically:
after a failure, inspect whether it partially applied before starting another run.

## Alternative: run the command directly in CI

You may run the repository's migration command directly on the GitHub runner instead. In that
model, GitHub needs a production database credential stored as an Actions secret; the OIDC token
used by the SproutOS deploy action is not a database credential.

```yaml
jobs:
  migrate:
    runs-on: ubuntu-latest
    env:
      DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run migrate

  deploy-web:
    needs: migrate
    # Build and deploy the application here.
```

Use this pattern when the migration cannot run in the SproutOS migrator runtime or your existing CI
already owns database access. Never commit the connection URI or print it in workflow output.

## Make schema changes safe for several projects

The old application versions keep serving until their deployment jobs finish. Write migrations so
both old and new code can use the intermediate schema: add before removing, deploy readers before
dropping old columns, and move destructive cleanup into a later migration.

Do not run migrations during application startup. Several function instances may start at once,
which turns one schema change into concurrent migration attempts.

If a project has no database or no migrations, say so in the workflow or repository instructions
rather than leaving ownership ambiguous.

## Sandboxes do not migrate production

A SproutOS coding-agent sandbox starts without `DATABASE_URL`. The agent can request a named,
disposable 24-hour branch of the project's database through its scoped sandbox action. Run
migrations against that isolated branch to verify the schema, seed data, and application together.
A successful sandbox migration does not replace the GitHub Actions migration job and does not prove
that production was migrated.
