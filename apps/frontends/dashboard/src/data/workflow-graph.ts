import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getV1OrgsByOrgSlugProjectsByProjectIdWorkflowsByWorkflowIdOptions,
  getV1OrgsByOrgSlugProjectsByProjectIdWorkflowsByWorkflowIdQueryKey,
  putV1OrgsByOrgSlugProjectsByProjectIdWorkflowsByWorkflowIdGraphMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

/**
 * The node vocabulary, mirroring `NODE_TYPES` in `@lib/workflows`.
 *
 * Duplicated rather than imported: `@lib/workflows` pulls in the validator and its crypto helpers,
 * and the editor only needs the names. **The server is still the authority** — it validates every
 * save — so a drift here shows up as a save that is refused with a message, not as a graph that
 * runs wrong.
 */
export const NODE_KINDS = [
  { type: "trigger.manual", label: "Manual", group: "Triggers" },
  { type: "trigger.cron", label: "Schedule", group: "Triggers" },
  { type: "trigger.webhook", label: "Webhook", group: "Triggers" },
  { type: "trigger.event", label: "Event", group: "Triggers" },
  { type: "action.http", label: "HTTP request", group: "Actions" },
  { type: "action.code", label: "Run code", group: "Actions" },
  { type: "action.database", label: "Database", group: "Actions" },
  { type: "action.email", label: "Send email", group: "Actions" },
  { type: "control.branch", label: "Branch", group: "Control" },
  { type: "control.delay", label: "Delay", group: "Control" },
] as const

export type NodeKind = (typeof NODE_KINDS)[number]["type"]

export const NODE_LABELS: Record<string, string> = Object.fromEntries(
  NODE_KINDS.map((kind) => [kind.type, kind.label]),
)

export function isTrigger(type: string): boolean {
  return type.startsWith("trigger.")
}

export type GraphNode = {
  id: string
  type: string
  name: string
  config: Record<string, unknown>
  position?: { x: number; y: number }
}

export type GraphEdge = { from: string; to: string; branch?: string | null }

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] }

/**
 * The config fields the editor offers per node type.
 *
 * A deliberately small set. The runner has not been written, so the fields it will actually read
 * are not settled — offering a form for every option a node *might* take would be inventing a
 * contract. These are the ones a graph is unusable without.
 */
export const CONFIG_FIELDS: Record<
  string,
  Array<{ key: string; label: string; placeholder: string }>
> = {
  "trigger.cron": [{ key: "cron", label: "Cron expression", placeholder: "0 3 * * *" }],
  "trigger.webhook": [{ key: "path", label: "Path", placeholder: "/hooks/inbound" }],
  "trigger.event": [{ key: "event", label: "Event name", placeholder: "order.created" }],
  "action.http": [
    { key: "method", label: "Method", placeholder: "POST" },
    { key: "url", label: "URL", placeholder: "https://api.example.com/hook" },
  ],
  "action.code": [{ key: "entrypoint", label: "Entrypoint", placeholder: "src/jobs/index.ts" }],
  "action.database": [{ key: "query", label: "Query", placeholder: "select 1" }],
  "action.email": [
    { key: "to", label: "To", placeholder: "ops@example.com" },
    { key: "subject", label: "Subject", placeholder: "Nightly report" },
  ],
  "control.branch": [{ key: "condition", label: "Condition", placeholder: "status === 200" }],
  "control.delay": [{ key: "seconds", label: "Delay (seconds)", placeholder: "30" }],
}

export function useWorkflowGraph(orgSlug: string, projectId: string, workflowId: string) {
  return useQuery(
    getV1OrgsByOrgSlugProjectsByProjectIdWorkflowsByWorkflowIdOptions({
      path: { orgSlug, projectId, workflowId },
    }),
  )
}

/**
 * Saves a graph.
 *
 * The server validates and refuses anything that cannot run — two triggers, a cycle, an unreachable
 * node — so the editor deliberately does **not** re-implement those checks. One validator, and the
 * message a user sees is the one the runner would have acted on.
 */
export function useSaveGraph(orgSlug: string, projectId: string, workflowId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...putV1OrgsByOrgSlugProjectsByProjectIdWorkflowsByWorkflowIdGraphMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugProjectsByProjectIdWorkflowsByWorkflowIdQueryKey({
          path: { orgSlug, projectId, workflowId },
        }),
      })
    },
  })
}

/**
 * Lays out a graph that has no positions.
 *
 * Positions are optional in the model, and a graph saved by something other than this editor — a
 * migration, an API client, the analyzer — will not have them. Without a fallback every node would
 * stack at the origin and the canvas would look empty.
 *
 * Depth from the trigger, breadth within a depth. Not a good general graph layout, and it does not
 * need to be: it runs once, and the moment someone drags a node the real positions are saved.
 */
export function autoLayout(graph: Graph): Graph {
  if (graph.nodes.every((node) => node.position !== undefined)) return graph

  const outgoing = new Map<string, string[]>()
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to])
  }

  const depth = new Map<string, number>()
  const roots = graph.nodes.filter((node) => !graph.edges.some((edge) => edge.to === node.id))
  const queue = roots.map((node) => ({ id: node.id, depth: 0 }))
  // Every node, not only the reachable ones: an orphan still has to be visible or it cannot be
  // deleted, and an invisible node is why a save keeps failing for no apparent reason.
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    if (depth.has(next.id)) continue
    depth.set(next.id, next.depth)
    for (const child of outgoing.get(next.id) ?? []) {
      queue.push({ id: child, depth: next.depth + 1 })
    }
  }

  const rowCounts = new Map<number, number>()
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.position !== undefined) return node
      const column = depth.get(node.id) ?? 0
      const row = rowCounts.get(column) ?? 0
      rowCounts.set(column, row + 1)
      return { ...node, position: { x: column * 280, y: row * 130 } }
    }),
  }
}

/** A node id that is stable, readable in the saved JSON, and cannot collide. */
export function newNodeId(type: string, existing: readonly string[]): string {
  const stem = type.split(".")[1] ?? "node"
  let index = 1
  while (existing.includes(`${stem}-${index}`)) index += 1
  return `${stem}-${index}`
}
