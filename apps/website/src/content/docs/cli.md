---
slug: cli
title: Use the SproutOS CLI
summary: Sign in, choose an organization and region, create projects, configure services, and deploy from one command-line client.
audience: user
category: Getting started
order: 2
---

The `sprout` CLI is the command-line client for SproutOS. It uses the same project and deployment
contract as the dashboard and the GitHub Action.

## Sign in and choose an organization

Install a checksummed binary from the SproutOS GitHub release, then sign in:

```shell
sprout auth login
sprout org list
sprout org use my-team
```

Browser login uses PKCE. The resulting credential is stored in your operating system credential
store, not a plaintext configuration file. For a trusted headless environment, use
`SPROUTOS_TOKEN`; never put that value in a repository or command-line argument.

Add `--json` to get one stable JSON document for scripts and coding agents. Destructive commands
require an interactive confirmation, or `--yes`; JSON mode never prompts.

## Create a project in an available region

A region is required when a project is created. Ask the active control plane for the current list,
then pass one of its exact codes:

```shell
sprout region list
sprout project create --name my-site --region us-east-1 --blank
```

Do not copy a region from an old example without checking `region list`: availability is a
control-plane decision. A blank project is private or public according to the server default unless
you pass `--private` or `--public`.

You can also attach an existing repository:

```shell
sprout project create --name my-site --region us-east-1 \
  --repository-id 01900000-0000-7000-8000-000000000000
```

For a repository GitHub cannot identify as a fork, add `--upstream owner/repository`. Root
directory and Dockerfile overrides are optional. Leaving them out preserves the source or signed
App Store listing defaults.

## Install from the App Store

Copy a listing id from the SproutOS App Store and create its project:

```shell
sprout project create --name analytics --region us-east-1 \
  --store 01900000-0000-7000-8000-000000000000 \
  --owner my-github-account --repository-name analytics
```

The platform resolves an exact signed catalogue commit and immutable plugin digest. It creates the
destination repository and services; it does not execute instructions discovered in the upstream
repository.

Some listings declare setup inputs. Download or create a JSON array matching the fields shown by
the listing, then pass its file:

```json
[
  { "key": "databasePassword", "value": "replace-me", "secret": true },
  { "key": "port", "value": 3000, "secret": false }
]
```

```shell
sprout project create --name analytics --region us-east-1 \
  --store 01900000-0000-7000-8000-000000000000 \
  --template-input-file ./template-inputs.json
```

Use `--template-input-file -` to read the array from stdin. This keeps secret values out of shell
history and the process list. Inputs cannot override the signed template's declared structure.

## Configure and deploy

Use environment and service commands after the project exists:

```shell
sprout env set my-site DATABASE_URL --stdin
sprout service list --project my-site
sprout deploy my-site --preset next --path .next/standalone
sprout deployment list --project my-site
sprout logs my-site
```

The CLI packages output deterministically, negotiates the upload, creates a release, and waits for
a terminal deployment result. The `static`, `web`, `next`, `hono`, and `android` presets share this
release path. Production database migrations remain a customer-owned GitHub Actions step; see
[Run database migrations](/docs/database-migrations).

## Manage updates and groups

App Store and upstream-backed projects can ask SproutOS to open reviewed update pull requests:

```shell
sprout project update analytics --auto-update \
  --auto-update-cadence one_month --auto-update-mode suggest
```

Use `--auto-update-mode auto_merge` only when reviewed pull requests should merge automatically
after all platform and repository checks pass. A logical group can be created with `--group`; add a
child using `--parent-project <group-id>` and select its customer-facing project with
`--primary-child <child-id>` on the group.

Run `sprout --help` or `sprout <command> --help` for the complete current flag set. The major command
groups are `auth`, `org`, `region`, `project`, `env`, `service`, `deploy`, `deployment`, `logs`,
`android`, `api`, and `template`.
