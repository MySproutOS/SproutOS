import { afterEach, describe, expect, it } from "vitest"
import { sproutPostgresConfigFromEnv } from "./postgres"
import { searchServiceConfigFromEnv } from "./search"
import { ServiceNotConfiguredError } from "./types"
import { valkeyServiceConfigFromEnv } from "./valkey"

/*
  Every database this product sells answered `500 Internal Server Error` with no body.

  The deployment sets none of the `SERVICE_*` variables, so each of these threw a bare `Error`
  naming the one it wanted, the route rethrew it, and the customer got a 500 — which says "we
  broke, try again" about a condition no amount of retrying changes. Nothing in the type
  distinguished "this deployment was never told where its databases live" from "something
  crashed", so nothing could report the first as the operational problem it is.

  The variable name is asserted, not just the type. It is the whole actionable content: the person
  who can fix this is reading a log line, and "postgres is unavailable" sends them to a database
  when the answer is in Parameter Store.
*/
describe("a deployment with no service configuration", () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it.each([
    ["postgres", "SERVICE_POSTGRES_ADMIN_URL", () => sproutPostgresConfigFromEnv({})],
    ["valkey", "SERVICE_VALKEY_PUBLIC_HOST", () => valkeyServiceConfigFromEnv({})],
    ["elasticsearch", "SERVICE_SEARCH_PUBLIC_HOST", () => searchServiceConfigFromEnv({})],
  ])("says which variable %s needs", (_kind, variable, read) => {
    const thrown = (() => {
      try {
        read()
        return undefined
      } catch (error) {
        return error
      }
    })()

    expect(thrown).toBeInstanceOf(ServiceNotConfiguredError)
    expect((thrown as ServiceNotConfiguredError).variable).toBe(variable)
    expect((thrown as ServiceNotConfiguredError).message).toContain(variable)
  })

  /*
    A plain `Error` would still satisfy "it throws". The point of the type is that a caller can tell
    this apart from a genuine fault without matching on prose, which is `docs/findings/0001`.
  */
  it("is distinguishable from an ordinary failure without reading its message", () => {
    const error = new ServiceNotConfiguredError("SERVICE_POSTGRES_ADMIN_URL", "postgres")

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("ServiceNotConfiguredError")
    expect(new Error("SERVICE_POSTGRES_ADMIN_URL is not set")).not.toBeInstanceOf(
      ServiceNotConfiguredError,
    )
  })

  it("requires the Valkey administrator endpoint used for durable ACL revocation", () => {
    expect(() =>
      valkeyServiceConfigFromEnv({ SERVICE_VALKEY_PUBLIC_HOST: "valkey.example.invalid" }),
    ).toThrow(expect.objectContaining({ variable: "SERVICE_VALKEY_ADMIN_URL" }))
  })
})
