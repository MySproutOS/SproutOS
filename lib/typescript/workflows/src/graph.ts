import { encodeHexLowerCase, sha256Utf8 } from "@utils/crypto"

/**
 * A workflow graph: what the node editor saves and what the runner executes.
 *
 * TASK 20 asks for an n8n-shaped editor, so the stored artifact is a graph rather than a script.
 * Everything here exists to make a graph that *cannot run* fail at save time, in the editor, with
 * a message about the node in question — rather than at 3am, half-executed, with a partial run to
 * reconcile.
 */

export const NODE_TYPES = [
  "trigger.manual",
  "trigger.cron",
  "trigger.webhook",
  "trigger.event",
  "action.http",
  "action.code",
  "action.database",
  "action.email",
  "control.branch",
  "control.delay",
] as const

export type NodeType = (typeof NODE_TYPES)[number]

export type WorkflowNode = {
  id: string
  type: NodeType
  name: string
  config: Record<string, unknown>
  /** Editor coordinates. Round-tripped, never interpreted. */
  position?: { x: number; y: number }
}

export type WorkflowEdge = {
  from: string
  to: string
  /** Which output of a branching node this edge leaves from. */
  branch?: string | null
}

export type WorkflowGraph = {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export class InvalidGraphError extends Error {
  override readonly name = "InvalidGraphError"

  constructor(
    readonly problem: string,
    /** Which node the editor should highlight, when the problem has one. */
    readonly nodeId: string | null = null,
  ) {
    super(problem)
  }
}

export function isTriggerType(type: string): boolean {
  return type.startsWith("trigger.")
}

/**
 * Validate a graph, in the order a person would want to hear about the problems.
 *
 * Structural errors first (a node with no id is not a graph), then the ones about what the graph
 * *means* (two triggers, a cycle, an unreachable node). Reporting a cycle before noticing an edge
 * points at a node that does not exist would send someone hunting for a loop that is really a typo.
 */
export function validateGraph(graph: WorkflowGraph): void {
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new InvalidGraphError("A graph needs a nodes array and an edges array")
  }
  if (graph.nodes.length === 0) throw new InvalidGraphError("A workflow needs at least one node")

  const byId = new Map<string, WorkflowNode>()
  for (const node of graph.nodes) {
    if (typeof node.id !== "string" || node.id === "") {
      throw new InvalidGraphError("Every node needs an id")
    }
    if (byId.has(node.id)) throw new InvalidGraphError(`Duplicate node id: ${node.id}`, node.id)
    if (!(NODE_TYPES as readonly string[]).includes(node.type)) {
      throw new InvalidGraphError(`Unknown node type: ${node.type}`, node.id)
    }
    byId.set(node.id, node)
  }

  for (const edge of graph.edges) {
    if (!byId.has(edge.from)) throw new InvalidGraphError(`Edge from unknown node: ${edge.from}`)
    if (!byId.has(edge.to)) throw new InvalidGraphError(`Edge to unknown node: ${edge.to}`)
    // A self-edge is a cycle of length one, and reporting it as "there is a cycle" would be
    // needlessly mysterious when the answer is right there.
    if (edge.from === edge.to) {
      throw new InvalidGraphError(`A node cannot connect to itself: ${edge.from}`, edge.from)
    }
  }

  const triggers = graph.nodes.filter((node) => isTriggerType(node.type))
  if (triggers.length === 0) {
    throw new InvalidGraphError("A workflow needs a trigger node to start from")
  }
  if (triggers.length > 1) {
    // Two triggers means two entry points and no single answer to "what ran, and why". Two
    // workflows sharing a sub-graph is the shape that actually works.
    throw new InvalidGraphError(
      `A workflow can only have one trigger; found ${triggers.length}`,
      triggers[1].id,
    )
  }

  const trigger = triggers[0]
  if (graph.edges.some((edge) => edge.to === trigger.id)) {
    throw new InvalidGraphError("Nothing can lead back into the trigger", trigger.id)
  }

  assertAcyclic(graph)

  // Unreachable nodes are an error rather than a warning: a node the editor shows and the runner
  // never executes is a lie about what the workflow does, and it is invariably a disconnected edge
  // someone meant to attach.
  const reachable = reachableFrom(graph, trigger.id)
  const orphan = graph.nodes.find((node) => !reachable.has(node.id))
  if (orphan !== undefined) {
    throw new InvalidGraphError(
      `${orphan.name || orphan.id} is not connected to the trigger`,
      orphan.id,
    )
  }
}

/**
 * Depth-first cycle detection, reporting the node the loop closes on.
 *
 * `topologicalOrder` would also fail on a cycle, but only by noticing that some nodes were left
 * over — which cannot say *where*. The editor needs a node to highlight.
 */
function assertAcyclic(graph: WorkflowGraph): void {
  const outgoing = adjacency(graph)
  const state = new Map<string, "visiting" | "done">()

  const visit = (id: string): void => {
    const current = state.get(id)
    if (current === "done") return
    if (current === "visiting") {
      throw new InvalidGraphError(`This connection creates a loop at ${id}`, id)
    }

    state.set(id, "visiting")
    for (const next of outgoing.get(id) ?? []) visit(next)
    state.set(id, "done")
  }

  for (const node of graph.nodes) visit(node.id)
}

function adjacency(graph: WorkflowGraph): Map<string, string[]> {
  const outgoing = new Map<string, string[]>()
  for (const node of graph.nodes) outgoing.set(node.id, [])
  for (const edge of graph.edges) outgoing.get(edge.from)?.push(edge.to)
  return outgoing
}

function reachableFrom(graph: WorkflowGraph, start: string): Set<string> {
  const outgoing = adjacency(graph)
  const seen = new Set<string>([start])
  const queue = [start]

  while (queue.length > 0) {
    for (const next of outgoing.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }

  return seen
}

/**
 * The order the runner executes nodes in.
 *
 * Kahn's algorithm, so a node never runs before something it depends on. Ties are broken by node
 * id rather than left to Map iteration order, because a run's step order ends up in a log a person
 * compares across runs — and "the same graph produced a different order" is a bug report nobody
 * can act on.
 */
export function topologicalOrder(graph: WorkflowGraph): string[] {
  validateGraph(graph)

  const outgoing = adjacency(graph)
  const indegree = new Map<string, number>()
  for (const node of graph.nodes) indegree.set(node.id, 0)
  for (const edge of graph.edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)

  const ready = graph.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id)
    .sort()

  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(id)

    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remaining)
      if (remaining === 0) {
        ready.push(next)
        ready.sort()
      }
    }
  }

  return order
}

/**
 * A content hash of the graph, for `workflow_version.graph_sha256`.
 *
 * Keys are sorted and editor coordinates are excluded, so saving after dragging a node around
 * produces the same hash and no new version. A version per nudge would make the history useless
 * for the question it exists to answer: what actually changed about what this runs.
 */
export async function hashGraph(graph: WorkflowGraph): Promise<string> {
  const canonical = {
    nodes: [...graph.nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => ({
        id: node.id,
        type: node.type,
        name: node.name,
        config: sortKeys(node.config),
      })),
    edges: [...graph.edges]
      .map((edge) => ({ from: edge.from, to: edge.to, branch: edge.branch ?? null }))
      .sort((a, b) =>
        `${a.from}>${a.to}>${a.branch}`.localeCompare(`${b.from}>${b.to}>${b.branch}`),
      ),
  }

  return encodeHexLowerCase(await sha256Utf8(JSON.stringify(canonical)))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value !== "object" || value === null) return value

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  return Object.fromEntries(entries.map(([key, inner]) => [key, sortKeys(inner)]))
}
