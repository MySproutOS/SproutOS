import { describe, expect, it } from "vitest"
import { type DeploymentSpec, hostLabel, knativeService, type ProjectSpec } from "./knative"

const project: ProjectSpec = {
  id: "01a01e12-1700-76ac-9713-dd208babdf5a",
  slug: "myapp",
  organizationId: "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
}

const production: DeploymentSpec = {
  kind: "production",
  imageUri: "123.dkr.ecr.us-east-1.amazonaws.com/tenant/myapp:abc123",
  runtimeClass: "kata-fc",
  scaleMode: "cold",
  containerConcurrency: 20,
  memoryMb: 1024,
  maxDurationS: 300,
}

describe("hostLabel", () => {
  it("is one DNS label, so a single wildcard certificate covers it", () => {
    // The whole reason the domain template drops the namespace. A dot here means every tenant
    // hostname needs its own certificate.
    expect(hostLabel(project, production)).not.toContain(".")
  })

  it("distinguishes two projects that share a slug", () => {
    // `project.slug` is unique per organization, not globally. Without this, the second
    // organization to deploy a project called `myapp` takes over the first one's hostname.
    const other: ProjectSpec = {
      id: "01a01e12-1700-76ac-9713-dd208bab0000",
      slug: "myapp",
      organizationId: "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
    }

    expect(hostLabel(project, production)).not.toBe(hostLabel(other, production))
  })

  it("keeps the pr-N-- prefix on previews", () => {
    const preview: DeploymentSpec = { ...production, kind: "preview", prNumber: 42 }

    expect(hostLabel(project, preview)).toMatch(/^pr-42--myapp-/)
  })

  it("does not treat a preview with no PR number as a preview", () => {
    // A `pr-null--` host would be a real hostname pointing at a real deployment.
    const malformed: DeploymentSpec = { ...production, kind: "preview", prNumber: null }

    expect(hostLabel(project, malformed)).not.toContain("pr-")
  })

  it("stays within the 63-character DNS label limit", () => {
    const long: ProjectSpec = { ...project, slug: "a".repeat(80) }
    const preview: DeploymentSpec = { ...production, kind: "preview", prNumber: 123456 }

    expect(hostLabel(long, preview).length).toBeLessThanOrEqual(63)
  })

  it("truncates the slug rather than the discriminator", () => {
    // Trimming from the end would eat the discriminator and silently reintroduce the collision the
    // discriminator exists to prevent.
    const long: ProjectSpec = { ...project, slug: "a".repeat(80) }
    const label = hostLabel(long, production)
    const discriminator = project.id.replaceAll("-", "").slice(-6)

    expect(label.endsWith(`-${discriminator}`)).toBe(true)
  })

  it("does not leave a trailing dash where the slug was cut", () => {
    // `my-app-` + `-abc123` would be `my-app--abc123`, which reads as a Knative tag separator.
    const awkward: ProjectSpec = { ...project, slug: `${"a".repeat(54)}-b` }

    expect(hostLabel(awkward, production)).not.toContain("--")
  })
})

describe("knativeService", () => {
  it("carries the runtime class from the row", () => {
    // Not hardcoded: `kata-clh` is required for anything needing a live filesystem, and choosing
    // it here would silently override the caller.
    const clh: DeploymentSpec = { ...production, runtimeClass: "kata-clh" }
    const service = knativeService(project, clh, "tenant-x")

    expect(service.spec.template.spec.runtimeClassName).toBe("kata-clh")
  })

  it("requests as much memory as it limits", () => {
    // A burstable tenant pod spends headroom the platform sold to somebody else.
    const service = knativeService(project, production, "tenant-x")
    const resources = service.spec.template.spec.containers[0].resources

    expect(resources.requests.memory).toBe(resources.limits.memory)
    expect(resources.limits.memory).toBe("1024Mi")
  })

  it("does not demand runAsNonRoot", () => {
    // Tenant namespaces are `baseline` precisely because customer images routinely run as root.
    // Requiring it here would reject images the platform has promised to run.
    //
    // Asserted on the keys rather than the value: `KnativeService` does not declare the field, so
    // reading it is a compile error — which is the stronger guarantee, and this keeps the reason
    // written down where someone adding it would look.
    const service = knativeService(project, production, "tenant-x")
    const context = service.spec.template.spec.containers[0]?.securityContext

    expect(Object.keys(context ?? {})).not.toContain("runAsNonRoot")
  })

  it("names the service after the host label", () => {
    // The service name *is* the hostname under this domain template. If these two ever disagree,
    // the URL recorded against the deployment points at nothing.
    const service = knativeService(project, production, "tenant-x")

    expect(service.metadata.name).toBe(hostLabel(project, production))
  })
})

