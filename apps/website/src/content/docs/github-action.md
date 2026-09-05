---
slug: github-action
title: Deploy from GitHub or your local agent
summary: Use the same sprout deployment contract from GitHub Actions, a terminal, or a coding-agent harness.
audience: developer
category: Deploying
order: 11
---

## GitHub Actions

Build the target, then call the Marketplace action. The reviewed action at commit
`0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180` is a thin wrapper around the published `sprout` CLI
v0.1.0. The current local CLI is v0.2.1; it adds the complete region-aware project, signed-template,
Android release, and resumable log-stream commands while preserving the action's packaging and
deployment protocol.

```yaml
name: Deploy to SproutOS
on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npm run build
      - uses: MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180
        with:
          preset: next
          runtime: nodejs24.x
          handler: run.sh
          directory: apps/website/.next/standalone
          project: my-web-project
          api-url: https://api.sproutos.me
```

`id-token: write` lets GitHub identify the repository to SproutOS without a stored deployment
secret. Do not add a long-lived SproutOS token to GitHub for this workflow. The platform verifies
the repository and workflow identity before issuing a short-lived deployment credential.

The action uploads build output; it does not decide how your application builds. Use `next`,
`hono`, `web`, `function`, `static`, or `android` as the preset and point `directory` at the finished artifact. In a
monorepo, use one workflow step per deployable target and always name `project`.

Internally, the wrapper exchanges GitHub's OIDC assertion for a short-lived deployment token and
passes it to the pinned CLI through the environment, never a command-line argument. That token is
not a secret developers create or store.

The action waits for a terminal deployment state. A missing artifact or rejected repository
identity fails the GitHub job instead of reporting a successful upload.

Production migrations remain part of the customer's GitHub Actions workflow. Use a dedicated
migrator project and make application deploy jobs wait for it, or run the migration command directly
in CI. See [Run database migrations](/docs/database-migrations) for both patterns and their failure
boundaries.

## Run the same deployment locally

Install `sprout` from the checksummed binaries in the
[SproutOS CLI v0.2.1 release](https://github.com/MySproutOS/SproutOS/releases/tag/cli-v0.2.1), then
sign in and deploy:

```shell
sprout auth login
sprout org use my-team
sprout deploy my-web-project --preset next \
  --runtime nodejs24.x --handler run.sh \
  --path apps/website/.next/standalone
```

Browser login uses PKCE and stores the resulting credential in your operating system's credential
store. `SPROUTOS_TOKEN` is the headless CI path; do not put it in a repository or pass it on a
command line that will be saved in shell history.

Every command also supports stable `--json` output for scripts and coding agents. Destructive
commands require confirmation or `--yes`.

The release contains macOS arm64 and x86-64, Linux arm64 and x86-64, and Windows x86-64 binaries,
plus `SHA256SUMS` and `sprout-v0.2.1-manifest.json`. Verify the selected archive against both files.
The action also verifies GitHub's artifact attestation and the release's exact source revision
before it executes the binary.

## Give a coding agent the same contract

Install [the SproutOS coding-agent skill](/docs/coding-agent-skill) in `.agents/skills` for Codex or
`.claude/skills` for Claude Code. It teaches the agent the project, service, environment, migration,
template, and deployment boundaries without creating a paid hosted sandbox. A local agent still
uses the same `sprout deploy my-web-project` command and resources it creates on SproutOS remain
metered normally.

The build toolchain and deployed runtime are separate settings. Set both explicitly in repeatable
workflows. Runtime selection does not rebuild native dependencies; the uploaded package must
already target Linux arm64. See [Runtimes and framework presets](/docs/runtimes).

## Deployment templates

App Store eligibility and deployment behavior come only from the signed
`MySproutOS/Deployment-Templates` catalogue. SproutOS verifies the catalogue provenance, exact
upstream commit, and immutable plugin digest before applying a recipe.

The reviewed template source at commit `c86dfdb7f055cb6cdf499b23f84ab91d640ca7a1` generates the
canonical OIDC workflows for Umami and Memos. Those workflows pin the deploy action to the full
commit above; they do not follow a mutable action tag.

Generated forks may contain `.config/sproutos.toml`. It is declarative, contains no secret values,
and helps humans and agents understand the chosen services and bindings. It is not the catalogue
authority and cannot choose or replace executable template code.

Never discover deployment behavior from an instruction file in an arbitrary upstream repository.
Template plugins run without network, GitHub, SproutOS, or customer credentials; the control-plane
worker owns provisioning, commits, pushes, and deployment.
