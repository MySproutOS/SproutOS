---
slug: projects-and-groups
title: Projects and groups
summary: Map one repository or monorepo to deployable projects, workflow workers, branches, and a primary domain.
audience: user
category: Getting started
order: 4
---

A **project** is one deployable target: a directory and branch that produces one website, API, or
workflow runtime. A **group** represents the repository that contains several targets. The group
organizes them but does not deploy code itself.

## Use one project for one deployable target

Create a standalone project when the repository has a single application. For a monorepo, create a
group and one child project per independently deployed target. A typical layout is:

```text
product (group; deploys nothing)
├── web       apps/web       production branch: main
├── api       apps/api       production branch: main
└── worker    apps/worker    production branch: main
```

Each child has its own root directory, deployment history, environment variables, logs, attached
services, and runtime. A release of `web` does not implicitly release `api` or `worker`.

## Choose the primary child

The group's primary child is the customer-facing entry point. Choose the website or other public
front door, not a private API or workflow project. An active custom domain on that child is used;
otherwise SproutOS uses its generated hostname.

Changing the primary child changes where the group points. It does not merge projects or move
their environment variables and services.

## Treat workflow projects as runtime children

A repository-backed workflow is still a project. It may be standalone or a child of the repository
group, but it has no website hostname or custom domain because queue and schedule triggers invoke
it. Use [Repository workflows](/docs/repository-workflows) for BullMQ and Celery workers.

Visual workflow definitions are a different resource attached to a deployed project. They appear
under **Workflows → Definitions** and use the visual editor. See [Workflows](/docs/workflows).

## Keep source and runtime responsibilities separate

SproutOS deploys the configured branch and directory. It does not infer that every package in a
monorepo is a deployable application. Make build and deployment paths explicit, and use one GitHub
Actions deploy step per child.

Deleting a group or child never deletes its GitHub repository. Remove source in GitHub separately
only when you intend to destroy it for every consumer.
