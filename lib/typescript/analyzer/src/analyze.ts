import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { type AgentEvent, runPlatformChat } from "@lib/agent"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { gatherEvidence, renderEvidence } from "./evidence"
import { InvalidManifestError, parseManifest, type RepoManifest } from "./manifest"

const run = promisify(execFile)

/**
 * TASKS 38 and 39: read a repository and say what it needs to run here.
 *
 * Both entry points — importing a repository that is not in the store, and proposing one for it —
 * produce the same artifact, so they are the same function. `manifest.services` is what
 * provisioning consumes; `manifest.modifications` is what becomes a pull request someone reads.
 * Nothing here is applied.
 *
 * **The clone is unauthenticated.** TASK 39 is about open source projects, which are public by
 * definition, so this path needs no GitHub App — which is why it works today. A private repository
 * fails at the clone with a clear message rather than half-analysing.
 */

export type AnalyzeInput = {
  analysisId: string
  organizationId: string
  owner: string
  repo: string
  ref?: string | null
  host?: string
}

export type AnalyzeOutcome = {
  manifest: RepoManifest
  confidence: number
  commitSha: string
  chargedMicroUsd: bigint
}

export class RepositoryUnavailableError extends Error {
  override readonly name = "RepositoryUnavailableError"

  constructor(readonly slug: string) {
    super(`Could not clone ${slug}. It has to be a public repository.`)
  }
}

const SYSTEM_PROMPT = `
You are analysing an open source repository so it can be deployed on SproutOS.

SproutOS offers exactly three backend services: postgres, valkey, elasticsearch. It runs web
applications as containers with a build step and a start command, listening on one port.

Reply with a single JSON object and nothing else. Do not wrap it in markdown fences.

{
  "runtime": "the language and version, e.g. 'node 22' or 'python 3.13'",
  "buildCommand": "or null",
  "startCommand": "or null",
  "port": 3000,
  "services": ["postgres"],
  "envVars": [{"name":"DATABASE_URL","secret":true,"providedByPlatform":true,"purpose":"..."}],
  "migrations": "the command that applies schema, or null",
  "modifications": [{"path":"Dockerfile","reason":"why this file must change to run on SproutOS"}],
  "unknowns": ["anything you could not determine from what you were shown"],
  "summary": "two sentences on what this application is",
  "confidence": 0-100
}

Rules:
- providedByPlatform is true only for values SproutOS can fill in itself, such as a connection URI
  for a service listed in "services".
- If the project needs something outside those three services, do not invent a service kind. Name
  it in "services" anyway and it will be reported as unavailable.
- Prefer "unknowns" over guessing. An analysis that admits what it does not know is more useful
  than one that is confidently wrong.
`.trim()

export async function analyzeRepository(
  db: Kysely<DB>,
  input: AnalyzeInput,
): Promise<AnalyzeOutcome> {
  const host = input.host ?? "github.com"
  const slug = `${input.owner}/${input.repo}`
  const path = await mkdtemp(join(tmpdir(), "sproutos-analyze-"))

  try {
    const args = ["clone", "--depth", "1", "--single-branch"]
    if (input.ref != null && input.ref !== "") args.push("--branch", input.ref)
    args.push(`https://${host}/${input.owner}/${input.repo}.git`, path)

    try {
      await run("git", args, {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          // No credential, and no prompt to ask for one — a private repository fails here with a
          // clear message instead of hanging a worker on a username prompt.
          GIT_TERMINAL_PROMPT: "0",
        },
      })
    } catch {
      throw new RepositoryUnavailableError(slug)
    }

    const { stdout } = await run("git", ["-C", path, "rev-parse", "HEAD"])
    const commitSha = stdout.trim()

    const evidence = await gatherEvidence(path)
    let answer = ""

    const outcome = await runPlatformChat(
      db,
      {
        organizationId: input.organizationId,
        sessionId: input.analysisId,
        messages: [
          { role: "user", content: SYSTEM_PROMPT },
          { role: "user", content: `Repository: ${slug}\n\n${renderEvidence(evidence)}` },
        ],
        maxOutputTokens: 8192,
      },
      (event: AgentEvent) => {
        if (event.type === "text") answer += event.text
      },
    )

    const { manifest, confidence } = parseManifest(extractJson(answer))
    return { manifest, confidence, commitSha, chargedMicroUsd: outcome.chargedMicroUsd }
  } finally {
    // The checkout is a copy of somebody's source. It goes whether the analysis worked or not.
    await rm(path, { recursive: true, force: true })
  }
}

/**
 * Pull the JSON object out of a reply.
 *
 * Asking for "a single JSON object and nothing else" gets one most of the time and a fenced block
 * or a sentence of preamble the rest. Failing the whole run — which the customer paid for — over
 * three backticks would be the wrong trade.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced?.[1] ?? text

  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start === -1 || end <= start) {
    throw new InvalidManifestError("the reply contained no JSON object")
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    throw new InvalidManifestError("the reply was not valid JSON")
  }
}
