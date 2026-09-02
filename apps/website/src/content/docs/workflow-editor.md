---
slug: workflow-editor
title: Use the visual workflow editor
summary: Create a definition through the API, connect one trigger to actions and controls, save versions, and inspect runs.
audience: user
category: Workflows
order: 21
---

The visual editor edits a workflow definition attached to one project. Before opening it, create the
definition through the API as described in [Choose a workflow model](/docs/workflows), then select
it under **Workflows → Definitions**.

## Build the graph

Choose a node type, select **Add node**, and drag from one node handle to another to create an edge.
Select a node to rename it and edit the fields shown in the right panel. Delete removes the selected
node and its edges.

The editor offers these nodes:

- triggers: Manual, Schedule, Webhook, and Event;
- actions: HTTP request, Run code, Database, and Send email;
- controls: Branch and Delay.

Every graph needs exactly one trigger. Nothing may connect into that trigger, every other node must
be reachable from it, and the graph cannot contain a cycle. The server validates these rules on
save and names the problem node when it rejects a graph.

## Configure nodes

The right panel exposes the fields required by the selected node: a cron expression, webhook path,
event name, HTTP method and URL, code entrypoint, database query, email recipient and subject,
branch condition, or delay. Treat values as production configuration. Never paste an API key or
database password into a graph; keep secrets in the owning project's encrypted environment and
reference them from code.

Sandboxed action nodes run inside the owning project's isolated runtime. Deploy the project before
testing actions that need that runtime. A definition on a project that has never been provisioned
cannot safely run those nodes and reports a failed run instead of pretending they succeeded.

## Save meaningful versions

Select **Save** after the graph is connected and configured. A semantic change creates a new
immutable version. Moving nodes around the canvas does not create a new version, because positions
do not change execution behavior. Saving an unchanged graph returns the existing version.

## Start and inspect a run

The API can start the current saved version with an optional JSON trigger payload:

```shell
sprout api post \
  /v1/orgs/my-team/projects/01900000-0000-7000-8000-000000000000/workflows/01900000-0000-7000-8000-000000000001/runs \
  --data '{"trigger":{"requestedBy":"onboarding"}}'
```

The run and step endpoints expose status, error details, input and bounded output, duration, queue
residency, and measured cost. Job payload inspection and editing require separate permissions; an
edit records the before value, after value, actor, and a required reason.

Cron definitions schedule from the saved graph. Manual, webhook, and event triggers do not invent a
schedule. If a save is rejected, fix the named graph problem before trying to run it.
