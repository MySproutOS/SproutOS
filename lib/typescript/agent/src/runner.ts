import { query } from "@anthropic-ai/claude-agent-sdk"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { DEPLOYMENT_DOCTRINE } from "./deployment-doctrine"
import { agentSubprocessEnv, toSdkPermissionMode } from "./env"
import { disallowedTools } from "./tools"
import type { TokenUsage } from "./pricing"
import { withMeteredRun } from "./run"

/**
 * The events a chat client actually needs, distilled from the SDK's ~40 message types.
 *
 * Deliberately narrow. The SDK stream carries hook lifecycle, plugin installs, worker shutdown
 * notices, and a dozen other things that are interesting to a CLI and noise to a chat transcript.
 * Widening this later is additive; persisting everything now would put whatever the SDK emits into
 * `agent_event`, which holds customer source code and has a 30-day retention promise attached.
 */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; name: string; isError: boolean }
  | { type: "thinking" }
  | { type: "session"; sdkSessionId: string }
  | { type: "done"; subtype: string; isError: boolean; numTurns: number; durationMs: number }
  | { type: "error"; message: string }

export type AgentRunInput = {
  organizationId: string
  projectId: string
  sessionId: string
  prompt: string
  /** The SDK session to continue. Absent starts a new conversation. */
  resume?: string | null
  /** Where the agent works. A checkout of the project's repository. */
  cwd: string
  maxTurns?: number
  signal?: AbortSignal
}

export type AgentRunOutcome = {
  sdkSessionId: string | null
  usage: TokenUsage
  chargedMicroUsd: bigint
  subtype: string
  isError: boolean
  numTurns: number
  durationMs: number
}

/**
 * One turn of agent chat, metered.
 *
 * The whole run is wrapped in `withMeteredRun`, so a platform-billed organization has the money
 * reserved before the first token is bought and settled against what was actually used. A
 * customer running on their own credential pays nothing to us and reserves nothing; the tokens are
 * still counted, because the usage is worth showing either way.
 *
 * Token accounting reads `modelUsage`, not `usage`. `usage` covers the main agent loop only,
 * excluding Task subagents and internal calls like compaction — real model calls that a customer's
 * key really pays for. `modelUsage` is cumulative across turns and each result carries the running
 * total, so the *latest* result is read rather than summed.
 */
/**
 * Whether a failure is "the runner does not have that conversation".
 *
 * Matched on the message, because the SDK reports it as a generic `error_result` with the detail
 * only in the text. Narrow on purpose: a broader match would swallow real failures and retry them,
 * which is how one bad turn becomes two.
 */
function isMissingConversation(cause: unknown): boolean {
  return cause instanceof Error && /No conversation found with session ID/i.test(cause.message)
}

