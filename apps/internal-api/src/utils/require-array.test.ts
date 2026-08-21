import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { requireArray } from "./require-array"

function app() {
  const hono = new Hono()
  hono.post("/exec", requireArray("command", "There is no shell to split a command line."), (c) =>
    c.json({ ran: true }),
  )
  return hono
}

const post = (body: string) =>
  app().request("/exec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })

describe("requireArray", () => {
  it("lets an array through", async () => {
    const response = await post('{"command":["ls","-la"]}')
    expect(response.status).toBe(200)
  })

  /*
    The case this exists for.

    Without the guard the validator's `Value.Convert` turns `"ls -la"` into `["ls -la"]`, the
    schema is satisfied, and the sandbox is asked to run a binary with a space in its name.
  */
  it("refuses a command line", async () => {
    const response = await post('{"command":"ls -la"}')
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("must be an array")
  })

  it("refuses a number, which Convert would stringify into a one-element argv", async () => {
    expect((await post('{"command":42}')).status).toBe(400)
  })

  it("refuses an object", async () => {
    expect((await post('{"command":{"0":"ls"}}')).status).toBe(400)
  })

  /*
    A 400, not a 502.

    The first version called `throwBadRequest` without returning it. That helper builds a response
    rather than throwing one, so the response was dropped and the request continued into the
    handler with its body already read — which reached the client as a bad gateway.
  */
  it("returns its response rather than dropping it", async () => {
    const response = await post('{"command":"pwd"}')
    expect(response.status).toBe(400)
    expect(response.status).not.toBe(502)
  })

  it("leaves an absent field to the schema's own required check", async () => {
    expect((await post("{}")).status).toBe(200)
  })

  it("leaves malformed JSON to the validator", async () => {
    expect((await post("{not json")).status).toBe(200)
  })
})
