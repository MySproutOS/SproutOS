import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Workspace } from "./workspace"

/**
 * Teaching the agent what SproutOS is, inside the workspace it is working in.
 *
 * `runAgentTurn` sets `settingSources: ["project"]`, so the SDK reads `.claude/` out of the
 * checkout. That is the injection point: a skill written there before the turn is available to the
 * model without a prompt change, and — unlike the system-prompt append — it is *progressive*. The
 * model reads it when the task turns out to be about deployment, and pays nothing for it when the
 * task is "fix this typo".
 *
 * `DEPLOYMENT_DOCTRINE` stays where it is. It is one paragraph saying what "create a deployment"
 * has to mean, which belongs in the system prompt because the model must not be able to miss it.
 * This is the reference material behind that paragraph, which would be waste to paste into every
 * turn.
 *
 * ## It must not be committed
 *
 * `commitAndPush` stages with `git add -A`, so anything written into the checkout ends up in the
 * customer's repository. A platform that silently commits its own scaffolding into a user's
 * repository has done something nobody asked for and is hard to undo across every fork.
 *
 * `.git/info/exclude` is the right instrument: it ignores the path for this clone only, and never
 * touches the customer's own `.gitignore` — which is a tracked file, and editing it would be the
 * very commit we are trying to avoid.
 */

const SKILL_PATH = ".claude/skills/sproutos/SKILL.md"

/** The line that keeps the injected skill out of the customer's history. */
const EXCLUDE_ENTRY = "/.claude/skills/sproutos/"

export type SkillInput = {
  workspace: Workspace
  /** The API the deployed application and the action talk to, e.g. `https://api.sproutos.me`. */
  apiUrl: string
  /** Where tenant applications are served, e.g. `sproutos.run`. */
  tenantDomain: string
  /** The project this session is for, so the workflow snippet is copy-pasteable rather than a form. */
  projectSlug?: string
}

/**
 * Write the skill into the checkout and hide it from git.
 *
 * Order matters: the exclude is written *first*. If writing the skill succeeded and the exclude
 * then failed, the next commit would carry the skill into the customer's repository — so the
 * failure mode of doing it the other way round is exactly the thing this function exists to
 * prevent.
 */
export async function installSproutosSkill(input: SkillInput): Promise<void> {
  const excludePath = join(input.workspace.path, ".git", "info", "exclude")

  await mkdir(dirname(excludePath), { recursive: true })
  const existing = await readFile(excludePath, "utf8").catch(() => "")
  if (!existing.includes(EXCLUDE_ENTRY)) {
    await writeFile(
      excludePath,
      `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${EXCLUDE_ENTRY}\n`,
    )
  }

  const skillPath = join(input.workspace.path, SKILL_PATH)
  await mkdir(dirname(skillPath), { recursive: true })
  await writeFile(skillPath, skillBody(input))
}

function skillBody(input: SkillInput): string {
  const project = input.projectSlug ?? "<your-project-slug>"

  return `---
name: sproutos
description: How this repository is built, deployed and connected on SproutOS — the deploy workflow, backend services, environment variables, migrations, and project groups. Use when the task involves deploying, adding a database or queue, wiring environment variables, running migrations, or making the repository work on SproutOS.
---

# Deploying this repository on SproutOS

SproutOS runs each deployable target in this repository as its own **project**. A repository with a
web app and a separate API is one repository and two projects, grouped under a parent that holds
them and deploys nothing itself.

## What a deploy actually is

A GitHub Actions workflow builds the target, uploads a zip, and calls the platform. The platform
publishes it as a Lambda version and moves an alias, so a release is atomic and a rollback is one
API call rather than a rebuild.

Add \`.github/workflows/sproutos.yml\`:

\`\`\`yaml
name: Deploy to SproutOS
on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write   # required — the deploy authenticates as this repository via OIDC

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: MySproutOS/sproutos-deploy-action@v1
        with:
          preset: next            # next | hono | static | android
          directory: apps/website # the target's root, relative to the repository
          project: ${project}
          api-url: ${input.apiUrl}
\`\`\`

**\`project\` is required when this repository holds more than one project**, and it is the most
common thing to get wrong. Without it the platform cannot tell which of them this workflow deploys
and refuses rather than guessing — a guess would deploy the right code to the wrong service, which
looks exactly like success.

**\`id-token: write\` is required.** Without it there is no OIDC token, and the deploy fails at the
first step with an authentication error that does not mention permissions.

One workflow per deployable target, each with its own \`directory\` and \`project\`.

## Backend services

Databases, caches, search and object storage are provisioned by the platform, not declared in this
repository. Each one is reached through a connection URI injected into the project's environment.

| Kind | Environment variable | Notes |
| --- | --- | --- |
| \`postgres\` | \`DATABASE_URL\` | Reached through the SproutOS proxy, never a direct cloud credential |
| \`valkey\` | \`VALKEY_URL\` | Redis-compatible; queue clients point here |
| \`elasticsearch\` | \`SEARCH_URL\` | Tenant-scoped; index names are rewritten for you |
| \`object_storage\` | \`S3_*\` | S3-compatible, SigV4, scoped to your own bucket |

**Never commit a connection URI.** They are issued once, and anything committed is a credential in
a git history. Read them from the environment.

## Environment variables

Set per project and per target (\`production\`, \`preview\`, or both). They are encrypted at rest and
delivered to the function as environment variables at publish time.

Because they are baked into a published version, **a rollback restores the environment that version
was published with** — including a secret rotated since. Worth knowing before rolling back.

## Migrations

Migrations run as a separate step *before* the new version starts serving. A failing migration fails
the deploy and leaves the previous release up.

Do not run migrations from application startup. Several Lambda instances start concurrently, and a
migration racing itself is how a schema ends up half-applied.

## Static assets

An SPA's built assets are uploaded separately and served from the CDN rather than through the
function. Use the \`static\` preset, or \`static-paths\` alongside a server preset.

Those assets go to a **platform-managed bucket**, keyed by project — this is not your
\`object_storage\` service. Files your application uploads at runtime belong in the latter.

## What does not run here

There is no long-running process. A background worker that sits in a loop consuming a queue has no
home: functions are request/response and are not running between requests.

Background work is expressed as **workflows** — the platform starts them from a queue and bills only
while they run. Porting a worker means moving each job handler into a workflow step, not finding a
way to keep a process alive.

## Getting it wrong safely

- The tenant hostname for a project is \`<slug>-<discriminator>.${input.tenantDomain}\`. The
  discriminator exists because project names are unique per organisation and hostnames are global.
- A custom domain is added through the dashboard and verified by a TXT record before it serves.
- Renaming a project changes its display name only. It does not rename the repository, and it does
  not change the hostname.
`
}
