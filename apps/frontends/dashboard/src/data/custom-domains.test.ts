import { describe, expect, it } from "vitest"
import {
  CUSTOM_DOMAIN_POLL_INTERVAL_MS,
  customDomainMutationErrorMessage,
  customDomainNeedsPolling,
  eligibleCustomDomainProjects,
  servingCustomDomains,
  shouldPollCustomDomains,
} from "./custom-domains"
import type { Project } from "./projects"

describe("custom-domain polling", () => {
  it.each(["pending_dns", "issuing", "propagating", "renewal_warning", "deleting"] as const)(
    "keeps %s fresh while reconciliation is unfinished",
    (status) => {
      expect(customDomainNeedsPolling(status)).toBe(true)
    },
  )

  it.each(["active", "failed"] as const)("does not poll terminal status %s", (status) => {
    expect(customDomainNeedsPolling(status)).toBe(false)
  })

  it("polls every minute only for a visible list containing unfinished work", () => {
    const unfinished = [{ status: "active" as const }, { status: "issuing" as const }]

    expect(shouldPollCustomDomains(unfinished, "visible")).toBe(true)
    expect(shouldPollCustomDomains(unfinished, "hidden")).toBe(false)
    expect(shouldPollCustomDomains([{ status: "active" }], "visible")).toBe(false)
    expect(shouldPollCustomDomains(undefined, "visible")).toBe(false)
    expect(CUSTOM_DOMAIN_POLL_INTERVAL_MS).toBe(60_000)
  })
})

describe("eligibleCustomDomainProjects", () => {
  const project = (servingMode: Project["servingMode"], live = true): Project => ({
    id: `${servingMode ?? "unset"}-${live}`,
    name: "Project",
    glyph: "P",
    repo: "acme/project",
    repoUrl: "https://github.com/acme/project",
    status: "ready",
    kind: "site",
    costMicros: 0n,
    updatedLabel: "now",
    region: "us-east-1",
    hasUpstreamUpdate: false,
    isGroup: false,
    servingMode,
    parentProjectId: null,
    managedByOauthApp: null,
    url: null,
    hostname: null,
    primaryChildProjectId: null,
    primaryUrl: null,
    primaryHostname: null,
    liveDeploymentId: live ? "01900000-0000-7000-8000-000000000001" : null,
  })

  it("offers only deployed serverless projects", () => {
    const serverless = project("serverless")
    expect(
      eligibleCustomDomainProjects([
        serverless,
        project("static"),
        project(null),
        project("serverless", false),
      ]),
    ).toEqual([serverless])
  })
})

describe("servingCustomDomains", () => {
  it("returns active and renewal-warning domains in API order", () => {
    const domains = [
      { hostname: "old.example", status: "active" },
      { hostname: "pending.example", status: "pending_dns" },
      { hostname: "primary.example", status: "renewal_warning" },
    ] as const

    expect(servingCustomDomains(domains).map((domain) => domain.hostname)).toEqual([
      "old.example",
      "primary.example",
    ])
  })
})

describe("customDomainMutationErrorMessage", () => {
  it("surfaces the rollout-disabled reason from the current API response", () => {
    expect(
      customDomainMutationErrorMessage({
        message:
          "Custom domains remain disabled until the Rust tenant edge passes production smoke.",
      }),
    ).toBe("Custom domains remain disabled until the Rust tenant edge passes production smoke.")
  })

  it("supports the standard API error envelope and a deterministic fallback", () => {
    expect(
      customDomainMutationErrorMessage({
        error: { code: "ServiceUnavailable", message: "Certificate worker is unavailable." },
      }),
    ).toBe("Certificate worker is unavailable.")
    expect(customDomainMutationErrorMessage(undefined)).toBe(
      "The custom-domain request failed. Try again.",
    )
  })
})
