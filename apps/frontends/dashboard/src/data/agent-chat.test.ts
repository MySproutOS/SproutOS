import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type AgentEvent,
  agentSessionIsRunning,
  ensureSandboxRunning,
  latestRestorableAgentSession,
  streamAgentTurn,
  waitForSandboxDeletion,
} from "./agent-chat"

/**
 * SSE framing is parsed here rather than by the browser, because EventSource only issues GET
 * requests and the prompt has to be a body. That makes the chunk boundaries our problem: the
 * network splits a stream wherever it likes, including through the middle of a frame.
 */
function streamOf(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

function mockFetch(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(response)),
  )
}

const input = { orgSlug: "acme", projectId: "p1", sessionId: "s1", prompt: "hi" }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ensureSandboxRunning", () => {
  it("starts the sandbox and waits through provisioning before returning", async () => {
    const states = ["starting", "starting", "running"]
    const start = vi.fn<() => Promise<void>>(() => Promise.resolve())
    const read = vi.fn<() => Promise<string>>(() => Promise.resolve(states.shift() ?? "running"))
    const wait = vi.fn<() => Promise<void>>(() => Promise.resolve())
    let now = 0

    await ensureSandboxRunning({ orgSlug: "acme", projectId: "p1" }, undefined, {
      preflight: () => Promise.resolve(),
      start,
      read,
      wait,
      now: () => now++,
    })

    expect(start).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it("reports a provider-side start failure without opening an agent stream", async () => {
    await expect(
      ensureSandboxRunning({ orgSlug: "acme", projectId: "p1" }, undefined, {
        preflight: () => Promise.resolve(),
        start: () => Promise.resolve(),
        read: () => Promise.resolve("failed"),
        wait: () => Promise.resolve(),
        now: () => 0,
      }),
    ).rejects.toThrow("The sandbox failed to start")
  })

  it("allows a slow Daytona resume five minutes before timing out", async () => {
    let now = 0
    let waits = 0

    await expect(
      ensureSandboxRunning({ orgSlug: "acme", projectId: "p1" }, undefined, {
        preflight: () => Promise.resolve(),
        start: () => Promise.resolve(),
        read: () => Promise.resolve("starting"),
        wait: (milliseconds) => {
          waits += 1
          now += milliseconds
          return Promise.resolve()
        },
        now: () => now,
      }),
    ).rejects.toThrow("within five minutes")

    expect(waits).toBe(300)
  })

  it("refuses an unconfigured agent before renting a sandbox", async () => {
    const start = vi.fn<() => Promise<void>>()
    await expect(
      ensureSandboxRunning({ orgSlug: "acme", projectId: "p1" }, undefined, {
        preflight: () => Promise.reject(new Error("No model credential configured (no_config)")),
        start,
        read: () => Promise.resolve("running"),
        wait: () => Promise.resolve(),
        now: () => 0,
      }),
    ).rejects.toThrow("No model credential configured (no_config)")
    expect(start).not.toHaveBeenCalled()
  })
})

describe("latestRestorableAgentSession", () => {
  it("restores the newest resumable session after route navigation", () => {
    expect(
      latestRestorableAgentSession([
        { id: "finished", title: null, status: "completed", createdLabel: "now" },
        { id: "latest", title: null, status: "active", createdLabel: "earlier" },
        { id: "older", title: null, status: "active", createdLabel: "oldest" },
      ])?.id,
    ).toBe("latest")
  })

  it("does not revive a completed conversation", () => {
    expect(
      latestRestorableAgentSession([
        { id: "done", title: null, status: "completed", createdLabel: "now" },
      ]),
    ).toBeUndefined()
  })
})

describe("agentSessionIsRunning", () => {
  it("keeps a live turn running across reload while Daytona starts or serves it", () => {
    expect(agentSessionIsRunning("active", "starting")).toBe(true)
    expect(agentSessionIsRunning("active", "running")).toBe(true)
  })

  it("does not let a stale active row disable chat after its sandbox was deleted", () => {
    expect(agentSessionIsRunning("active", undefined)).toBe(false)
    expect(agentSessionIsRunning("active", "deleting")).toBe(false)
    expect(agentSessionIsRunning("idle", "running")).toBe(false)
  })
})

