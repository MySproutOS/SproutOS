---
slug: environment-variables
title: Configure environment variables
summary: Store secrets and public values in production, preview, development, or all targets without leaking them into source.
audience: developer
category: Deploying
order: 12
---

Open a project and choose **Environment** to manage runtime configuration. Values belong to the
project, not its repository group, and are injected only into matching deployment environments.

## Choose the target

- `production` is used by live production deployments.
- `preview` is used by preview deployments.
- `development` is for development-specific consumers.
- `all` applies the value to every target unless a more specific value overrides it.

Use different credentials and external service endpoints for preview and production when the
provider supports it. A preview that writes production data is not isolated merely because it has a
different hostname.

## Keep server secrets private

Environment values are private by default. Mark a value public only when it is safe to embed in
client-side code and send to every browser. Database URLs, signing material, provider API keys,
session secrets, and SproutOS tokens are never public values.

For the CLI, read secrets from standard input so they do not appear in shell history or a process
list:

```shell
printf '%s' "$APP_DATABASE_URL" | sprout env set my-site DATABASE_URL \
  --target production --stdin
sprout env list my-site
```

Do not put the value itself in documentation, screenshots, build logs, or `.env` files committed to
Git.

## Know what service attachment writes

Attaching a backend service writes its connection settings into the project environment:

- Postgres: `DATABASE_URL`;
- Valkey: `VALKEY_URL`, `REDIS_URL`, and `BULLMQ_PREFIX` where applicable;
- OpenSearch: `ELASTICSEARCH_URL`;
- object storage: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_NAME`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, and `S3_FORCE_PATH_STYLE`.

Standalone services are not injected automatically. Save their returned connection value in every
authorized consumer yourself.

## Rotate without an outage

Where a provider supports overlap, add a new application value, deploy consumers, verify them, and
then revoke the old credential. SproutOS service rotation invalidates the previous tenant
credential, so coordinate all consumers of a standalone service before selecting rotate.

Hosted Agent sandboxes do not inherit these production runtime secrets. Use scoped, disposable
resources for sandbox tests; see [Agent sandboxes](/docs/agent-sandboxes).
