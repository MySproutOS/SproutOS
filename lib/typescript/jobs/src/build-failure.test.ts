import { describe, expect, it } from "vitest"
import { buildFailureReason } from "./build"

/**
 * A build that failed has to say why, and the ways it fails are not all the same shape.
 *
 * `Build failed for deployment <uuid>` was the whole record. It reached the job's `last_error` and
 * nowhere else, and every real failure on this platform needed a `kubectl logs` to explain — a
 * missing Dockerfile, a registry that refused the push, a pod the scheduler could not place. Each
 * explanation existed at the moment the platform threw it away.
 *
 * The scheduling case is why the pod's status is read before its logs. A build that never started
 * has no logs, and reading logs first reports an empty string for the one failure whose cause is
 * least guessable from outside — which is exactly what happened: five retries, a dead letter, and
 * a message implying the build had run.
 */

function kubeReturning(pod: unknown, log = "") {
  return {
    get: <T>() => Promise.resolve(pod as T),
    logs: () => Promise.resolve(log),
  }
}

describe("buildFailureReason", () => {
  it("reports why a pod could not be scheduled, where there are no logs to read", async () => {
    const reason = await buildFailureReason(
      kubeReturning({
        items: [
          {
            metadata: { name: "build-x" },
            status: {
              phase: "Pending",
              conditions: [
                {
                  type: "PodScheduled",
                  status: "False",
                  reason: "Unschedulable",
                  message: "0/3 nodes are available: 2 Insufficient cpu.",
                },
              ],
            },
          },
        ],
      }),
      "dep-1",
    )

    expect(reason).toContain("Unschedulable")
    expect(reason).toContain("Insufficient cpu")
  })

  it("reports the tail of the build log when the build actually ran", async () => {
    const reason = await buildFailureReason(
      kubeReturning(
        {
          items: [
            {
              metadata: { name: "build-x" },
              status: {
                phase: "Failed",
                containerStatuses: [{ state: { terminated: { reason: "Error", exitCode: 1 } } }],
              },
            },
          ],
        },
        "#8 building\nerror: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory\n",
      ),
      "dep-1",
    )

    expect(reason).toContain("failed to read dockerfile")
  })

  it("reports an image that could not be pulled", async () => {
    const reason = await buildFailureReason(
      kubeReturning({
        items: [
          {
            metadata: { name: "build-x" },
            status: {
              phase: "Pending",
              containerStatuses: [
                { state: { waiting: { reason: "ImagePullBackOff", message: "manifest unknown" } } },
              ],
            },
          },
        ],
      }),
      "dep-1",
    )

    expect(reason).toContain("ImagePullBackOff")
  })

  it("never lets the explanation replace the failure it was explaining", async () => {
    // A constraint violation inside a catch has hidden a real error on this codebase before; see
    // docs/findings/0010. This runs on the failure path and must not throw.
    const reason = await buildFailureReason(
      {
        get: () => Promise.reject(new Error("API server said no")),
        logs: () => Promise.resolve(""),
      },
      "dep-1",
    )

    expect(reason).toContain("could not read why the build failed")
    expect(reason).toContain("API server said no")
  })

  it("says so plainly when the pod is gone", async () => {
    const reason = await buildFailureReason(kubeReturning({ items: [] }), "dep-1")
    expect(reason).toContain("gone")
  })
})
