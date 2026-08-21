import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "@lib/deploy"
import { parseAllDocuments } from "yaml"
import { describe, expect, it, vi } from "vitest"
import {
  ensureTenantNamespace,
  namespacePath,
  networkPolicyPath,
  tenantNamespaceObject,
  tenantNetworkPolicies,
} from "./tenant-namespace"

const NAMESPACE = "tenant-01991000000070008000000000000002"

/**
 * The manifest, rendered for the same namespace the code is asked for.
 *
 * Read from the repository rather than duplicated here. A copy of the YAML inside the test would
 * make the test pass while the real manifest drifted, which is the failure this whole file exists
 * to prevent.
 */
function manifestPolicies(): unknown[] {
  const path = join(import.meta.dirname, "../../../../deploy/tenant/network-policy.yaml")
  const rendered = render(readFileSync(path, "utf8"), { TENANT_NAMESPACE: NAMESPACE })
  return parseAllDocuments(rendered)
    .map((document) => document.toJS() as unknown)
    .filter((document) => document !== null)
}

describe("the tenant namespace and its policies", () => {
  /*
    The seam this asserts.

    `deploy/tenant/network-policy.yaml` is what a person reads to learn what isolation a tenant has,
    and `tenantNetworkPolicies` is what actually gets applied. Two definitions of one security
    boundary is the same shape as an SRN grammar in two languages, and it gets the same treatment:
    one is asserted against the other, so a change to either fails here rather than silently
    weakening a namespace nobody re-reads.
  */
  it("applies exactly what the manifest describes", () => {
    expect(tenantNetworkPolicies(NAMESPACE)).toEqual(manifestPolicies())
  })

  it("names the namespace the caller asked for, on every object", () => {
    for (const policy of tenantNetworkPolicies(NAMESPACE)) {
      expect(policy.metadata.namespace).toBe(NAMESPACE)
    }
    expect(tenantNamespaceObject(NAMESPACE).metadata.name).toBe(NAMESPACE)
  })

  /*
    Order, because a partial apply must fail closed.

    If `allow-egress` landed and `default-deny` did not, the namespace would permit everything —
    a NetworkPolicy only restricts pods that some policy selects for that direction. Denying first
    means an interrupted apply leaves a tenant broken rather than open.
  */
  it("denies before it allows", () => {
    expect(tenantNetworkPolicies(NAMESPACE)[0]?.metadata.name).toBe("default-deny")
  })

  it("excludes link-local from tenant egress, which is where instance metadata lives", () => {
    const egress = tenantNetworkPolicies(NAMESPACE).find((p) => p.metadata.name === "allow-egress")
    expect(JSON.stringify(egress)).toContain("169.254.0.0/16")
  })

  it("applies the namespace and all three policies, in order", async () => {
    const apply = vi.fn<(path: string, object: unknown) => Promise<undefined>>(() =>
      Promise.resolve(undefined),
    )
    await ensureTenantNamespace({ apply } as never, NAMESPACE)

    expect(apply.mock.calls.map(([path]) => path)).toEqual([
      namespacePath(NAMESPACE),
      networkPolicyPath(NAMESPACE, "default-deny"),
      networkPolicyPath(NAMESPACE, "allow-ingress-from-gateway"),
      networkPolicyPath(NAMESPACE, "allow-egress"),
    ])
  })

  /*
    Not "create if missing".

    A namespace that exists is not evidence that it is fenced — it may have been made by an earlier
    version of this code, or by a person at a terminal, or had its policies deleted since. Applying
    every time is what makes the policies true now rather than true once.
  */
  it("re-applies the policies even when the namespace already exists", async () => {
    const apply = vi.fn<(path: string, object: unknown) => Promise<undefined>>(() =>
      Promise.resolve(undefined),
    )
    await ensureTenantNamespace({ apply } as never, NAMESPACE)
    await ensureTenantNamespace({ apply } as never, NAMESPACE)
    expect(apply).toHaveBeenCalledTimes(8)
  })
})