describe("waitForSandboxDeletion", () => {
  it("does not report Done until the sandbox row has disappeared", async () => {
    const statuses = [200, 200, 404]
    const waits: number[] = []
    let now = 0

    await waitForSandboxDeletion(
      { orgSlug: "acme", projectId: "p1" },
      {
        readStatus: () => Promise.resolve(statuses.shift()!),
        wait: (milliseconds) => {
          waits.push(milliseconds)
          now += milliseconds
          return Promise.resolve()
        },
        now: () => now,
      },
    )

    expect(waits).toEqual([1_000, 1_000])
  })

  it("does not mistake an authorization or server failure for completed deletion", async () => {
    await expect(
      waitForSandboxDeletion(
        { orgSlug: "acme", projectId: "p1" },
        {
          readStatus: () => Promise.resolve(503),
          wait: () => Promise.resolve(),
          now: () => 0,
        },
      ),
    ).rejects.toThrow(/deletion check failed \(503\)/)
  })
})

describe("streamAgentTurn", () => {
  it("reads events out of a well-formed stream", async () => {
    mockFetch(
      streamOf([
        'event: text\ndata: {"type":"text","text":"Hello"}\n\n',
        'event: done\ndata: {"type":"done","subtype":"success","isError":false,"numTurns":1,"durationMs":10}\n\n',
      ]),
    )

    const events: AgentEvent[] = []
    await streamAgentTurn(input, (event) => events.push(event))

    expect(events.map((event) => event.type)).toEqual(["text", "done"])
  })

  it("reassembles a frame the network split down the middle", async () => {
    // The obvious implementation — parse each chunk on arrival — loses this event entirely.
    mockFetch(
      streamOf(['event: text\ndata: {"type":"te', 'xt","text":"split across chunks"}', "\n\n"]),
    )

    const events: AgentEvent[] = []
    await streamAgentTurn(input, (event) => events.push(event))

    expect(events).toEqual([{ type: "text", text: "split across chunks" }])
  })

  it("reads several frames delivered in one chunk", async () => {
    mockFetch(
      streamOf([
        'data: {"type":"text","text":"a"}\n\ndata: {"type":"text","text":"b"}\n\ndata: {"type":"thinking"}\n\n',
      ]),
    )

    const events: AgentEvent[] = []
    await streamAgentTurn(input, (event) => events.push(event))

    expect(events).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "thinking" },
    ])
  })

  it("keeps going past a frame it cannot parse", async () => {
    // The run is still alive and the next frame is probably fine. Throwing here would end a
    // working conversation over one bad line.
    mockFetch(streamOf(['data: {"type":"text"\n\n', 'data: {"type":"text","text":"after"}\n\n']))

    const events: AgentEvent[] = []
    await streamAgentTurn(input, (event) => events.push(event))

    expect(events).toEqual([{ type: "text", text: "after" }])
  })

  it("raises the API's message when the run is refused", async () => {
    // No credential, no credit, no repository: an ordinary JSON error before the stream begins.
    // Reading it as a stream would show an empty chat response instead of the reason.
    // The envelope is OData-shaped. Reading a bare `message` here silently degrades to the
    // generic fallback, which is how this was wrong the first time.
    mockFetch(
      new Response(
        JSON.stringify({
          error: { code: "BadRequest", message: "No model credential configured (revoked)" },
        }),
        { status: 400 },
      ),
    )

    await expect(streamAgentTurn(input, () => {})).rejects.toThrow(
      "No model credential configured (revoked)",
    )
  })

  it("does not swallow an unparseable refusal", async () => {
    mockFetch(new Response("upstream exploded", { status: 502 }))
    await expect(streamAgentTurn(input, () => {})).rejects.toThrow(/502/)
  })
})
