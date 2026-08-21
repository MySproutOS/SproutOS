import { describe, expect, it } from "vitest"
import { DEFAULT_TIMEOUT_S, sandboxJob } from "./spec"

const ORGANIZATION = "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f"
const PROJECT = "01912d40-0000-7000-8000-0000000000a1"

const base = {
  namespace: "tenant-acme",
  organizationId: ORGANIZATION,
  projectId: PROJECT,
  name: "sandbox-abc",
  image: "alpine:3",
  command: ["echo", "hi"],
}

/** The container spec, which is where every property under test lives. */
function container(job: Record<string, unknown>) {
  const spec = job.spec as { template: { spec: Record<string, unknown> } }
  return {
    pod: spec.template.spec,
    work: (spec.template.spec.containers as Record<string, unknown>[])[0],
  }
}

/*
  Each of these is a security property rather than a preference, so each is asserted individually
  and named for what it prevents. A sandbox runs code a customer wrote; the reason it is safe to do
  that at all is this list.
*/
describe("the sandbox pod", () => {
  it("runs in the tenant's namespace, where the NetworkPolicy is", () => {
    // This is the boundary that does not depend on a hypervisor: `deploy/tenant/network-policy.yaml`
    // denies by default and excludes 10/8, 172.16/12, 192.168/16 and 169.254/16 from egress.
    // Without the right namespace, none of it applies.
    const job = sandboxJob(base) as { metadata: { namespace: string } }
    expect(job.metadata.namespace).toBe("tenant-acme")
  })

  /*
    Attribution, on the pod template rather than the Job.

    The metering agent reads labels off pods. A Job's own labels are invisible to it, and this
    template carried `sproutos.dev/sandbox` and nothing else — so every workflow node the platform
    ever ran was billed to nobody. There is no error state for that: the sample is valid, the batch
    is well-formed, and the invoice is empty.
  */
  it("labels the pod with who pays for it", () => {
    const spec = sandboxJob(base).spec as {
      template: { metadata: { labels: Record<string, string> } }
    }
    expect(spec.template.metadata.labels).toMatchObject({
      "sproutos.dev/organization-id": ORGANIZATION,
      "sproutos.dev/project-id": PROJECT,
    })
  })

  it("omits the project label for a standalone service, which has no project", () => {
    const { projectId: _projectId, ...standalone } = base
    const spec = sandboxJob(standalone).spec as {
      template: { metadata: { labels: Record<string, string> } }
    }
    expect(spec.template.metadata.labels).toHaveProperty("sproutos.dev/organization-id")
    expect(spec.template.metadata.labels).not.toHaveProperty("sproutos.dev/project-id")
  })

  it("carries no service-account token", () => {
    // The default projects one into every pod. A token is a credential for the API server, which is
    // the most valuable thing in the cluster to hand to code a customer wrote.
    expect(container(sandboxJob(base)).pod.automountServiceAccountToken).toBe(false)
  })

  it("runs as nobody, with no capabilities and a read-only root", () => {
    const { work } = container(sandboxJob(base))
    expect(work.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 65534,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    })
  })

  it("limits CPU as well as memory", () => {
    // Unlike the platform's own workloads, which are trusted to behave. An unbounded CPU limit on
    // untrusted code is a free miner on a node somebody else is also using.
    const { work } = container(sandboxJob(base))
    expect((work.resources as { limits: Record<string, string> }).limits.cpu).toBeDefined()
    expect((work.resources as { limits: Record<string, string> }).limits.memory).toBeDefined()
  })

  it("never retries, so a failing run is billed once", () => {
    expect((sandboxJob(base) as { spec: { backoffLimit: number } }).spec.backoffLimit).toBe(0)
  })

  it("carries a deadline Kubernetes enforces, not one a caller has to remember", () => {
    const job = sandboxJob(base) as { spec: { activeDeadlineSeconds: number } }
    expect(job.spec.activeDeadlineSeconds).toBe(DEFAULT_TIMEOUT_S)
    const custom = sandboxJob({ ...base, timeoutSeconds: 5 }) as {
      spec: { activeDeadlineSeconds: number }
    }
    expect(custom.spec.activeDeadlineSeconds).toBe(5)
  })

  /*
    The VM boundary is optional, and its absence must not silently become "no runtime class field,
    therefore fine". A cluster with no bare-metal pool has no Kata runtime class; the pod is then a
    namespace and a NetworkPolicy, which is a real reduction and a deliberate one.
  */
  it("omits runtimeClassName when there is none, and names it when there is", () => {
    expect(container(sandboxJob(base)).pod.runtimeClassName).toBeUndefined()
    expect(
      container(sandboxJob({ ...base, runtimeClassName: "kata-fc" })).pod.runtimeClassName,
    ).toBe("kata-fc")
  })

  it("passes the command through without a shell", () => {
    // `command`, not `args`, and an array rather than a string: nothing here is parsed by a shell,
    // so nothing a customer put in an argument can become a second command.
    expect(container(sandboxJob(base)).work.command).toEqual(["echo", "hi"])
  })
})
