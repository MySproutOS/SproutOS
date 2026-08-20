import { describe, expect, it } from "vitest"
import { type BuildSpec, buildJob, buildJobName, imageUri } from "./build"

const spec: BuildSpec = {
  deploymentId: "01a01e12-1700-76ac-9713-dd208babdf5a",
  gitSha: "a".repeat(40),
  repositoryUrl: "https://github.com/acme/myapp.git",
  registry: "123.dkr.ecr.us-east-1.amazonaws.com",
  imageRepository: "acme/myapp",
}

describe("imageUri", () => {
  it("tags the image with the commit, never a moving tag", () => {
    // A deployment records the exact image it ran. A moving tag makes that record a lie the first
    // time anything is rebuilt — which is exactly when someone is trying to work out what changed.
    expect(imageUri(spec)).toBe(`123.dkr.ecr.us-east-1.amazonaws.com/acme/myapp:${"a".repeat(40)}`)
    expect(imageUri(spec)).not.toContain("latest")
  })
})

describe("buildJob", () => {
  it("addresses the same Job on a retry rather than starting a second build", () => {
    // Named from the deployment, so a retried handler applies over the existing Job instead of
    // paying for the same build twice.
    expect(buildJobName(spec.deploymentId)).toBe(`build-${spec.deploymentId}`)
    expect(buildJob(spec, "sproutos-builds").metadata.name).toBe(buildJobName(spec.deploymentId))
  })

  it("does not retry the build itself", () => {
    // A build that failed fails the same way again, and each attempt is minutes of billed compute.
    // Retrying belongs at the job layer, where there is a policy about how often.
    expect((buildJob(spec, "sproutos-builds").spec as { backoffLimit: number }).backoffLimit).toBe(
      0,
    )
  })

  it("bounds how long a build may run", () => {
    // A build that never finishes bills for as long as it does not finish.
    const deadline = (buildJob(spec, "sproutos-builds").spec as { activeDeadlineSeconds: number })
      .activeDeadlineSeconds

    expect(deadline).toBeGreaterThan(0)
    expect(deadline).toBeLessThanOrEqual(3600)
  })

  it("pins the build to the commit, not the branch", () => {
    // `#<sha>` rather than a ref: a build that resolved a branch itself would produce an image for
    // a commit nobody asked for, and the deployment row would name the wrong one.
    const args = argsOf(buildJob(spec, "sproutos-builds"))

    expect(args.some((arg) => arg === `--opt=context=${spec.repositoryUrl}#${spec.gitSha}`)).toBe(
      true,
    )
  })

  it("does not mark a registry insecure unless asked", () => {
    // `registry.insecure=true` disables TLS verification on the push. It exists for a local test
    // registry; reaching production with it set would push credentials over plaintext.
    expect(argsOf(buildJob(spec, "sproutos-builds")).join(" ")).not.toContain("registry.insecure")
    expect(
      argsOf(buildJob({ ...spec, insecureRegistry: true }, "sproutos-builds")).join(" "),
    ).toContain("registry.insecure=true")
  })

  it("runs as a non-root user", () => {
    const context = containerOf(buildJob(spec, "sproutos-builds")).securityContext

    expect(context.runAsUser).toBe(1000)
  })

  it("carries the deployment id on the pod, not only the Job", () => {
    // The handler finds the build's pod by label to read its logs. A label on the Job alone is not
    // inherited in a form a pod selector can use.
    const job = buildJob(spec, "sproutos-builds").spec as {
      template: { metadata: { labels: Record<string, string> } }
    }

    expect(job.template.metadata.labels["sproutos.dev/deployment"]).toBe(spec.deploymentId)
  })
})

type Container = {
  args: string[]
  securityContext: { runAsUser: number }
}

function containerOf(job: ReturnType<typeof buildJob>): Container {
  const spec = job.spec as { template: { spec: { containers: Container[] } } }
  return spec.template.spec.containers[0]
}

function argsOf(job: ReturnType<typeof buildJob>): string[] {
  return containerOf(job).args
}
