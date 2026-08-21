import { describe, expect, it } from "vitest"
import { CONTROL_PLANE_DISALLOWED_TOOLS, disallowedTools } from "./tools"

/*
  The list is a security control, so it is asserted rather than assumed.

  An agent turn runs in the `internal-api` pod today, which holds the control-plane database URL,
  the envelope KMS key, the GitHub App credentials, AWS access keys and a projected Kubernetes
  service-account token. `agentSubprocessEnv` keeps those out of the subprocess's *environment* and
  cannot keep them out of `/proc/1/environ`, because the subprocess runs as the same uid.

  Each entry is named individually so that removing one fails a test that says what it costs,
  rather than passing because a category still looks non-empty.
*/
describe("control-plane tool restrictions", () => {
  it("refuses the shell, which is the whole exploit", () => {
    expect(CONTROL_PLANE_DISALLOWED_TOOLS).toContain("Bash")
    expect(CONTROL_PLANE_DISALLOWED_TOOLS).toContain("BashOutput")
    expect(CONTROL_PLANE_DISALLOWED_TOOLS).toContain("KillShell")
  })

  it("refuses a model-chosen URL fetched from inside the VPC", () => {
    expect(CONTROL_PLANE_DISALLOWED_TOOLS).toContain("WebFetch")
  })

  it("refuses subagents, which would inherit this process without inheriting this list", () => {
    expect(CONTROL_PLANE_DISALLOWED_TOOLS).toContain("Task")
  })

  it("leaves the workspace tools alone — they are what the product is for", () => {
    for (const tool of ["Read", "Write", "Edit", "Glob", "Grep"]) {
      expect(CONTROL_PLANE_DISALLOWED_TOOLS).not.toContain(tool)
    }
  })

  it("hands the SDK a mutable copy, not the frozen tuple", () => {
    const list = disallowedTools()
    list.push("Sentinel")
    expect(CONTROL_PLANE_DISALLOWED_TOOLS).not.toContain("Sentinel")
  })
})
