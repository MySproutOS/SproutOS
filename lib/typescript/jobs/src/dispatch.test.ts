import { describe, expect, it } from "vitest"
import { IDLE_MS, MASTER_WAKE_KEY, parseMember, parseWakes } from "./dispatch"
import {
  QUEUE_LABEL,
  queueSecret,
  queueSecretName,
  workerDeployment,
  workerName,
} from "@lib/deploy"

const ORGANIZATION = "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f"
const PROJECT = "01912d40-0000-7000-8000-0000000000a1"

/*
  The member format is a cross-language contract.

  `services/valkey-proxy/src/master.rs` writes `<resource-short-id>/<queue>` and this reads it. The
  Rust side asserts the same two properties from its end — that the parts join with a slash, and
  that a queue name containing one still round-trips.
*/
describe("parseMember", () => {
  it("splits a resource from its queue", () => {
    expect(parseMember("01j4pkz2hbfh6sw7sa7d65tvkz/emails", 1000)).toEqual({
      resource: "01j4pkz2hbfh6sw7sa7d65tvkz",
      queue: "emails",
      lastSeen: 1000,
    })
  })

  /*
    On the *first* slash.

    A queue name may contain one; a Crockford short id may not. Splitting on the last would give a
    resource id with a slash in it, which decodes to nothing — so a customer with a `media/transcode`
    queue would silently never get a worker.
  */
  it("splits on the first slash, so a queue name may contain one", () => {
    expect(parseMember("01j4pkz2hbfh6sw7sa7d65tvkz/media/transcode", 5)?.queue).toBe(
      "media/transcode",
    )
  })

  it("refuses a member with no queue, or no resource", () => {
    expect(parseMember("01j4pkz2hbfh6sw7sa7d65tvkz", 1)).toBeUndefined()
    expect(parseMember("01j4pkz2hbfh6sw7sa7d65tvkz/", 1)).toBeUndefined()
    expect(parseMember("/emails", 1)).toBeUndefined()
    expect(parseMember("", 1)).toBeUndefined()
  })

  it("names the same key the proxy writes to", () => {
    // Mirrors `MASTER_WAKE_KEY` in `master.rs`. A mismatch is a dispatcher reading an empty set
    // forever while the proxy fills a different one, with nothing anywhere reporting a problem.
    expect(MASTER_WAKE_KEY).toBe("sproutos:master:wake")
  })

  /*
    Stopping is slower than starting, on purpose.

    Starting is a decision from evidence: work arrived. Stopping is a decision from the *absence* of
    evidence, and absence is indistinguishable from a proxy that has been unable to report — so the
    window has to outlast a proxy restart comfortably.
  */
  it("waits longer to stop a worker than a deploy takes", () => {
    expect(IDLE_MS).toBeGreaterThanOrEqual(5 * 60 * 1000)
  })
})

/*
  Both reply shapes, because reading only one is silent.

  RESP2 returns `[member, score, member, score]` and RESP3 returns `[[member, score], …]`; ioredis 6
  negotiates RESP3. A parser that knew only the flat shape found every element to be an array,
  parsed nothing, and reported zero queues against a set that was full — which is indistinguishable
  from an idle platform, and is exactly what happened on the cluster.
*/
describe("parseWakes", () => {
  it("reads the RESP2 flat reply", () => {
    expect(parseWakes(["res/emails", "1000", "res/video", "2000"])).toEqual([
      { resource: "res", queue: "emails", lastSeen: 1000 },
      { resource: "res", queue: "video", lastSeen: 2000 },
    ])
  })

  it("reads the RESP3 paired reply", () => {
    expect(
      parseWakes([
        ["res/emails", "1000"],
        ["res/video", 2000],
      ]),
    ).toEqual([
      { resource: "res", queue: "emails", lastSeen: 1000 },
      { resource: "res", queue: "video", lastSeen: 2000 },
    ])
  })

  it("reads an empty set as no work, in either shape", () => {
    expect(parseWakes([])).toEqual([])
  })

  it("skips a member it cannot parse rather than failing the run", () => {
    // One malformed entry must not cost every other tenant their worker.
    expect(parseWakes(["no-slash", "1", "res/emails", "2"])).toEqual([
      { resource: "res", queue: "emails", lastSeen: 2 },
    ])
  })
})