describe("the runtime class", () => {
  /*
    `sandbox.runtime_class` needed this correction twice; `deployment.runtime_class` is the sibling
    column and was left behind, defaulting to `kata-fc`.

    On a managed cluster that is not a preference, it is a claim. The `kata-fc` RuntimeClass carries
    `nodeSelector: katacontainers.io/kata-runtime=true` in its `scheduling` block, Kubernetes merges
    that into every pod naming the class, and no GKE Sandbox node has that label — so every tenant
    revision failed with `didn't match Pod's node affinity/selector`, a message that mentions no
    runtime class at all, for a pod nobody asked to be a VM.
  */
  function specOf(runtimeClass: string | null) {
    const service = knativeService(project, { ...production, runtimeClass }, "tenant-x")
    return (
      service.spec as {
        template: {
          spec: {
            runtimeClassName?: string
            tolerations?: { key: string; value: string }[]
          }
        }
      }
    ).template.spec
  }

  it("omits the field entirely when there is none, rather than sending null", () => {
    // `runtimeClassName: null` is not "no runtime class" — it is a field the API server rejects.
    expect(specOf(null)).not.toHaveProperty("runtimeClassName")
  })

  it("names the class when the cluster has one", () => {
    expect(specOf("gvisor").runtimeClassName).toBe("gvisor")
  })

  it("tolerates the GKE Sandbox taint either way", () => {
    // A pod naming `gvisor` without this stays Pending, with a taint rather than capacity as the
    // reason and nothing saying so. Unconditional because a toleration for a taint no node carries
    // does nothing, and a conditional would be a second place for the two to disagree.
    for (const runtimeClass of [null, "gvisor"]) {
      expect(specOf(runtimeClass).tolerations).toContainEqual({
        key: "sandbox.gke.io/runtime",
        operator: "Equal",
        value: "gvisor",
        effect: "NoSchedule",
      })
    }
  })
})

describe("scale modes", () => {
  /*
    Two options, and the difference is what they cost when nothing is happening. ADR 0024.

    Vercel's Fluid keeps one instance too, and theirs is *paused* between requests — "no CPU or
    memory charges apply until the next invocation." What that pause is has never been published.
    Knative has no retained-but-paused revision, so a kept instance here is a running one.
  */
  function annotationsFor(scaleMode: "cold" | "warm") {
    const service = knativeService(project, { ...production, scaleMode }, "tenant-x")
    return (service.spec as { template: { metadata: { annotations: Record<string, string> } } })
      .template.metadata.annotations
  }

  it("scales to zero when cold, so idle reserves nothing", () => {
    expect(annotationsFor("cold")["autoscaling.knative.dev/min-scale"]).toBe("0")
  })

  it("keeps one when warm, so no request waits for a container to start", () => {
    expect(annotationsFor("warm")["autoscaling.knative.dev/min-scale"]).toBe("1")
  })

  it("holds a cold instance for a few minutes after the last request", () => {
    // Knative's default tears it down as soon as the stable window closes, so a second visitor
    // thirty seconds behind the first pays a full cold start — and bursty traffic is the normal
    // shape for a small site.
    expect(annotationsFor("cold")["autoscaling.knative.dev/scale-down-delay"]).toBe("5m")
  })

  it("does not delay scale-down on a warm revision, where there is nothing to delay", () => {
    expect(annotationsFor("warm")).not.toHaveProperty("autoscaling.knative.dev/scale-down-delay")
  })
})

describe("the environment", () => {
  /*
    `project_env_var` was written, sealed, listed, revealed and counted, and never delivered: this
    renderer had no `env` of any kind, so every variable a customer set reached nothing. The backlog
    item was marked done because the table existed.
  */
  function containerOf(envSecretName: string | null) {
    const service = knativeService(project, { ...production, envSecretName }, "tenant-x")
    return service.spec.template.spec.containers[0]
  }

  it("references the environment Secret when there is one", () => {
    expect(containerOf("env-abcdef-0123456789ab").envFrom).toEqual([
      { secretRef: { name: "env-abcdef-0123456789ab" } },
    ])
  })

  it("omits the field entirely when there is none", () => {
    // Not `[]`. Knative validates the field, and an empty `envFrom` is an array the webhook
    // rejects rather than "no environment".
    expect(containerOf(null)).not.toHaveProperty("envFrom")
  })

  it("omits it when the caller says nothing at all", () => {
    // The field is optional, and a project with no variables is the common case.
    const service = knativeService(project, production, "tenant-x")

    expect(service.spec.template.spec.containers[0]).not.toHaveProperty("envFrom")
  })
})
