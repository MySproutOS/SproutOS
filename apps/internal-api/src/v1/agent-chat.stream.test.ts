import type { AgentEvent } from "@lib/agent"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describe, expect, it } from "vitest"
import { sandboxEventRelay } from "./agent-chat"

function eventTypes(body: string): string[] {
  return body
    .split("\n\n")
    .flatMap((frame) => frame.split("\n"))
    .filter((line) => line.startsWith("data: "))
    .map((line) => (JSON.parse(line.slice(6)) as AgentEvent).type)
}

describe("the Daytona turn stream", () => {
  it("waits for ordered writes, durably appends done last, and closes the response", async () => {
    const durable: AgentEvent[] = []
    let releaseFirstWrite: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })

    const app = new Hono().get("/", (c) =>
      streamSSE(c, async (stream) => {
        let writes = 0
        const emit = async (event: AgentEvent) => {
          writes += 1
          if (writes === 1) await firstWrite
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
          durable.push(event)
        }
        const relay = sandboxEventRelay(emit)

        relay.onEvent({ type: "text", text: "finished in Daytona" })
        relay.onEvent({
          type: "done",
          subtype: "success",
          isError: false,
          numTurns: 1,
          durationMs: 25,
        })

        queueMicrotask(() => releaseFirstWrite?.())
        await relay.drain()
        await emit({
          type: "committed",
          branch: "sproutos/agent-test",
          sha: "abc",
          files: [],
        })
        await emit(relay.terminal(0))
      }),
    )

    const response = await app.request("/")
    const body = await response.text()

    expect(eventTypes(body)).toEqual(["text", "committed", "done"])
    expect(durable.map((event) => event.type)).toEqual(["text", "committed", "done"])
  })

  it("synthesizes a durable terminal event when the harness exits without one", async () => {
    const durable: AgentEvent[] = []
    const relay = sandboxEventRelay((event) => {
      durable.push(event)
      return Promise.resolve()
    })

    relay.onEvent({ type: "text", text: "the last harness record" })
    await relay.drain()
    durable.push(relay.terminal(0))

    expect(durable).toEqual([
      { type: "text", text: "the last harness record" },
      {
        type: "done",
        subtype: "success",
        isError: false,
        numTurns: 1,
        durationMs: 0,
      },
    ])
  })
})
