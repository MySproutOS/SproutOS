import { afterEach, describe, expect, it, vi } from "vitest"
import { type AgentEvent, streamAgentTurn } from "./agent-chat"

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