export async function runAgentTurn(
  db: Kysely<DB>,
  input: AgentRunInput,
  emit: (event: AgentEvent) => void | Promise<void>,
): Promise<AgentRunOutcome> {
  let sdkSessionId: string | null = input.resume ?? null
  let subtype = "unknown"
  let isError = false
  let numTurns = 0
  let durationMs = 0
  // The SDK reports cumulative totals, so the last result wins rather than the sum.
  let latest: TokenUsage | null = null

  const result = await withMeteredRun(
    db,
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceType: "agent_run",
      resourceId: input.sessionId,
      description: "Agent chat",
    },
    async ({ credential, report }) => {
      if (credential.billing !== "byo") {
        // Platform credits run on our OpenAI key, which is not an Anthropic-shaped endpoint and
        // therefore cannot drive the Claude Code agent. That path is a plain chat completion, and
        // routing it here would produce a subprocess with no usable credential.
        throw new Error("Platform-billed runs do not use the Claude Code agent runner")
      }

      /*
        `resume` is an optimisation, not a requirement.

        The SDK stores a conversation on the *runner's filesystem*, under `HOME`. Ours is an
        `emptyDir`, so every rollout, restart and eviction destroys every transcript — while
        `agent_session.sdk_session_id` sits in Postgres looking durable. A second replica makes it
        worse: the pod that serves the next message is usually not the one that served the last.

        Observed exactly that way: an agent conversation worked, the API was redeployed, and the
        next message failed with `No conversation found with session ID`. The turn history is in
        `agent_turn` regardless, so losing the SDK's copy costs context, not correctness — and a
        turn that fails outright costs both.
      */
      const runQuery = (resume: string | undefined) =>
        query({
          prompt: input.prompt,
          options: {
            cwd: input.cwd,
            /*
              The preset plus what this platform means by "deploy".

              `append` rather than a replacement: the preset carries Claude Code's own tool and
              file-editing conventions, and dropping those to state six bullet points would trade a
              working coding agent for an informed one.
            */
            systemPrompt: { type: "preset", preset: "claude_code", append: DEPLOYMENT_DOCTRINE },
            // Replaces the environment entirely — see env.ts. This is the line that keeps the API
            // process's secrets out of the agent.
            env: agentSubprocessEnv(credential),
            permissionMode: toSdkPermissionMode(credential.permissionMode),
            ...(credential.model === null ? {} : { model: credential.model }),
            ...(resume == null ? {} : { resume }),
            ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
            ...(input.signal === undefined ? {} : { abortController: toController(input.signal) }),
            // The agent reads the *project's* configuration, never the runner host's. Without this
            // it would pick up whatever ~/.claude on the pod happens to contain, which on a shared
            // runner is another tenant's settings.
            settingSources: ["project"],
            /*
            No shell, no fetch, no subagents — see `tools.ts`.

            `env` above keeps the API's secrets out of the subprocess's environment, and that is
            not enough on its own: the subprocess runs as the same uid, so `/proc/1/environ` reads
            the parent's environment in full and the pod's service-account token is a file on disk.
            The tool list is the control that closes it, until an agent turn runs in the Kata
            sandbox ADR 0012 describes.
          */
            disallowedTools: disallowedTools(),
          },
        })

      /**
       * Consume one query to completion.
       *
       * A function because it may be called twice: once with the stored transcript, and once
       * without, if the runner no longer holds it.
       */
      async function consume(resume: string | undefined): Promise<void> {
        for await (const message of runQuery(resume)) {
          switch (message.type) {
            case "system":
              if (message.subtype === "init") {
                sdkSessionId = message.session_id
                await emit({ type: "session", sdkSessionId: message.session_id })
              }
              break

            case "assistant":
              for (const block of message.message.content) {
                if (block.type === "text") await emit({ type: "text", text: block.text })
                else if (block.type === "thinking") await emit({ type: "thinking" })
                else if (block.type === "tool_use") {
                  await emit({ type: "tool_use", name: block.name, input: block.input })
                }
              }
              break

            case "user":
              for (const block of message.message.content ?? []) {
                if (typeof block !== "string" && block.type === "tool_result") {
                  await emit({
                    type: "tool_result",
                    name: block.tool_use_id,
                    isError: block.is_error === true,
                  })
                }
              }
              break

            case "result": {
              subtype = message.subtype
              isError = message.is_error
              numTurns = message.num_turns
              durationMs = message.duration_ms
              sdkSessionId = message.session_id
              latest = totalUsage(message.modelUsage)
              break
            }

            default:
              // Everything else — hooks, plugins, status, retries — is CLI chrome.
              break
          }
        }
      }

      try {
        await consume(input.resume ?? undefined)
      } catch (cause) {
        /*
          Only this error, and only when there was a transcript to lose.

          A transcript the runner no longer holds is recoverable: start the conversation again
          without it. Anything else is a real failure, and retrying would hide it — one bad turn
          becoming two. The turn history lives in `agent_turn` either way, so this costs the model's
          own context and not the record.

          The SDK fails on `resume` before emitting anything, so nothing has reached the client yet
          and the second attempt cannot duplicate output.
        */
        if (input.resume == null || !isMissingConversation(cause)) throw cause
        console.warn("agent transcript not on this runner; starting the conversation again")
        await consume(undefined)
      }

      // Reported once, at the end, because the SDK's totals are cumulative: reporting per message
      // would count the same tokens as many times as there were results.
      if (latest !== null) report(latest)

      return null
    },
  )

  return {
    sdkSessionId,
    usage: result.usage,
    chargedMicroUsd: result.chargedMicroUsd,
    subtype,
    isError,
    numTurns,
    durationMs,
  }
}

/**
 * Cache *creation* tokens rate as input, because that is what they cost — a cache write is billed
 * at the input rate, and only cache *reads* get the discounted rate. Folding creation into the
 * cache-read dimension would under-bill every first request of a conversation.
 */
function totalUsage(
  modelUsage: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
    }
  >,
): TokenUsage {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0

  for (const usage of Object.values(modelUsage)) {
    inputTokens += usage.inputTokens + usage.cacheCreationInputTokens
    outputTokens += usage.outputTokens
    cacheReadTokens += usage.cacheReadInputTokens
  }

  return { inputTokens, outputTokens, cacheReadTokens }
}

/** The SDK takes an AbortController; a Hono handler has an AbortSignal. */
function toController(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else
    signal.addEventListener(
      "abort",
      () => {
        controller.abort()
      },
      { once: true },
    )
  return controller
}
