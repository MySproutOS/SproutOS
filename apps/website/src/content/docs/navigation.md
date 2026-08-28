---
slug: navigation
title: Navigate SproutOS
summary: Where repositories, deployable projects, workflows, services, and usage live.
---

## Organizations and groups

An organization owns billing and access. A **group** is one GitHub repository. Its child projects are the deployable targets inside that repository, such as a web app and an API.

Open **Projects** to see groups and their children. Group settings hold repository-wide choices such as upstream updates and the primary deployed project.

## Projects and domains

A project is one deployable directory and branch. Its overview shows the live SproutOS hostname; **Domains** adds a custom hostname. **Environment** stores encrypted variables and **Observability** shows requests, logs, and failures.

## Databases and other services

Use **Databases** for Postgres and the project service screens for Valkey, search, and object storage. A connection credential is shown once when it is created or rotated. Store it in a project environment variable; it cannot be revealed later.

## Workflows and agents

Workflows attached to a repository appear inside its group. The global **Workflows** page is for standalone automation repositories. Agent conversations and previews stay with the project they modify.

## Billing and deletion

Billing groups measured usage by service and keeps an append-only credit ledger. Deleting a project tears down its resources but retains billing and audit history. GitHub repositories are retained unless you explicitly select them for deletion.
