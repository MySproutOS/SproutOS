import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getV1OrgsByOrgSlugProjectsByProjectIdAgentSessionsOptions,
  getV1OrgsByOrgSlugProjectsByProjectIdAgentSessionsQueryKey,
  postV1OrgsByOrgSlugProjectsByProjectIdAgentSessionsMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"
import { baseUrl } from "@lib/api-client/index"

export type AgentSession = {
  id: string
  title: string | null
  status: string
  createdLabel: string
}

/**
 * The events the chat renders. Mirrors `AgentEvent` in `@lib/agent`, by hand.
 *
 * The streaming route is hidden from the OpenAPI document — hey-api would generate a client method
 * that resolves on the first chunk and drops the rest — so there is no generated type to import
 * and this one is written out. The cost of that is a shape that can drift; the alternative was a
 * generated function that is wrong to call.
 */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; name: string; isError: boolean }
  | { type: "thinking" }
  | { type: "session"; sdkSessionId: string }
  | { type: "done"; subtype: string; isError: boolean; numTurns: number; durationMs: number }
  | { type: "error"; message: string }

const CREATED_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

export function useAgentSessions(orgSlug: string, projectId: string) {
  const query = useQuery(
    getV1OrgsByOrgSlugProjectsByProjectIdAgentSessionsOptions({ path: { orgSlug, projectId } }),
  )

  return {
    ...query,
    data: query.data?.data.map((session): AgentSession => ({
      id: session.id,
      title: session.title,
      status: session.status,
      // The generated type says Date; without transformers.gen.ts it is an ISO string.
      createdLabel: CREATED_FORMAT.format(new Date(session.createdAt)),
    })),
  }
}

export function useCreateAgentSession(orgSlug: string, projectId: string) {
  const client = useQueryClient()
  const mutation = useMutation(postV1OrgsByOrgSlugProjectsByProjectIdAgentSessionsMutation())

  return {
    ...mutation,
    createSession: async (): Promise<string> => {
      const session = await mutation.mutateAsync({ path: { orgSlug, projectId }, body: {} })
      await client.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugProjectsByProjectIdAgentSessionsQueryKey({
          path: { orgSlug, projectId },
        }),
      })
      return session.id
    },
  }
}

/**
 * Send a prompt and read the agent's events as they arrive.
 *
 * `fetch` with a stream reader rather than `EventSource`, because EventSource only issues GET
 * requests and the prompt has to be a body. That means the SSE framing is parsed here — six lines
 * of it — instead of by the browser.
 */
export async function streamAgentTurn(
  input: { orgSlug: string; projectId: string; sessionId: string; prompt: string },
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${baseUrl}/v1/orgs/${input.orgSlug}/projects/${input.projectId}/agent/sessions/${input.sessionId}/messages`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: input.prompt }),
      signal,
    },
  )

  // A refusal — no credential, no credit, no repository — arrives as ordinary JSON, before the
  // stream starts. Reading it as a stream would show the user an empty chat response.
  //
  // The envelope is OData-shaped (`{ error: { code, message } }`), not a bare `{ message }`.
  // Reading the wrong field does not fail loudly: it falls through to the generic fallback, and
  // the user is told "the agent could not start" instead of "your credential was revoked".
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(body.error?.message ?? `The agent could not start (${response.status})`)
  }
  if (response.body === null) throw new Error("The agent returned no stream")

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value

    // SSE frames are separated by a blank line. A chunk can split one anywhere, so the tail stays
    // in the buffer until its terminator arrives.
    let boundary = buffer.indexOf("\n\n")
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const event = parseFrame(frame)
      if (event !== null) onEvent(event)
      boundary = buffer.indexOf("\n\n")
    }
  }
}

function parseFrame(frame: string): AgentEvent | null {
  // Only `data:` matters — the event name duplicates the `type` inside the payload.
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")

  if (data === "") return null
  try {
    return JSON.parse(data) as AgentEvent
  } catch {
    // A malformed frame is not worth killing the stream over: the run is still going, and the
    // next frame is probably fine.
    return null
  }
}
