import { generateSpecs } from "hono-typebox-openapi"
import { Hono } from "hono"
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { validator } from "./utils/validator"

/**
 * The spec has to describe the bodies the API actually accepts.
 *
 * `hono-typebox-openapi` carries a route's request-body schema on a symbol attached to the
 * middleware `validator()` returns, and `utils/validator.ts` composes that middleware with a
 * stricter one — producing a new function, which left the symbol behind. Every route using the
 * wrapper disappeared from `requestBody`: 25 of the API's 28 bodied operations, on the live
 * document, for as long as nobody regenerated the client.
 *
 * Nothing caught it because the committed client was generated before the wrapper existed and kept
 * working. The first regeneration produced `body?: never` on almost every POST, PATCH and PUT, and
 * ten screens stopped compiling at once.
 *
 * The assertion is on the generated document rather than on the wrapper's internals: what matters
 * is not that a symbol survives but that the body appears, and a future change that keeps the
 * symbol and loses the body would pass an internals test.
 */

const Body = Type.Object({
  name: Type.String({ minLength: 1 }),
  count: Type.Optional(Type.Number()),
})

async function specFor(app: Hono): Promise<Record<string, never>> {
  return (await generateSpecs(app, {
    documentation: { info: { title: "t", version: "1" } },
  })) as never
}

function requestBodyOf(spec: Record<string, never>, path: string, method: string): unknown {
  const paths = spec.paths as unknown as Record<string, Record<string, { requestBody?: unknown }>>
  return paths[path]?.[method]?.requestBody
}

describe("the OpenAPI document", () => {
  it("describes the body of a route validated through the strict wrapper", async () => {
    const app = new Hono().post("/things", validator("json", Body), (c) =>
      c.json(c.req.valid("json")),
    )

    const body = requestBodyOf(await specFor(app), "/things", "post") as {
      content?: Record<string, { schema?: { properties?: Record<string, unknown> } }>
    }

    expect(body).toBeDefined()
    expect(Object.keys(body.content?.["application/json"]?.schema?.properties ?? {})).toEqual([
      "name",
      "count",
    ])
  })

  it("describes it identically to the library's own validator", async () => {
    // The wrapper adds a check in front and changes nothing about the contract, so the document it
    // produces must be the document the library would have produced. A difference here is the
    // wrapper quietly redescribing the API.
    const { validator: base } = await import("hono-typebox-openapi/typebox")

    const wrapped = new Hono().post("/things", validator("json", Body), (c) => c.text(""))
    const plain = new Hono().post("/things", base("json", Body), (c) => c.text(""))

    expect(requestBodyOf(await specFor(wrapped), "/things", "post")).toEqual(
      requestBodyOf(await specFor(plain), "/things", "post"),
    )
  })

  it("still describes query parameters, which the wrapper passes straight through", async () => {
    const app = new Hono().get(
      "/things",
      validator("query", Type.Object({ limit: Type.Number() })),
      (c) => c.text(""),
    )

    const spec = await specFor(app)
    const paths = spec.paths as unknown as Record<
      string,
      Record<string, { parameters?: { name: string }[] }>
    >

    expect(paths["/things"]?.get?.parameters?.map((p) => p.name)).toEqual(["limit"])
  })
})
