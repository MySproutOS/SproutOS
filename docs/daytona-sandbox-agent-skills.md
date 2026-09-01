# Editing Daytona sandbox agent skills

The canonical SproutOS agent instructions are TypeScript source, not a checked-in generated
`SKILL.md`. Edit `lib/typescript/agent/src/skill.ts`.

## What to edit

- `skillBody()` contains instructions shared by the rendered variants.
- `sandboxSection()` contains instructions that are true only inside a SproutOS sandbox, including
  the Daytona database-branch workflow.
- `renderSproutosSkill()` assembles the production sandbox version. Usually edit the content
  functions above rather than this wrapper.
- `renderPublicSproutosSkill()` assembles the public, installable version returned by the API. Do
  not put Daytona-only claims in this variant.

The production sandbox job calls `renderSproutosSkill()` in
`lib/typescript/jobs/src/sandbox.ts` and passes the resulting text to `bootstrapSandbox()`.

## How Daytona receives it

The Daytona sandbox does not download a skill from the public API. During bootstrap, SproutOS
writes the rendered instructions through the Daytona filesystem API to:

```text
<workspace>/.git/sproutos/codex/AGENTS.md
```

The write happens in `lib/typescript/agent/src/sandbox-agent.ts`. The file is under `.git` so it
cannot be staged or committed into the customer's repository and does not replace the customer's
own `AGENTS.md`.

For the Codex harness, `lib/typescript/agent/src/sandbox-env.ts` sets:

```text
CODEX_HOME=<workspace>/.git/sproutos/codex
```

Codex therefore loads the generated file as its account-level `AGENTS.md`, then layers the
repository's own instructions over it. Claude Code receives the same generated file explicitly as
an appended system prompt.

Use a newly bootstrapped sandbox when verifying an instruction change; do not assume a sandbox
that already has a generated instruction file will be rewritten by editing the TypeScript source.

## What `/v1/sproutos-skill` is

`apps/internal-api/src/v1/sproutos-skill.ts` serves the output of
`renderPublicSproutosSkill()` as a downloadable `SKILL.md`. It is for developers installing the
public SproutOS skill in their own harness. It is not how the production Daytona agent obtains its
instructions.

The local installer in `lib/typescript/agent/src/skill.ts` can write that installable form to:

```text
.claude/skills/sproutos/SKILL.md
```

That generated path is excluded from the clone's Git history. Do not edit a generated copy as the
source of truth.

## Capabilities are separate from instructions

Editing the skill tells the model how and when to use a capability; it does not grant one. For
example, the database-branch workflow also requires the jobs/API implementation to inject the
scoped action URL and short-lived bearer into the turn environment:

```text
SPROUTOS_AGENT_DATABASE_BRANCHES_URL
SPROUTOS_AGENT_ACTION_TOKEN
```

When adding a new action, implement and authorize the action independently, inject only its scoped
runtime values, and then document its use in the sandbox section.

## Verification

Run the renderer and sandbox bootstrap tests after changing the instructions:

```bash
pnpm --filter=@lib/agent run check-types
pnpm exec vitest --run --config .config/vitest.config.mts --project @lib/agent \
  src/skill.test.ts src/sandbox-agent.test.ts
```

For a behavior-sensitive change, also launch a disposable Daytona sandbox and verify that the real
agent notices and follows the injected instruction. Inspect the generated file only as evidence;
continue making edits in `lib/typescript/agent/src/skill.ts`.
