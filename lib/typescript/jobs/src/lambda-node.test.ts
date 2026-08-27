import type { LambdaClient } from "@aws-sdk/client-lambda"
import { describe, expect, it } from "vitest"
import { runNodeInLambda } from "./lambda-node"

describe("workflow node Lambda event", () => {
  it("keeps trigger payload separate from immutable action config", async () => {
    let event: unknown
    const client = {
      send: (command: { input: { Payload?: Uint8Array | string } }) => {
        event = JSON.parse(Buffer.from(command.input.Payload ?? "").toString("utf8"))
        return Promise.resolve({ Payload: Buffer.from("null") })
      },
    } as unknown as LambdaClient

    await runNodeInLambda(client, {
      projectId: "01a00000-0000-7000-8000-000000000000",
      runId: "run",
      nodeId: "send",
      nodeType: "action.http",
      config: { url: "https://example.com" },
      trigger: { postId: "p1" },
    })

    expect(event).toMatchObject({
      sproutos: {
        config: { url: "https://example.com" },
        trigger: { postId: "p1" },
      },
    })
  })
})
