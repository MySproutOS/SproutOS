import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Workspace } from "./workspace"
import { DELEGATION_POLICY } from "./delegation"

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
  /** The API the deployed application and the CLI talk to, e.g. `https://api.sproutos.me`. */
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

/**
 * The skill's text, without writing it anywhere.
 *
 * The sandbox needs the body rather than the side effect: there is no local filesystem to write
 * into, and the two harnesses want it in different places — `.claude/skills` for Claude Code,
 * `AGENTS.md` for Codex, which knows nothing about skills. Exported so `bootstrapSandbox` renders
 * once and places it twice, rather than keeping a second copy of the text that drifts.
 */
export function renderSproutosSkill(
  input: Omit<SkillInput, "workspace"> & { workspacePath: string },
): string {
  return skillBody({
    ...input,
    sandbox: true,
    workspace: { path: input.workspacePath } as SkillInput["workspace"],
  })
}

/** The installable skill served to developers running their own local agent harness. */
export function renderPublicSproutosSkill(input: { apiUrl: string; tenantDomain: string }): string {
  return skillBody({
    ...input,
    workspace: { path: "." } as SkillInput["workspace"],
  })
}

/**
 * What is true of the machine the agent is on, and only there.
 *
 * First, before anything about deploying, because it is what changes what the agent should *do*:
 * there is a database it can migrate against, a port a person is watching, and a commit that
 * happens whether or not it asks for one. An agent that does not know the checkout is pushed at the
 * end of the turn writes differently — it leaves scratch files about, or asks permission it already
 * has.
 *
 * Kept out of the control-plane rendering because none of it is true there: that checkout has no
 * database, no port anybody can reach, and a `Bash` tool that is refused outright.
 */
function sandboxSection(workspacePath: string): string {
  return `
## Where you are right now

You are in a SproutOS sandbox: a container of your own, with this repository checked out at
\`${workspacePath}\`. A shell here is a real shell — install things, run the test suite, start a dev
server. Nothing you run reaches the platform's own infrastructure.

**There is a database.** \`DATABASE_URL\` points at a *branch* of this project's Postgres, made for
this sandbox. It is a copy: migrate it, seed it, drop a table. Production is not on the other end of
that credential, and cannot be reached from here.

**A person may be watching a port.** A dev server on 3000, 5173 or 8080 is shown to the customer as
a live preview. Bind to \`0.0.0.0\`, not \`127.0.0.1\` — a server listening on loopback inside a
container is invisible from outside it, which looks to the customer like a preview that never loads.
The server must survive after this turn finishes. Do not use Claude's managed
\`run_in_background\`, which is stopped when Claude exits. Launch it as a detached OS process, for
example \`setsid -f <server-command> </dev/null >/tmp/dev-server.log 2>&1\`, then verify both the
local response and that the process has parent PID 1 before finishing.

**HTTP and HTTPS internet access is already routed through SproutOS.** Web requests, package
managers, and HTTPS Git remotes work normally; the proxy settings are already in the environment.
Every public HTTP(S) domain is allowed; there is no domain allow-list to maintain. Whenever you need
the internet, use this proxy path. Do not unset, override, or bypass the proxy variables. If a tool
does not honor them automatically, configure that tool to use the existing proxy instead of trying
a direct connection. The SproutOS proxy rejects private, loopback, link-local, and metadata addresses.
Use HTTPS rather than SSH for Git. Arbitrary raw TCP protocols are not available from this sandbox.

**Your work is committed for you.** At the end of the turn everything in the checkout is staged,
committed and pushed to a branch — never to the production branch. So: do not commit secrets, do not
leave scratch files in the tree, and do not ask whether you may edit files. You may.

**The sandbox stops after fifteen minutes of inactivity.** A detached preview may live between
turns, but it stops with the sandbox. Anything that must outlive the sandbox belongs in the
repository, not only in a process or under \`/tmp\`.

${DELEGATION_POLICY}
`
}

