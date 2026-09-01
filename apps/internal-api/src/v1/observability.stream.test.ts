import {
  decodeRuntimeLogStreamCursor,
  encodeRuntimeLogStreamCursor,
  MAX_RUNTIME_LOG_MESSAGE_BYTES,
} from "@lib/observability"
import { describe, expect, it } from "vitest"
import app from "../index"
import { runtimeLogStreamEvent, writeRuntimeLogStreamStoreError } from "./observability"

describe("runtime log stream contract", () => {
  it("round-trips the versioned opaque checkpoint", () => {
    const value = encodeRuntimeLogStreamCursor({
      ingestPartition: "2",
      ingestOffset: "1787918400000",
      ingestKey: "A".repeat(32),
    })
    expect(value).toBe(`1:2:1787918400000:${"A".repeat(32)}`)
    expect(decodeRuntimeLogStreamCursor(value)).toEqual({
      ingestPartition: "2",
      ingestOffset: "1787918400000",
      ingestKey: "A".repeat(32),
    })
    expect(() => decodeRuntimeLogStreamCursor("1:2:1787918400000:not-a-digest")).toThrow(
      "Invalid runtime log stream cursor",
    )
  })

  it("keeps the largest accepted message inside the CLI frame bound", () => {
    const cursor = `1:2:1787918400000:${"C".repeat(32)}`
    const encoded = JSON.stringify(
      runtimeLogStreamEvent({
        ts: new Date("2026-08-28T12:00:00.000Z"),
        cursor,
        level: "info",
        // Control bytes take six JSON bytes each, which is the worst escaping expansion.
        message: "\u0001".repeat(MAX_RUNTIME_LOG_MESSAGE_BYTES),
        requestId: "request-1",
        deploymentId: "deployment-1",
      }),
    )
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(512 * 1024)
  })

  it("emits one stable v1 record with the SSE id repeated as the line cursor", () => {
    const cursor = `1:2:1787918400000:${"B".repeat(64)}`
    const event = runtimeLogStreamEvent({
      ts: new Date("2026-08-28T12:00:00.000Z"),
      cursor,
      level: "info",
      message: "deployed",
      requestId: "request-1",
      deploymentId: "deployment-1",
    })

    expect(event).toEqual({
      schemaVersion: 1,
      type: "log",
      cursor,
      line: {
        timestamp: "2026-08-28T12:00:00.000Z",
        cursor,
        level: "info",
        message: "deployed",
        requestId: "request-1",
        deploymentId: "deployment-1",
        durationMs: null,
        billedMs: null,
        memoryMb: null,
        initMs: null,
        coldStart: null,
      },
    })
    expect(JSON.stringify(event)).not.toContain("authorization")
  })

  it("does not expose a credentialed stream to an unrelated browser origin", async () => {
    const response = await app.request(
      "/v1/orgs/acme/projects/00000000-0000-7000-8000-000000000000/logs/follow",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization",
        },
      },
    )

    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("abandons a terminal error frame when a non-reading downstream is cancelled", async () => {
    const controller = new AbortController()
    let attempted = false
    const blockedWrite = writeRuntimeLogStreamStoreError(() => {
      attempted = true
      return new Promise(() => undefined)
    }, controller.signal)

    controller.abort(new Error("connection deadline"))

    await expect(blockedWrite).resolves.toBeUndefined()
    expect(attempted).toBe(true)
  })
})
