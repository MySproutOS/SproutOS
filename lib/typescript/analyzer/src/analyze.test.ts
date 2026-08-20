import { describe, expect, it } from "vitest"
import { extractJson } from "./analyze"
import { InvalidManifestError } from "./manifest"

/**
 * Every input here is a shape a model actually produces when asked for "a single JSON object and
 * nothing else". Failing the run — which the customer paid for — over three backticks would be
 * the wrong trade.
 */
describe("extractJson", () => {
  it("reads a bare object", () => {
    expect(extractJson('{"runtime":"node 22"}')).toEqual({ runtime: "node 22" })
  })

  it("reads a fenced block", () => {
    expect(extractJson('```json\n{"runtime":"node 22"}\n```')).toEqual({ runtime: "node 22" })
    expect(extractJson('```\n{"runtime":"go 1.24"}\n```')).toEqual({ runtime: "go 1.24" })
  })

  it("reads past a sentence of preamble", () => {
    expect(
      extractJson('Here is the analysis:\n\n{"runtime":"python 3.13"}\n\nHope that helps.'),
    ).toEqual({ runtime: "python 3.13" })
  })

  it("keeps nested objects whole", () => {
    // The naive "first { to first }" would truncate this at the inner brace.
    const reply = '{"runtime":"node","envVars":[{"name":"PORT"}],"port":3000}'
    expect(extractJson(reply)).toEqual({
      runtime: "node",
      envVars: [{ name: "PORT" }],
      port: 3000,
    })
  })

  it("says so when there is no JSON at all", () => {
    expect(() => extractJson("I could not read this repository.")).toThrow(InvalidManifestError)
    expect(() => extractJson("")).toThrow(InvalidManifestError)
  })

  it("says so when the JSON is broken rather than throwing a parser error", () => {
    // A truncated reply — the model ran out of output budget mid-object — is the common case.
    expect(() => extractJson('{"runtime":"node 22", "envVars": [')).toThrow(InvalidManifestError)
  })
})
