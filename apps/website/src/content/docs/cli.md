---
slug: cli
title: Use the SproutOS CLI
summary: Install v0.2.1, sign in, choose an organization and region, create projects, configure services, and deploy.
audience: user
category: Getting started
order: 2
---

The `sprout` CLI is the command-line client for SproutOS. Version 0.2.1 is the current release. It
uses the same project and deployment contract as the dashboard and the GitHub Action.

## Install and verify the CLI

Download the archive for macOS, Linux, or Windows from the [SproutOS CLI v0.2.1
release](https://github.com/MySproutOS/SproutOS/releases/tag/cli-v0.2.1). The release includes
`SHA256SUMS` and `sprout-v0.2.1-manifest.json`; verify the archive against both files before running
it. Then check the installed version:

```shell
sprout --version
# sprout 0.2.1
```

## Sign in and choose an organization

Sign in through your browser, inspect the authenticated identity, and select the organization that
later commands should use:

```shell
sprout auth login
sprout auth status
sprout org list
sprout org use my-team
```

Browser login uses PKCE. The resulting scoped credential is stored in your operating system
credential store, not a plaintext configuration file. `org use` verifies that you can access the
organization before saving its slug as the default.

To use a different organization for one command, pass the global `--org my-other-team` option or
set `SPROUTOS_ORG`. For a trusted headless environment, set `SPROUTOS_TOKEN`; never put that value
in a repository or command-line argument. The environment token takes precedence over the saved
credential and `sprout auth logout` does not remove it.

## Create a project in an available region

Every new project requires `--region`. Ask the active control plane for the regions currently
accepting projects, then pass one of its exact codes:

```shell
sprout region list
sprout project create --name my-site --region us-east-1 --blank
sprout project get my-site
```

Do not copy a region from an old example without checking `region list`: availability is a
control-plane decision. A blank project uses the server's repository visibility default unless you
pass `--private` or `--public`.

You can instead connect a repository already known to SproutOS:

```shell
sprout project create --name my-site --region us-east-1 \
  --repository-id 01900000-0000-7000-8000-000000000000
```

Use `--github-repo-id` for a repository visible to the installed GitHub App. For a repository
GitHub cannot identify as a fork, add `--upstream owner/repository`. Root-directory and Dockerfile
overrides are optional; leaving them out preserves the source or signed App Store listing defaults.

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

Some listings declare setup inputs. Create a JSON array matching the fields shown by the listing,
then pass its file:

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

## Configure services and environment variables

List organization services, create a project-scoped service, and save a secret without putting its
value in shell history:

```shell
sprout service list
sprout service create --name app-database --kind postgres --project my-site
sprout env set my-site DATABASE_URL --stdin
sprout env list my-site
```

Service kinds are `postgres`, `valkey`, `elasticsearch`, and `object_storage`. Environment targets
are `production`, `preview`, `development`, and `all` (the default). Add `--public` only for values
that may be exposed to client-side application code.

## Build and deploy

Build your application first, then point `sprout deploy` at the finished artifact:

```shell
sprout deploy my-site --preset next --path .next/standalone
sprout deployment list my-site
sprout logs my-site
```

The CLI packages output deterministically, negotiates the upload, creates a release, and waits for
a terminal deployment result. Presets are `static`, `web`, `next`, `hono`, and `android`. Preview
deployments use `--environment preview`; production is the default. Use `deployment get` or
`deployment wait` with a deployment id when you need to inspect or wait for an existing release.

Production database migrations remain a customer-owned GitHub Actions step; see [Run database
migrations](/docs/database-migrations). Android releases have additional custody and verification
steps; see [Distribute Android apps](/docs/android-distribution).

## Manage upstream updates and project groups

App Store and upstream-backed projects can ask SproutOS to open reviewed update pull requests:

```shell
sprout project update analytics --auto-update \
  --auto-update-cadence one_month --auto-update-mode suggest
```

Use `--auto-update-mode auto_merge` only when reviewed pull requests should merge automatically
after all platform and repository checks pass. A logical group can be created with `--group`; add a
child using `--parent-project <group-id>` and select its customer-facing project with
`--primary-child <child-id>` on the group.

## Script safely with JSON output

Pass the global `--json` option to receive one versioned JSON document on standard output:

```shell
sprout --json project list
sprout --json api get /v1/regions
```

The `api` command accepts only a relative path beginning with `/`; it rejects absolute and
scheme-relative URLs before reading the bearer credential. `logs --follow --json` is the one
streaming exception: it emits one complete JSON envelope per line.

Commands that revoke or remove state require an interactive confirmation: `auth logout`, `project
delete`, `env unset`, `service delete`, and `template apply`. Use `--yes` to approve one explicitly.
JSON mode never prompts, so a destructive JSON command must include both global options:

```shell
sprout --json --yes project delete my-site
```

Run `sprout --help` or `sprout <command> --help` for the complete current flag set. The command
groups in v0.2.1 are `auth`, `org`, `region`, `project`, `env`, `service`, `deploy`, `deployment`,
`logs`, `android`, `api`, and `template`.
