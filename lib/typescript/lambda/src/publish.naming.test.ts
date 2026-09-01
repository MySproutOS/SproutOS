import { describe, expect, it } from "vitest"
import { lambdaAliasArn } from "./publish"

describe("lambdaAliasArn", () => {
  it("builds a live alias ARN from validated components", () => {
    expect(
      lambdaAliasArn({
        region: "us-east-1",
        accountId: "000000000000",
        projectId: "01a05b27-2432-77c8-962e-733b49fbe7d9",
      }),
    ).toBe(
      "arn:aws:lambda:us-east-1:000000000000:function:sproutos-app-01a05b27-2432-77c8-962e-733b49fbe7d9:live",
    )
  })

  it("refuses to publish a malformed ARN when the account ID is absent", () => {
    expect(() =>
      lambdaAliasArn({ region: "us-east-1", accountId: "", projectId: "project-id" }),
    ).toThrow("AWS account ID must contain exactly 12 digits")
  })
})
