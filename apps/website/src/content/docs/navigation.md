---
slug: navigation
title: Navigate SproutOS
summary: Where repositories, deployable projects, workflows, services, and usage live.
audience: user
category: Getting started
order: 2
---

Use the organization switcher first: every project, backend service, workflow, model credential,
and billing record belongs to the selected organization.

## Projects

**Projects** lists standalone deployable projects and repository groups. Open a project for its
overview, deployments, environment, logs, Agent, preview, and settings. Open a group to see the
children that deploy from different roots or branches of the same repository.

See [Projects and groups](/docs/projects-and-groups) before mapping a monorepo.

## Workflows

**Workflows** has two sections. **Workflow repositories** are code projects created by **New
workflow**. **Definitions** are versioned graphs attached to deployed projects and opened in the
visual editor. The create button does not create a visual definition. See [Workflows](/docs/workflows).

## Databases

**Databases** manages Postgres, Valkey, OpenSearch, and object storage. Each service can be attached
to one project or left standalone at the organization level. This page also creates Postgres
branches and rotates service credentials. See [Backend services](/docs/backend-services).

## Store

**Store** lists reviewed apps that SproutOS can turn into your own repository-backed project. The
installed project remains connected to its upstream provenance, and maintenance can propose updates
through pull requests. See [Install apps and receive upstream updates](/docs/store-and-updates).

## Settings

Organization settings contain membership, GitHub integration, hosted Agent credentials, and other
organization-wide controls. Project settings contain the production branch, root directory,
domains, and destructive project actions. Model credentials are organization-scoped; environment
variables and backend service attachments are project-scoped.

## Billing and deletion

**Billing** groups measured usage by service and keeps an append-only credit ledger. Deleting a
project tears down its SproutOS resources but retains the billing and audit history needed to
explain past activity. SproutOS never deletes its GitHub repository.
