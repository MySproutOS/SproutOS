---
slug: github-action
title: Deploy with GitHub Actions
summary: Authenticate with GitHub OIDC and deploy one target from a repository.
---

## Minimal workflow

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v4
  - uses: MySproutOS/sproutos-deploy-action@v1
    with:
      preset: next
      directory: apps/website
      project: my-web-project
      api-url: https://api.sproutos.me
```

`id-token: write` lets GitHub identify the repository to SproutOS without a stored deployment secret. In a monorepo, use one workflow step per deployable target and set both `directory` and `project`.

## Presets and migrations

Use `next`, `hono`, `static`, or `android` as the preset. Server projects may declare a migration command; it completes before traffic moves to the new release. Static assets are uploaded to the project CDN.

The action waits for a terminal deployment state. A failed migration, missing artifact, or rejected repository identity fails the GitHub job instead of reporting a successful upload.

## Use the deployment skill locally

Download [the SproutOS skill](/skills/sproutos/SKILL.md) into `.claude/skills/sproutos/SKILL.md` for Claude Code. For an AGENTS.md-based CLI harness, append its instructions to your repository's `AGENTS.md` while preserving the instructions already there.

Running your own local agent uses your machine and model account, so SproutOS does not charge sandbox or model usage. Resources you deploy through SproutOS are still billed normally.
