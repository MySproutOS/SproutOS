---
slug: coding-agent-skill
title: Install the coding-agent skill
summary: Give Codex, Claude Code, or another repository agent the SproutOS CLI and platform operating contract.
audience: developer
category: Getting started
order: 2
---

The public SproutOS skill teaches a coding agent how projects, groups, backend services,
environment variables, migrations, templates, and deployments work. It helps the agent use the
`sprout` CLI without copying the entire platform contract into every prompt.

The skill is instructions, not a credential. Install it in the repository, then authenticate the
CLI yourself.

## Download the canonical file

```shell
mkdir -p .agents/skills/sproutos
curl --fail --location \
  https://sproutos.me/skills/sproutos/SKILL.md \
  --output .agents/skills/sproutos/SKILL.md
```

Recommended locations are:

- Codex, repository-scoped: `.agents/skills/sproutos/SKILL.md`;
- Codex, user-scoped: `~/.agents/skills/sproutos/SKILL.md`;
- Claude Code, repository-scoped: `.claude/skills/sproutos/SKILL.md`;
- Claude Code, user-scoped: `~/.claude/skills/sproutos/SKILL.md`.

Repository scope is the best default for a team because the instructions travel with the code and
can be reviewed. User scope is useful when you work across many unrelated repositories. If your
agent only follows `AGENTS.md`, keep the existing file and add an instruction to read this skill;
do not replace repository-specific instructions.

## Install and authenticate the CLI

Install the checksummed CLI release, then sign in outside the agent prompt:

```shell
sprout auth login
sprout auth status
sprout org use my-team
```

Browser login stores the scoped credential in the operating system credential store. In a trusted
headless environment, supply `SPROUTOS_TOKEN` as a secret environment value. Never paste a token
into `SKILL.md`, `AGENTS.md`, a prompt, or a command-line argument that shell history records.

## Verify the agent can use it

Ask the agent to explain the current repository's project layout and propose the exact build and
deploy commands without executing them. A correct answer should identify each deployable target,
choose a preset and output directory, keep migrations before application deploys, and distinguish
attached services from standalone ones.

Then allow a read-only CLI check:

```shell
sprout --json project list
sprout --json service list
```

Review any state-changing command before it runs. Destructive CLI commands require confirmation or
`--yes`; JSON mode never prompts.

## Understand local and hosted agents

A local agent uses your computer and your agent provider account. SproutOS does not charge hosted
sandbox duration or hosted model usage for that local work, although SproutOS services and
deployments it creates are billed normally.

The hosted Agent receives the same platform guidance automatically plus sandbox-only instructions,
short-lived scoped actions, preview routing, and disposable database-branch access. Do not copy
those ephemeral tokens or sandbox commands into the public skill.
