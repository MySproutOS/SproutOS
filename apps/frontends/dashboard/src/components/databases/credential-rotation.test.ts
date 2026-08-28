import { describe, expect, it } from "vitest"
import { credentialRotationGuidance } from "./credential-rotation"

const ID = "01a04800-0000-7000-8000-000000001149"

describe("database credential rotation guidance", () => {
  it("warns that an active rotation replaces the current credential and reveals it once", () => {
    expect(credentialRotationGuidance({ id: ID, status: "active" })).toEqual({
      canRotate: true,
      tooltipId: `rotate-credential-${ID}-description`,
      tooltipCopy:
        "Replace the current password and show a new connection URI once. The current URI stops working immediately.",
    })
  })

  it("explains why a database that is not active cannot be rotated", () => {
    expect(credentialRotationGuidance({ id: ID, status: "provisioning" })).toEqual({
      canRotate: false,
      tooltipId: `rotate-credential-${ID}-description`,
      tooltipCopy: "Credentials can be rotated after this database becomes active.",
    })
  })
})
