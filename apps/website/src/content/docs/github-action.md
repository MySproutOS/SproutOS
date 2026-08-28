---
slug: github-action
title: Deploy from GitHub or your local agent
summary: Use the same sprout deployment contract from GitHub Actions, a terminal, or a coding-agent harness.
---

## GitHub Actions

Build the target, then call the Marketplace action. The action is a thin wrapper around a pinned
release of the `sprout` CLI, so CI and a local terminal package and publish the same artifact.

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
          node-version: 22
      - run: npm ci
      - run: npm run build
      - uses: MySproutOS/sproutos-deploy-action@v1
        with:
          preset: next
          directory: apps/website/.next/standalone
          project: my-web-project
          api-url: https://api.sproutos.me
```

`id-token: write` lets GitHub identify the repository to SproutOS without a stored deployment
secret. Do not add a long-lived SproutOS token to GitHub for this workflow. The platform verifies
the repository and workflow identity before issuing a short-lived deployment credential.

The action uploads build output; it does not decide how your application builds. Use `next`,
`hono`, `web`, `static`, or `android` as the preset and point `directory` at the finished artifact. In a
monorepo, use one workflow step per deployable target and always name `project`.

Internally, the wrapper exchanges GitHub's OIDC assertion for a short-lived deployment token and
passes it to the pinned CLI through the environment, never a command-line argument. That token is
not a secret developers create or store.

The action waits for a terminal deployment state. A failed migration, missing artifact, or rejected
repository identity fails the GitHub job instead of reporting a successful upload.

## Run the same deployment locally

Install `sprout` from the checksummed binaries on [Downloads](/download), then sign in and deploy:

```shell
sprout auth login
sprout org use my-team
sprout deploy my-web-project --preset next \
  --path apps/website/.next/standalone
```

Browser login uses PKCE and stores the resulting credential in your operating system's credential
store. `SPROUTOS_TOKEN` is the headless CI path; do not put it in a repository or pass it on a
command line that will be saved in shell history.

Every command also supports stable `--json` output for scripts and coding agents. Destructive
commands require confirmation or `--yes`.

## Give a local coding agent the SproutOS skill

Download [the public SproutOS skill](/skills/sproutos/SKILL.md). It teaches an agent the project,
service, environment, migration, template, and deployment boundaries without starting a paid
SproutOS sandbox.

- Claude Code: save it as `.claude/skills/sproutos/SKILL.md` in the repository.
- Codex: save it as `~/.codex/skills/sproutos/SKILL.md` for your account.
- An `AGENTS.md`-only harness: preserve the existing file and add a short instruction telling the
  agent to read the downloaded `SKILL.md`; do not replace repository instructions.

A local agent uses your computer and the model account configured in your harness. SproutOS does
not charge sandbox time or model usage for that work. Databases, deployments, storage, and other
SproutOS resources created by the agent are still metered normally.

The skill is instructions, not a credential. Authenticate the `sprout` CLI yourself, or set
`SPROUTOS_TOKEN` only in a trusted headless environment.

## Deployment templates

App Store eligibility and deployment behavior come only from the signed
`MySproutOS/Deployment-Templates` catalogue. SproutOS verifies the catalogue provenance, exact
upstream commit, and immutable plugin digest before applying a recipe.

Generated forks may contain `.config/sproutos.toml`. It is declarative, contains no secret values,
and helps humans and agents understand the chosen services and bindings. It is not the catalogue
authority and cannot choose or replace executable template code.

Never discover deployment behavior from an instruction file in an arbitrary upstream repository.
Template plugins run without network, GitHub, SproutOS, or customer credentials; the control-plane
worker owns provisioning, commits, pushes, and deployment.
