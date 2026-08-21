import { describe, expect, it } from "vitest"
import { shouldRecreate, waitForAbsence } from "./build"

/**
 * A build that failed could never be retried.
 *
 * The Job is named from the deployment so a handler resuming mid-build addresses the same Job
 * rather than paying for the build twice. That is right while it is running. Once it has finished,
 * `spec.template` is immutable and the API server refuses the apply outright:
 *
 *     Job.batch "build-<id>" is invalid: spec.template: Invalid value: …
 *
 * So the queue tried five times, every attempt was rejected before a pod existed, and the
 * deployment dead-lettered under `Build failed` — a message about a build that had not been
 * attempted. Observed on the live cluster after a genuine first failure.
 *
 * The three states are asserted separately because the wrong answer for each is a different bug:
 * deleting a *running* Job throws away a build in progress, and deleting an *absent* one is a
 * pointless round trip that also masks a real 404.
 */
describe("shouldRecreate", () => {
  it("replaces a Job that has finished, because its template cannot be changed", () => {
    expect(shouldRecreate({ status: { failed: 1 } })).toBe(true)
    expect(shouldRecreate({ status: { succeeded: 1 } })).toBe(true)
  })

  it("leaves a running Job alone, which is why the name is derived from the deployment", () => {
    expect(shouldRecreate({ status: { active: 1 } })).toBe(false)
  })

  it("does not try to delete a Job that is not there", () => {
    expect(shouldRecreate(undefined)).toBe(false)
    expect(shouldRecreate({})).toBe(false)
    expect(shouldRecreate({ status: {} })).toBe(false)
  })
})

describe("waitForAbsence", () => {
  it("returns once the name is free", async () => {
    let remaining = 2
    const kube = {
      get: <T>() => {
        remaining -= 1
        return Promise.resolve((remaining > 0 ? { status: {} } : undefined) as T | undefined)
      },
    }

    await waitForAbsence(kube, "/apis/batch/v1/namespaces/b/jobs/x")
    expect(remaining).toBe(0)
  })

  it("gives up rather than looping forever", async () => {
    // A Job that will not go away is a cluster problem, and the apply that follows says so in the
    // cluster's own words. Blocking here instead would hold the job's lease until it expired.
    const kube = { get: <T>() => Promise.resolve({ status: {} } as T) }

    await expect(
      waitForAbsence(kube, "/apis/batch/v1/namespaces/b/jobs/x", AbortSignal.timeout(50)),
    ).resolves.toBeUndefined()
  }, 40_000)
})

describe("revisionKey", () => {
  it("lets a rebuilt image deploy, where the deployment id alone would not", async () => {
    const { revisionKey } = await import("./build")
    const { DEPLOY_KINDS } = await import("./deploy")

    /*
      A deployment whose first build failed has already had a `deploy.revision` job — enqueued by
      provisioning and completed against no image. Keyed on the deployment alone, the later
      successful build's enqueue collides with it and does nothing: the image is built, pushed, and
      never deployed, with every job in the chain reporting success. Observed exactly that way —
      `deploy.build succeeded`, `image_uri` set, no revision, no URL.
    */
    const deploymentId = "01a024ca-37d9-748c-8f6e-cf384fc24151"
    const firstDeploy = `${DEPLOY_KINDS.revision}:${deploymentId}`

    expect(revisionKey(deploymentId, "registry/app:abc")).not.toBe(firstDeploy)

    // And a retry of the same build still collides, which is the property the key exists for: the
    // image is named for the commit, so retrying produces the same tag.
    expect(revisionKey(deploymentId, "registry/app:abc")).toBe(
      revisionKey(deploymentId, "registry/app:abc"),
    )
    expect(revisionKey(deploymentId, "registry/app:def")).not.toBe(
      revisionKey(deploymentId, "registry/app:abc"),
    )
  })
})
