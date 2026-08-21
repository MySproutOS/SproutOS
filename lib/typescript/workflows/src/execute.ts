import { type NodeType, type WorkflowGraph, isTriggerType, topologicalOrder } from "./graph"

/**
 * Where a node is allowed to run.
 *
 * This is a security boundary, not a scheduling hint, and it is the reason a workflow run cannot
 * simply be a loop in the job worker.
 *
 * The worker runs inside the control plane's namespace. It holds the control-plane database URL,
 * the envelope KMS key, the GitHub App credentials and a Kubernetes service account, and — unlike a
 * tenant pod — it is not under `deploy/tenant/network-policy.yaml`, so nothing stops it reaching
 * the API server, another tenant's database, or `169.254.169.254`.
 *
 * `action.http` sends a request to a URL a customer typed. `action.code` executes source a customer
 * wrote. Running either there hands an attacker the control plane, and it is the obvious next step
 * for anyone implementing this — the code is three lines and it works in a test. Hence an explicit
 * table rather than a comment somewhere.
 */
export type Runtime =
  /** Safe in the worker: no customer-supplied destination, no customer-supplied code. */
  | "control-plane"
  /** Needs the Kata sandbox and the tenant NetworkPolicy. See ADR 0012's runtime classes. */
  | "sandbox"

export const NODE_RUNTIME: Record<NodeType, Runtime> = {
  // Triggers do not execute; they record what started the run.
  "trigger.manual": "control-plane",
  "trigger.cron": "control-plane",
  "trigger.webhook": "control-plane",
  "trigger.event": "control-plane",
  // A URL the customer chose, fetched from inside the VPC. Never here.
  "action.http": "sandbox",
  // Customer source. Never here, under any sandboxing this process could provide — `vm` is not a
  // security boundary and never has been.
  "action.code": "sandbox",
  // A query against the customer's own database, through their own credentials. It belongs on the
  // side of the proxy that has them.
  "action.database": "sandbox",
  // Sends mail as the platform. A customer-controlled recipient and body from a control-plane
  // sender is an open relay wearing our reputation.
  "action.email": "sandbox",
  // Pure graph control. No destination, no code.
  "control.branch": "control-plane",
  "control.delay": "control-plane",
}

export type PlannedStep = {
  nodeId: string
  nodeType: NodeType
  name: string
  runtime: Runtime
  isTrigger: boolean
  /**
   * The node's configuration, carried onto the step.
   *
   * The graph is versioned and a run points at a version, so this could be read back through the
   * join every time — and it was, by not being carried at all: `stepRowsFor` wrote `{}` and the
   * runner found no `url` on an `action.http` node it had just been asked to fetch.
   *
   * Copied onto the step instead, because a step's `input` is the record of what it was actually
   * asked to do. Reading it back through the version would show what the graph says *now*, and a
   * graph edited after a failed run would rewrite the history of why it failed.
   */
  config: Record<string, unknown>
}

/**
 * The steps a run will have, in the order they would execute.
 *
 * Written at run creation rather than accumulated as the run proceeds, for the same reason
 * `project_job` writes its steps up front: an empty list between "started" and "first step" reads
 * as a stuck run.
 *
 * `topologicalOrder` throws on a cycle. It cannot happen here — `validateGraph` rejects one at save
 * time — but the ordering is what makes the step list meaningful, so it is called rather than
 * assumed.
 */
export function plannedSteps(graph: WorkflowGraph): PlannedStep[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))

  return topologicalOrder(graph).flatMap((nodeId) => {
    const node = byId.get(nodeId)
    if (node === undefined) return []
    return [
      {
        nodeId: node.id,
        nodeType: node.type,
        name: node.name,
        runtime: NODE_RUNTIME[node.type],
        isTrigger: isTriggerType(node.type),
        config: node.config,
      },
    ]
  })
}

/** Whether a graph can complete without a sandbox. Almost none can, and that is the point. */
export function needsSandbox(graph: WorkflowGraph): boolean {
  return graph.nodes.some((node) => NODE_RUNTIME[node.type] === "sandbox")
}
