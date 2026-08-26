import { describe, expect, it } from "vitest"

import {
  DEFAULT_HANDLER,
  DEFAULT_RUNTIME,
  isSupportedRuntime,
  SUPPORTED_RUNTIMES,
} from "@lib/lambda"

/**
 * What `/deploy/migrate` guarantees, tested where it can be tested without AWS.
 *
 * The route itself invokes Lambda, so an end-to-end test here would assert against a mock of the
 * thing under test. What is worth pinning is the boundary: which runtimes the route will accept,
 * and that its fallbacks are the same ones a release uses — a migrator that silently ran on a
 * different runtime from the application it migrates for is a bad afternoon.
 */
describe("the migrate route's runtime boundary", () => {
  it("accepts exactly the runtimes a release accepts", () => {
    // One allowlist, not two. If these ever diverge, a project could deploy on a runtime its own
    // migrator is refused on, which is a failure with no sensible message.
    for (const runtime of SUPPORTED_RUNTIMES) {
      expect(isSupportedRuntime(runtime)).toBe(true)
    }
    expect(isSupportedRuntime("nodejs22")).toBe(false)
    expect(isSupportedRuntime("")).toBe(false)
  })

  it("falls back to the platform defaults, which are the release's defaults", () => {
    // Named rather than inlined: the migrator and the application must agree about what "no
    // runtime specified" means, and the only way to guarantee that is one constant.
    expect(SUPPORTED_RUNTIMES).toContain(DEFAULT_RUNTIME)
    expect(DEFAULT_HANDLER).toBe("index.handler")
  })
})
