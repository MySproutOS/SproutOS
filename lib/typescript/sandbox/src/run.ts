import { createKubeClient, inClusterConfig } from "@lib/deploy/kube"
import { ensureTenantNamespace } from "./tenant-namespace"
import {
  DEFAULT_TIMEOUT_S,
  jobPath,
  podLogPath,
  podsForJobPath,
  sandboxJob,
  type SandboxSpec,
} from "./spec"

/**
 * Running one piece of untrusted work and collecting what it said.
 *
 * A Job and its logs, rather than a pod and an exec stream. Exec means SPDY or a websocket, a
 * long-lived connection held by whichever API replica handled the request, and a run that dies when
 * that replica is rolled. A Job is a row in the API server: the work survives a redeploy of the
 * control plane, which is the difference between a customer's script finishing and a customer's
 * script disappearing because we shipped.
 */

export type SandboxResult = {
  /** `0` for success. `null` when the Job hit its deadline and no container ever reported one. */
  exitCode: number | null
  /** Combined stdout and stderr, tail-limited. Empty is normal — not every run says anything. */
  output: string
  /** True when Kubernetes killed it at `activeDeadlineSeconds`. */
  timedOut: boolean
}

export class SandboxTimeoutError extends Error {
  override readonly name = "SandboxTimeoutError"

  constructor(readonly seconds: number) {
    super(`The sandbox did not finish within ${seconds}s`)
  }
}

type JobStatus = {
  status?: {
    succeeded?: number
    failed?: number
    conditions?: { type?: string; status?: string; reason?: string }[]
  }
}

type PodList = {
  items?: {
    metadata?: { name?: string }
    status?: {
      containerStatuses?: { name?: string; state?: { terminated?: { exitCode?: number } } }[]
    }
  }[]
}

/** How often the Job is polled. */
const POLL_MS = 1000

/**
 * The runtime class sandboxes get, from the environment.
 *
 * Unset means none, and that is a supported configuration rather than a misconfiguration — a
 * cluster with no bare-metal node pool has no Kata runtime class to name. The isolation that does
 * not depend on it is in `spec.ts`: the tenant namespace, its NetworkPolicy, and a pod with no
 * service-account token.
 */
export function sandboxRuntimeClass(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.SANDBOX_RUNTIME_CLASS
  return value === undefined || value === "" ? undefined : value
}

export async function runInSandbox(
  spec: SandboxSpec,
  client = createKubeClient(inClusterConfig()),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<SandboxResult> {
  const seconds = spec.timeoutSeconds ?? DEFAULT_TIMEOUT_S
  const path = jobPath(spec.namespace, spec.name)

  /*
    The namespace and its NetworkPolicies, before the Job that runs customer code in them.

    Here rather than at each call site, because "run this in the tenant's namespace" and "the
    tenant's namespace is fenced" are the same requirement — a caller that could get one without the
    other is a caller that can run untrusted code with unrestricted egress. It was possible until
    now: nothing in the repository created a tenant namespace at all.
  */
  await ensureTenantNamespace(client, spec.namespace)

  await client.apply(path, sandboxJob(spec))

  try {
    /*
      Bounded by the caller's own clock as well as the Job's `activeDeadlineSeconds`.

      The Job's deadline is what actually kills the work — it is enforced by Kubernetes and survives
      this process. This loop's bound exists for the case the API server stops answering: without
      it, a poll that never resolves holds a worker forever on a Job that may already be finished.
      Generous, because it must not be the one that fires first.
    */
    const deadline = Date.now() + (seconds + 30) * 1000

    for (;;) {
      const job = await client.get<JobStatus>(path)
      const status = job?.status ?? {}

      const deadlineExceeded = (status.conditions ?? []).some(
        (condition) => condition.reason === "DeadlineExceeded",
      )

      if ((status.succeeded ?? 0) > 0 || (status.failed ?? 0) > 0) {
        return { ...(await collect(client, spec)), timedOut: deadlineExceeded }
      }

      if (Date.now() > deadline) throw new SandboxTimeoutError(seconds)
      await sleep(POLL_MS)
    }
  } finally {
    /*
      Deleted whether the run succeeded, failed, or threw.

      A sandbox that outlives its run is a container a customer's code is still executing in, billed
      to somebody, reachable by nothing that will ever look at it again. `finally` rather than after
      the return, because the throwing paths are exactly the ones where cleanup is skipped by
      accident.
    */
    await client.remove(path)
  }
}

/** The exit code and logs of the Job's pod. */
async function collect(
  client: {
    get: <T>(path: string) => Promise<T | undefined>
    logs: (path: string) => Promise<string>
  },
  spec: SandboxSpec,
): Promise<{ exitCode: number | null; output: string }> {
  const pods = await client.get<PodList>(podsForJobPath(spec.namespace, spec.name))
  const pod = pods?.items?.[0]
  const name = pod?.metadata?.name

  if (name === undefined) return { exitCode: null, output: "" }

  // Read before the `finally` above deletes the Job — a pod's logs go with it, and an exit code
  // with no output is the least useful possible answer.
  const output = await client.logs(podLogPath(spec.namespace, name))

  const terminated = (pod?.status?.containerStatuses ?? []).find(
    (container) => container.name === "work",
  )?.state?.terminated

  return { exitCode: terminated?.exitCode ?? null, output }
}
