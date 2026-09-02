---
slug: observability
title: Observe and troubleshoot applications
summary: Use deployment states, runtime logs, request identifiers, workflow runs, and usage records to verify real behavior.
audience: developer
category: Operations
order: 30
---

Observability starts with identifying which environment and release you are testing. A local
process, Agent preview, preview deployment, and production deployment are four different runtime
states. Record the project, deployment, hostname, and request time before investigating.

## Read deployment state first

Open **Deployments** or run `sprout deployment get <deployment-id>`. A build failure means SproutOS
could not prepare the artifact or image. A runtime failure means the build completed but the
application could not start or serve. Inspect that reason before searching application logs.

## Search runtime logs

Open the project's **Logs** page or use:

```shell
sprout logs my-site --since 30m --limit 200
sprout logs my-site --follow
```

Filter by level or text when you know the failure signature. Use structured fields for operation,
resource id, status, and retry count so a person can distinguish two similar messages. Avoid
logging credentials, authorization headers, connection URLs, session tokens, or full sensitive
payloads.

Request identifiers let you correlate a browser failure with the correct runtime line. Capture the
identifier and timestamp at the boundary, then search the same project rather than scanning every
service.

## Inspect workflow runs

Visual workflow run detail records overall status, a human-readable error, step inputs and bounded
outputs, timestamps, and measured cost. A skipped sandboxed action makes the run fail with a reason;
it is never reported as success. Queue payload inspection and editing require additional permissions
and every edit requires an audit reason.

For repository workers, log one stable job id from receipt through completion and record retries
without including secrets or entire customer documents.

## Compare with usage

Billing usage is evidence that a measured resource was consumed, not proof that the user-visible
operation succeeded. Compare compute, queue residency, database, storage, and Agent dimensions with
runtime logs and the final state change. A green deployment plus no matching request usually means
you tested a different hostname or environment.
