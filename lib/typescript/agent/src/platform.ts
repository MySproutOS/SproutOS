import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import OpenAI from "openai"
import { platformOpenAiKey } from "./resolve"
import type { AgentEvent } from "./runner"
import { withMeteredRun } from "./run"
import type { TokenUsage } from "./pricing"

/**
 * Chat on the platform's own key, charged to the customer's credit balance.
 *
 * This is the other half of the credential model: a customer running on their own subscription or
 * API key uses the Claude Code agent runner and pays their provider directly. A customer paying
 * out of credits uses this, because our key is OpenAI's and OpenAI is not an Anthropic-shaped
 * endpoint that Claude Code can be pointed at.
 *
 * **It answers questions; it does not edit files.** Tool use, a checkout, and a pull request are
 * the agent runner's job, and giving a second model harness write access to a customer's
 * repository is not a thing to add quietly. The route says so rather than letting someone discover
 * it by asking for a change and getting a description of one.
 *
 * The key never leaves this process — there is no subprocess to inherit it and no tenant VM to
 * hand it to — which is what makes it safe to spend our own credential here at all.
 */

const PLATFORM_MODEL = "gpt-5.6-terra"
const LONG_CONTEXT_THRESHOLD = 272_000

export function platformModel(requested?: string | null): string {
  const model = requested ?? PLATFORM_MODEL
  if (model !== PLATFORM_MODEL) {
    throw new Error(`Platform credit currently supports only ${PLATFORM_MODEL}`)
  }
  return model
}

/**
 * Headroom, not an answer length.
 *
 * `max_completion_tokens` on a reasoning model covers reasoning *and* the visible reply, and the
 * reasoning comes first. Observed: a one-word answer ("zorblatt") spent 128 reasoning tokens and
 * 11 visible ones. Set the cap to 64 and the model uses all of it thinking, stops at `length`, and
 * returns an empty string — having charged for 64 tokens. The default has to leave room for a
 * model that thinks before it speaks.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192

/** The parts of OpenAI's usage object that map onto price-book dimensions. */
export type OpenAiUsage = {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null
  completion_tokens_details?: { reasoning_tokens?: number } | null
}

/**
 * Map OpenAI's usage onto the three dimensions the price book rates.
 *
 * Two things here are easy to get wrong in opposite directions, and neither fails visibly:
 *
 * - **Cached prompt tokens are subtracted from input**, not counted twice. `prompt_tokens` is the
 *   total *including* cached ones; they bill at a discount, which is what `ai_cache_read_token`
 *   is. Leaving them in charges the full input rate for text the model did not reprocess — which
 *   is most of a long conversation.
 * - **Reasoning tokens are already inside `completion_tokens`** — 139 total for 128 reasoning and
 *   11 visible, in a real response — and OpenAI charges them at the output rate. Adding
 *   `reasoning_tokens` on top would double-bill the most expensive dimension.
 */
export function toTokenUsage(usage: OpenAiUsage): TokenUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? 0
  if (usage.prompt_tokens > LONG_CONTEXT_THRESHOLD) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      longContextInputTokens: Math.max(0, usage.prompt_tokens - cached - cacheWrite),
      longContextOutputTokens: usage.completion_tokens,
      longContextCacheReadTokens: cached,
      longContextCacheWriteTokens: cacheWrite,
    }
  }
  return {
    inputTokens: Math.max(0, usage.prompt_tokens - cached - cacheWrite),
    outputTokens: usage.completion_tokens,
    cacheReadTokens: cached,
    cacheWriteTokens: cacheWrite,
  }
}

/** A conversation, oldest first. */
export type PlatformMessage = { role: "user" | "assistant"; content: string }

export type PlatformRunInput = {
  organizationId: string
  projectId?: string | null
  sessionId: string
  messages: readonly PlatformMessage[]
  model?: string | null
  /** Sizes the credit reservation. */
  maxOutputTokens?: number
  signal?: AbortSignal
}

export type PlatformRunOutcome = {
  usage: TokenUsage
  chargedMicroUsd: bigint
  finishReason: string
}

const SYSTEM_PROMPT = [
  "You are the SproutOS assistant, helping someone with a project they host on SproutOS.",
  "You cannot read or edit their repository — you have no tools.",
  "If they ask for a code change, say plainly that making changes requires connecting their own",
  "Claude subscription or API key in settings, and then answer as much of the question as you can",
  "from what they have told you.",
].join(" ")

export async function runPlatformChat(
  db: Kysely<DB>,
  input: PlatformRunInput,
  emit: (event: AgentEvent) => void | Promise<void>,
): Promise<PlatformRunOutcome> {
  let finishReason = "unknown"
  let produced = false
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }

  const result = await withMeteredRun(
    db,
    {
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      resourceType: "agent_run",
      resourceId: input.sessionId,
      description: "Assistant chat",
      // The reservation is sized on output, the expensive dimension, plus headroom for the
      // conversation being sent back up. See estimateRunCost — a hold that is too large only makes
      // the remainder briefly unavailable, while one that is too small aborts affordable work.
      reservationTokens: (input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) * 4,
    },
    async ({ credential, report }) => {
      if (credential.billing !== "platform") {
        // Reached only if the caller routed a BYO credential here. Spending our key on a customer
        // who has their own would be us paying their bill.
        throw new Error("runPlatformChat is only for credit-billed runs")
      }

      const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
      // Every platform-funded token must have a derivable provider cost. A different model has
      // different rates, and silently applying Terra's book would make the charge fiction.
      const model = platformModel(input.model ?? credential.model)
      const client = new OpenAI({ apiKey: platformOpenAiKey() })
      const stream = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...input.messages.map((message) => ({ role: message.role, content: message.content })),
          ],
          stream: true,
          // Without this the response carries no usage and the run settles for nothing — we would
          // buy the tokens and charge zero.
          stream_options: { include_usage: true },
          max_completion_tokens: maxOutputTokens,
        },
        { signal: input.signal },
      )

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content
        if (delta !== undefined && delta !== null && delta !== "") {
          produced = true
          await emit({ type: "text", text: delta })
        }
        if (chunk.choices[0]?.finish_reason != null) {
          finishReason = chunk.choices[0].finish_reason
        }
        // The usage chunk arrives once, at the end, and carries totals rather than a delta.
        if (chunk.usage != null) usage = toTokenUsage(chunk.usage)
      }

      if (Object.values(usage).every((quantity) => (quantity ?? 0) === 0)) {
        // A stream that produced text but reported no usage means we bought tokens we cannot
        // account for. Better to notice loudly than to hand out free inference.
        console.warn(`[platform-chat] no usage reported for session ${input.sessionId}`)
      }

      // A reasoning model that spends its whole budget thinking stops at `length` with nothing to
      // show. The tokens are real and are charged, so saying nothing at all would be a bill for a
      // blank screen. Say what happened instead.
      if (finishReason === "length" && !produced) {
        await emit({
          type: "text",
          text: "The model ran out of room before it answered. Try a shorter question.",
        })
      }

      report(usage)
      return null
    },
  )

  return { usage: result.usage, chargedMicroUsd: result.chargedMicroUsd, finishReason }
}
