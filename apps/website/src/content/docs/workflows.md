---
slug: workflows
title: Choose a workflow model
summary: Decide between a repository-backed BullMQ or Celery worker and a versioned visual workflow definition.
audience: user
category: Workflows
order: 20
---

The **Workflows** page shows two different kinds of automation. They share the organization view,
but they are created, deployed, and operated differently.

## Repository workflows

A repository workflow is a complete code project for jobs that need arbitrary libraries, custom
business logic, or an existing queue framework. **New workflow** creates a repository-backed
project, asks you to choose BullMQ TypeScript, BullMQ Rust, or Celery Python and an interval or
webhook trigger, then opens the hosted Agent with a scaffold prompt.

The agent writes ordinary source code. Attach Valkey, test the worker, and deploy it like any other
project. It has no customer-facing hostname because queue or schedule events invoke it. See
[Repository workflows](/docs/repository-workflows).

## Visual workflow definitions

A definition is a versioned graph attached to an existing deployed project. It is best for a
visible sequence of triggers, actions, branches, and delays. Definitions appear in the
**Definitions** section and open in the visual editor.

The current dashboard does not have a **New definition** button. Create the initial definition
through the authenticated API, then open **Workflows → Definitions** to draw and save its graph.
The **New workflow** button creates a repository workflow; it does not open the visual editor.

```shell
sprout api post /v1/orgs/my-team/projects/01900000-0000-7000-8000-000000000000/workflows \
  --data '{"name":"Nightly report","runtime":"node"}'
```

Use the real project UUID from the project API or dashboard URL. The response contains the new
workflow UUID. Return to **Workflows**, open the definition, add exactly one trigger, connect every
action, and save.

## Choose deliberately

Use a repository workflow when code ownership, tests, framework features, or portability matter
most. Use a visual definition when operators should understand and adjust the sequence without
editing a codebase. A visual definition can still run HTTP, code, database, and email actions in
the owning project's isolated runtime.

Both kinds consume backend and compute resources. Both stop starting new work when the organization
is suspended for insufficient credit.
