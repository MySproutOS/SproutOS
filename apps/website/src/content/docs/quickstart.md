---
slug: quickstart
title: Start here
summary: Create an organization, connect GitHub, deploy a project, attach a backend service, and verify the result.
audience: user
category: Getting started
order: 1
---

This guide takes you from an empty account to a deployed application. You can start from an App
Store listing, an existing GitHub repository, or a blank repository. In every case, SproutOS keeps
the source in GitHub and deploys a named project from that source.

## 1. Create or choose an organization

Sign in, choose your organization from the switcher, and open **Projects**. Organizations are the
billing and access boundary: projects, services, model credentials, and usage belong to one
organization. See [Organizations and access](/docs/organizations-and-access) before inviting a
team or configuring automation credentials.

## 2. Choose how to start

- **App Store:** open **Store**, select a listing, review its required services and setup fields,
  then create your own repository-backed copy.
- **Existing repository:** install the SproutOS GitHub App for the repository and select it in
  **New project**.
- **Blank project:** let SproutOS create a repository, then use the hosted Agent or your local
  coding agent to build it.
- **Workflow repository:** choose **New workflow** for a BullMQ TypeScript, BullMQ Rust, or Celery
  Python worker. This is different from a visual workflow definition.

Every new project needs a region. Region availability comes from the live control plane, so use the
dashboard picker or run `sprout region list` instead of copying a region from an old example.

## 3. Model the repository correctly

A simple repository usually needs one project. A monorepo with a website, API, and worker should
use a **group** with one deployable child per target. Each child can have its own root directory,
branch, environment variables, services, and deployments. The group itself deploys nothing.

Choose the web application as the group's primary project so the group's main domain opens the
right child. See [Projects and groups](/docs/projects-and-groups).

## 4. Add the backend services the app needs

Open **Databases**, choose **New database**, select a service kind, and either attach it to the
project or leave it **Standalone**. SproutOS currently provides Postgres, Valkey, OpenSearch, and
object storage.

Attaching a service writes its connection settings into the project's encrypted environment.
Standalone means the service belongs to the organization but is not automatically wired to one
project; it does not mean the database runs outside SproutOS. See [Backend services](/docs/backend-services).

## 5. Configure the coding agent

For the hosted Agent, open **Settings → Agent**, add a Claude subscription token, Anthropic API
key, OpenAI API key, or OpenRouter API key, then open the project and choose **Agent**. Secrets are
sealed when saved and cannot be revealed later.

For a local coding agent, install the [SproutOS coding-agent skill](/docs/coding-agent-skill) and
authenticate the CLI. The skill teaches the agent how projects, services, migrations, and deploys
work; it is not a credential.

## 6. Deploy

The fastest manual path is the CLI:

```shell
sprout auth login
sprout org use my-team
sprout deploy my-site --preset next --runtime nodejs24.x --path .next/standalone
```

For repeatable production releases, use the GitHub Action with GitHub OIDC. Build first, deploy the
finished output, and keep production database migrations as a separate job that deployment jobs
depend on. See [Deploy an application](/docs/deployments) and [Deploy from GitHub](/docs/github-action).

## 7. Verify the release

Open **Deployments** and wait for a terminal success state. Then open the generated hostname and
check a real user path, not only a health endpoint. Use **Logs** and **Observability** to confirm the
request reached the expected project. If the application uses a service, exercise one real read and
write before adding a custom domain.

You now have the basic operating loop: change source, migrate if necessary, deploy, observe, and
roll back to a known release if verification fails.