describe("the worker deployment", () => {
  const spec = {
    namespace: "tenant-abc",
    image: "registry/app:sha",
    queue: "emails",
    secretName: queueSecretName("01j4pkz2hbfh6sw7sa7d65tvkz"),
    organizationId: ORGANIZATION,
    projectId: PROJECT,
  }

  function pod(replicas: number) {
    const deployment = workerDeployment(spec, replicas) as unknown as {
      spec: {
        replicas: number
        template: { metadata: { labels: Record<string, string> }; spec: Record<string, unknown> }
      }
    }
    return deployment.spec
  }

  it("carries the replica count the dispatcher decided", () => {
    expect(pod(1).replicas).toBe(1)
    expect(pod(0).replicas).toBe(0)
  })

  /*
    The URI is in a Secret, never in `env`.

    A connection string carries the tenant's secret. In `env` it is readable by anyone with
    `get deployments` and appears in every `kubectl describe`; in a Secret it needs `get secrets` in
    one namespace, which is a grant the platform does not hand out.
  */
  it("takes its broker URI from a Secret rather than from env", () => {
    const container = (pod(1).template.spec as { containers: Record<string, unknown>[] })
      .containers[0]
    expect(container?.envFrom).toEqual([{ secretRef: { name: spec.secretName } }])
    expect(JSON.stringify(container?.env)).not.toContain("://")
  })

  it("runs a customer's code with no service-account token", () => {
    // A worker runs code the customer wrote. Same treatment as a sandbox.
    expect(pod(1).template.spec.automountServiceAccountToken).toBe(false)
  })

  it("labels the pod with who pays for it", () => {
    expect(pod(1).template.metadata.labels).toMatchObject({
      "sproutos.dev/organization-id": ORGANIZATION,
      "sproutos.dev/project-id": PROJECT,
    })
  })

  /*
    One worker per queue, not per project.

    Two queues with different duty cycles are two workloads. A single process consuming both keeps a
    pod alive for whichever is busy, which is the whole saving gone.
  */
  it("gives two queues two names", () => {
    expect(workerName(PROJECT, "emails")).not.toBe(workerName(PROJECT, "video"))
  })

  /*
    A queue name is a customer string: it can be long, hold characters a label may not, and differ
    from another only past 63 characters. The name is bounded and the queue rides in a label.
  */
  it("produces a valid DNS label from any queue name", () => {
    for (const queue of ["emails", "Media/Transcode!", "x".repeat(200), "", "--weird--"]) {
      const name = workerName(PROJECT, queue)
      expect(name.length).toBeLessThanOrEqual(63)
      expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    }
  })

  it("records the queue in a label, where a name could not hold it", () => {
    const labels = (
      workerDeployment({ ...spec, queue: "Media/Transcode" }, 1) as unknown as {
        spec: { template: { metadata: { labels: Record<string, string> } } }
      }
    ).spec.template.metadata.labels
    expect(labels[QUEUE_LABEL]).toBe("Media/Transcode")
  })
})

describe("the queue secret", () => {
  it("holds the URI under both the conventional name and ours", () => {
    const secret = queueSecret("tenant-abc", "01j4pkz2hbfh6sw7sa7d65tvkz", "redis://u:p@host:6379")
    expect(secret.stringData).toEqual({
      SPROUT_QUEUE_URL: "redis://u:p@host:6379",
      REDIS_URL: "redis://u:p@host:6379",
    })
  })

  it("lives in the tenant's namespace and nowhere else", () => {
    const secret = queueSecret("tenant-abc", "01j4pkz2hbfh6sw7sa7d65tvkz", "redis://x") as {
      metadata: { namespace: string; name: string }
    }
    expect(secret.metadata.namespace).toBe("tenant-abc")
    expect(secret.metadata.name).toBe("queue-01j4pkz2hbfh6sw7sa7d65tvkz")
  })
})