function skillBody(input: SkillInput & { sandbox?: boolean }): string {
  const project = input.projectSlug ?? "<your-project-slug>"

  return `---
name: sproutos
description: How this repository is built, deployed and connected on SproutOS — the deploy workflow, backend services, environment variables, migrations, and project groups. Use when the task involves deploying, adding a database or queue, wiring environment variables, running migrations, or making the repository work on SproutOS.
---

# Deploying this repository on SproutOS
${input.sandbox === true ? sandboxSection(input.workspace.path) : ""}
SproutOS runs each deployable target in this repository as its own **project**. A repository with a
web app and a separate API is one repository and two projects, grouped under a parent that holds
them and deploys nothing itself.

## What a deploy actually is

The \`sprout\` CLI is the only deployment orchestrator. It packages output deterministically,
negotiates the upload, creates the release, and waits for a terminal result. The GitHub Marketplace
action is a thin compatibility wrapper around a pinned \`sprout\` release; it does not implement a
second deployment protocol.

The platform publishes a server build as a Lambda version and moves an alias, so a release is
atomic and a rollback is one API call rather than a rebuild. Static builds are activated as an
immutable CDN tree. Android deploys upload exactly one raw unsigned APK for the on-prem signer.

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
      - uses: actions/checkout@v5
      # Build first. The action uploads finished output; it does not guess how this app builds.
      - run: npm ci
      - run: npm run build
      - uses: MySproutOS/sproutos-deploy-action@v1
        with:
          preset: next            # next | hono | web | static | android
          directory: apps/website/.next/standalone
          project: ${project}
          api-url: ${input.apiUrl}
\`\`\`

**\`project\` is required when this repository holds more than one project**, and it is the most
common thing to get wrong. Without it the platform cannot tell which of them this workflow deploys
and refuses rather than guessing — a guess would deploy the right code to the wrong service, which
looks exactly like success.

**\`id-token: write\` is required.** Without it there is no OIDC token, and the deploy fails at the
first step with an authentication error that does not mention permissions.

One workflow per deployable target, each with its own \`directory\` and \`project\`. The wrapper maps
these inputs to the same \`sprout-core\` operations used by the local CLI. It must never guess the
project from the repository name. It exchanges GitHub's OIDC assertion for a short-lived deployment
token and passes that token through the environment, never a command-line argument or repository
secret.

## Running the same deployment locally

Install the checksummed \`sprout\` binary from the SproutOS download page, then:

\`\`\`shell
sprout auth login
sprout org use my-team
sprout deploy ${project} --preset next --path apps/website/.next/standalone
\`\`\`

Use \`SPROUTOS_TOKEN\` only for a trusted headless environment. Human login uses browser PKCE and the
operating-system credential store. Commands provide stable \`--json\` output for agents and scripts;
destructive commands require confirmation or \`--yes\`.

## Deployment templates are catalogue-owned

App Store eligibility and deployment behavior come only from the signed
\`MySproutOS/Deployment-Templates\` catalogue. Resolve the exact upstream commit and immutable
plugin digest recorded there. Never infer deployment behavior from an instruction file in an
arbitrary upstream repository.

A generated fork may contain \`.config/sproutos.toml\`. It is declarative and contains no secret
values. It helps a human or coding agent understand services and bindings, but the imported signed
catalogue remains authoritative. Template plugins receive structural input only: no network,
GitHub, SproutOS, or customer credentials.

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

## Using this skill outside SproutOS

Download the public skill from \`https://sproutos.me/skills/sproutos/SKILL.md\`.

- Claude Code loads it from \`.claude/skills/sproutos/SKILL.md\` in the repository.
- Codex loads an account-level copy from \`~/.codex/skills/sproutos/SKILL.md\`.
- For an AGENTS.md-only harness, preserve the repository's existing \`AGENTS.md\` and add a short
  instruction to read the downloaded skill. Never replace the project's own instructions.

The skill contains instructions, not credentials. Authenticate \`sprout\` yourself. A local agent
runs on your machine and uses the model account configured in that harness, so SproutOS does not
charge sandbox or model usage for that work. Resources the agent creates on SproutOS are still
metered normally.
`
}
