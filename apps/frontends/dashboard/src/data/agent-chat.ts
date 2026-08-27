import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  deleteV1OrgsByOrgSlugProjectsByProjectIdSandboxMutation,
  getV1OrgsByOrgSlugProjectsByProjectIdSandboxOptions,
  getV1OrgsByOrgSlugProjectsByProjectIdSandboxQueryKey,
  getV1OrgsByOrgSlugProjectsByProjectIdAgentSessionsOptions,
  getV1OrgsByOrgSlugProjectsByProjectIdAgentSessionsQueryKey,
  postV1OrgsByOrgSlugProjectsByProjectIdAgentSessionsMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"
import {
  baseUrl,
  getV1OrgsByOrgSlugProjectsByProjectIdSandbox,
  getV1OrgsByOrgSlugAgentConfig,
  postV1OrgsByOrgSlugProjectsByProjectIdSandbox,
} from "@lib/api-client/index"

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

const SANDBOX_START_TIMEOUT_MS = 5 * 60_000
const SANDBOX_DELETE_TIMEOUT_MS = 120_000

type SandboxStartDependencies = {
  preflight: (path: { orgSlug: string }) => Promise<void>
  start: (path: { orgSlug: string; projectId: string }) => Promise<void>
  read: (path: { orgSlug: string; projectId: string }, signal?: AbortSignal) => Promise<string>
  wait: (milliseconds: number) => Promise<void>
  now: () => number
}

const sandboxStartDependencies: SandboxStartDependencies = {
  preflight: async (path) => {
    const { data } = await getV1OrgsByOrgSlugAgentConfig({ path, throwOnError: true })
    if (data.effectiveBilling === "none") {
      throw new Error("No model credential configured")
    }
  },
  start: async (path) => {
    await postV1OrgsByOrgSlugProjectsByProjectIdSandbox({ path, throwOnError: true })
  },
  read: async (path, signal) => {
    const { data } = await getV1OrgsByOrgSlugProjectsByProjectIdSandbox({
      path,
      throwOnError: true,
      signal,
    })
    return data.state
  },
  wait: async (milliseconds) => {
    await new Promise((resolve) => {
      setTimeout(resolve, milliseconds)
    })
  },
  now: Date.now,
}

/** Start the rented workspace only when a person actually sends a turn, then wait for bootstrap. */
export async function ensureSandboxRunning(
  input: { orgSlug: string; projectId: string },
  signal?: AbortSignal,
  dependencies: SandboxStartDependencies = sandboxStartDependencies,
): Promise<void> {
  const path = { orgSlug: input.orgSlug, projectId: input.projectId }
  await dependencies.preflight({ orgSlug: input.orgSlug })
  await dependencies.start(path)

  const deadline = dependencies.now() + SANDBOX_START_TIMEOUT_MS
  while (dependencies.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error("The sandbox start was cancelled")
    const state = await dependencies.read(path, signal)
    if (state === "running") return
    if (state === "failed") throw new Error("The sandbox failed to start")
    await dependencies.wait(1_000)
  }

  throw new Error("The sandbox did not become ready within five minutes")
}

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

/** The newest conversation that can be continued after the Agent route remounts. */
export function latestRestorableAgentSession(
  sessions: AgentSession[] | undefined,
): AgentSession | undefined {
  return sessions?.find((session) => session.status === "active" || session.status === "idle")
}

/** The workspace is durable API state; transcript bubbles are not evidence that it exists. */
export function useAgentSandbox(orgSlug: string, projectId: string) {
  return useQuery({
    ...getV1OrgsByOrgSlugProjectsByProjectIdSandboxOptions({ path: { orgSlug, projectId } }),
    retry: false,
  })
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

/** Permanently release the Daytona workspace and its branch-scoped development database. */
export function useFinishSandbox(orgSlug: string, projectId: string) {
  const client = useQueryClient()
  const mutation = useMutation(deleteV1OrgsByOrgSlugProjectsByProjectIdSandboxMutation())
  return {
    ...mutation,
    finish: async (): Promise<void> => {
      await mutation.mutateAsync({ path: { orgSlug, projectId } })
      await waitForSandboxDeletion({ orgSlug, projectId })
      client.removeQueries({
        queryKey: getV1OrgsByOrgSlugProjectsByProjectIdSandboxQueryKey({
          path: { orgSlug, projectId },
        }),
      })
    },
  }
}

type SandboxDeletionDependencies = {
  readStatus: (path: { orgSlug: string; projectId: string }) => Promise<number>
  wait: (milliseconds: number) => Promise<void>
  now: () => number
}

const sandboxDeletionDependencies: SandboxDeletionDependencies = {
  readStatus: async ({ orgSlug, projectId }) => {
    const response = await fetch(
      `${baseUrl}/v1/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectId)}/sandbox`,
      { credentials: "include" },
    )
    return response.status
  },
  wait: async (milliseconds) => {
    await new Promise((resolve) => {
      setTimeout(resolve, milliseconds)
    })
  },
  now: Date.now,
}

/** Wait until the destroy job has deleted both Daytona's object and the control-plane row. */
export async function waitForSandboxDeletion(
  path: { orgSlug: string; projectId: string },
  dependencies: SandboxDeletionDependencies = sandboxDeletionDependencies,
): Promise<void> {
  const deadline = dependencies.now() + SANDBOX_DELETE_TIMEOUT_MS
  while (dependencies.now() < deadline) {
    const status = await dependencies.readStatus(path)
    if (status === 404) return
    if (status !== 200) throw new Error(`The sandbox deletion check failed (${status})`)
    await dependencies.wait(1_000)
  }
  throw new Error("Daytona did not confirm sandbox deletion within two minutes")
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
