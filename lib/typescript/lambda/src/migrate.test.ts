import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda"
import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { invokeMigrationOnce } from "./migrate"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
          })
        }),
    ),
  )
})

describe("migration invocation retry boundary", () => {
  it("makes one request when Lambda returns a retriable server error", async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.writeHead(500, {
        "content-type": "application/x-amz-json-1.0",
        "x-amzn-errortype": "ServiceException",
      })
      response.end(JSON.stringify({ message: "retryable failure" }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("server has no TCP port")

    const lifecycleClient = new LambdaClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 3,
    })

    // Prove the fixture really is retriable under the SDK's ordinary policy. Otherwise a
    // one-request assertion below could pass while exercising a non-retriable error.
    await expect(
      lifecycleClient.send(
        new InvokeCommand({
          FunctionName: "sproutos-migrate-control",
          InvocationType: "RequestResponse",
        }),
      ),
    ).rejects.toThrow("retryable failure")
    expect(requests).toBe(3)

    requests = 0
    await expect(invokeMigrationOnce(lifecycleClient, "sproutos-migrate-test")).rejects.toThrow(
      "retryable failure",
    )

    expect(requests).toBe(1)
    // Cloning is scoped to Invoke: lifecycle operations retain their normal retry budget.
    await expect(lifecycleClient.config.maxAttempts()).resolves.toBe(3)
  })
})
