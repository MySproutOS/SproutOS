import { describe, expect, it } from "vitest"
import { VALKEY_ACL_POLICY, valkeyAclSetUserArgs } from "./valkey-acl-policy"

const identity = {
  id: "00000000-0000-0000-0000-000000000001",
  organizationId: "00000000-0000-0000-0000-000000000000",
}

describe("the shared Valkey ACL policy", () => {
  it("restores only the Celery script-load subcommand after denying SCRIPT", () => {
    const args = valkeyAclSetUserArgs(identity, "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr")
    const deny = args.indexOf("-SCRIPT")
    const load = args.indexOf("+SCRIPT|LOAD")

    expect(VALKEY_ACL_POLICY.version).toBe("valkey-acl-v2")
    expect(deny).toBeGreaterThan(-1)
    expect(load).toBeGreaterThan(deny)
    expect(args).not.toContain("+SCRIPT")
    expect(VALKEY_ACL_POLICY.forwardedSubcommands).toEqual(["SCRIPT|LOAD"])
  })
})
