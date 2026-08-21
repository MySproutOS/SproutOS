import { describe, expect, it } from "vitest"
import { assertFetchableUrl, sandboxName } from "./sandbox-node"

/*
  A scheme check on top of the NetworkPolicy, not instead of it.

  The policy is the real control and it is a runtime object: somebody can delete it, and a CNI can
  decline to enforce it — `kind`'s default one ignores NetworkPolicy entirely, which is how an
  earlier finding in this repo came about. A scheme check costs nothing and does not depend on the
  cluster being configured the way we think it is.
*/
describe("assertFetchableUrl", () => {
  it("allows the two schemes an HTTP node is for", () => {
    expect(assertFetchableUrl("https://example.com/hook")).toBe("https://example.com/hook")
    expect(assertFetchableUrl("http://example.com/hook")).toBe("http://example.com/hook")
  })

  it("refuses file:, which turns a fetch into a read of the container", () => {
    expect(() => assertFetchableUrl("file:///etc/passwd")).toThrow(/file:/)
  })

  it("refuses every other scheme rather than listing the dangerous ones", () => {
    // A denylist is a list somebody has to keep complete. `gopher:` and `dict:` are the classic
    // SSRF smuggling schemes and neither has to be named here for this to refuse them.
    // Collected rather than asserted one at a time: vitest's matcher takes a single argument, so a
    // per-URL label is not available and a failure should still name the scheme that got through.
    const accepted = ["gopher://x/", "dict://x/", "ftp://x/", "jar:http://x!/"].filter((url) => {
      try {
        assertFetchableUrl(url)
        return true
      } catch {
        return false
      }
    })
    expect(accepted).toEqual([])
  })

  it("refuses what is not a URL at all, including the empty string", () => {
    expect(() => assertFetchableUrl("")).toThrow(/needs a url/)
    expect(() => assertFetchableUrl(undefined)).toThrow(/needs a url/)
    expect(() => assertFetchableUrl("not a url")).toThrow(/not a URL/)
  })
})

describe("sandboxName", () => {
  const runId = "01a02274-7007-7177-a2e5-4c4393435ef7"

  it("stays inside Kubernetes's 63-character limit", () => {
    // Past it the API server rejects the Job, and the node fails for a reason that has nothing to
    // do with the node.
    expect(sandboxName(runId, "a".repeat(200)).length).toBeLessThanOrEqual(63)
  })

  it("is a valid DNS label", () => {
    const label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
    const bad = ["Post Digest", "node_1", "UPPER", "a".repeat(40), "-leading"].filter(
      (nodeId) => !label.test(sandboxName(runId, nodeId)),
    )
    expect(bad).toEqual([])
  })

  it("distinguishes two nodes in one run, and one node across two runs", () => {
    const other = "01a02275-0000-7000-8000-000000000000"
    expect(sandboxName(runId, "a")).not.toBe(sandboxName(runId, "b"))
    expect(sandboxName(runId, "a")).not.toBe(sandboxName(other, "a"))
  })
})
