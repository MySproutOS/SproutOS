import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowLeftIcon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@ui/base/ui/alert"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/base/ui/select"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import { WorkflowNode, type WorkflowNodeData } from "@frontends/dashboard/components/workflow-node"
import {
  autoLayout,
  CONFIG_FIELDS,
  isTrigger,
  newNodeId,
  NODE_KINDS,
  NODE_LABELS,
  useSaveGraph,
  useWorkflowGraph,
  type Graph,
  type GraphEdge,
  type GraphNode,
} from "@frontends/dashboard/data/workflow-graph"

export const Route = createFileRoute("/orgs/$orgSlug/projects/$projectId/workflows/$workflowId")({
  component: WorkflowEditor,
})

const nodeTypes = { workflow: WorkflowNode }

function WorkflowEditor() {
  const { orgSlug, projectId, workflowId } = Route.useParams()
  const query = useWorkflowGraph(orgSlug, projectId, workflowId)

  return (
    <>
      <PageHeader title={query.data?.name ?? "Workflow"}>
        <Button
          variant="ghost"
          size="sm"
          render={<Link to="/orgs/$orgSlug/workflows" params={{ orgSlug }} />}
        >
          <ArrowLeftIcon className="size-4" />
          Workflows
        </Button>
      </PageHeader>

      {query.isPending ? (
        <PageBody>
          <ListSkeleton rows={4} />
        </PageBody>
      ) : null}
      {query.isError ? (
        <PageBody>
          <ListError title="Could not load the workflow" onRetry={() => void query.refetch()} />
        </PageBody>
      ) : null}

      {query.data !== undefined ? (
        /*
          `key` on the workflow id so switching workflows rebuilds the canvas.

          The editor's state is seeded from the loaded graph in `useState`, which only reads its
          initial value once. Without this, navigating from one workflow to another would keep the
          first one's nodes on screen while the header showed the second one's name.
        */
        <ReactFlowProvider key={workflowId}>
          <Canvas
            orgSlug={orgSlug}
            projectId={projectId}
            workflowId={workflowId}
            initial={query.data.graph ?? { nodes: [], edges: [] }}
            version={query.data.currentVersion}
          />
        </ReactFlowProvider>
      ) : null}
    </>
  )
}

/** The saved graph, in the shape React Flow wants. */
function toFlow(graph: Graph): { nodes: Node[]; edges: Edge[] } {
  const laid = autoLayout(graph)
  return {
    nodes: laid.nodes.map((node) => ({
      id: node.id,
      type: "workflow",
      position: node.position ?? { x: 0, y: 0 },
      data: { name: node.name, kind: node.type, invalid: false } satisfies WorkflowNodeData,
    })),
    edges: laid.edges.map((edge) => ({
      id: `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      ...(edge.branch === undefined || edge.branch === null ? {} : { label: edge.branch }),
    })),
  }
}

/**
 * The canvas as the model stores it.
 *
 * Positions are rounded: React Flow tracks sub-pixel coordinates during a drag, and nine decimal
 * places in a stored graph is noise that changes `graph_sha256` on every save — which would cut a
 * new version for nudging a node half a pixel.
 */
function toGraph(
  nodes: Node[],
  edges: Edge[],
  config: Record<string, Record<string, unknown>>,
): Graph {
  return {
    nodes: nodes.map((node): GraphNode => ({
      id: node.id,
      type: (node.data as WorkflowNodeData).kind,
      name: (node.data as WorkflowNodeData).name,
      config: config[node.id] ?? {},
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
    })),
    edges: edges.map((edge): GraphEdge => ({ from: edge.source, to: edge.target })),
  }
}

function Canvas(props: {
  orgSlug: string
  projectId: string
  workflowId: string
  initial: Graph
  version: number | null
}) {
  const flow = useMemo(() => toFlow(props.initial), [props.initial])
  const [nodes, setNodes, onNodesChange] = useNodesState(flow.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(flow.edges)

  /*
    Config lives outside the React Flow nodes.

    A node's `data` is what the canvas renders, and React Flow copies it on every change; keeping a
    customer's arbitrary config in there means it travels through every drag. This map is keyed by
    node id and is the thing that gets saved.
  */
  const [config, setConfig] = useState<Record<string, Record<string, unknown>>>(() =>
    Object.fromEntries(props.initial.nodes.map((node) => [node.id, node.config])),
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addType, setAddType] = useState<string>(NODE_KINDS[0].type)
  /*
    What was last saved, and what the last error was about — both keyed by a signature of the graph
    they describe.

    Derived during render rather than cleared by an effect. An effect that calls `setState` on every
    node change starts a second render for something the first render already knew, and it means
    "Saved" briefly stays on screen after an edit that invalidated it.
  */
  const [savedSignature, setSavedSignature] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ signature: string; message: string } | null>(null)

  const save = useSaveGraph(props.orgSlug, props.projectId, props.workflowId)
  const selected = nodes.find((node) => node.id === selectedId)

  const graph = useMemo(() => toGraph(nodes, edges, config), [nodes, edges, config])
  const signature = useMemo(() => JSON.stringify(graph), [graph])

  // A message that outlives the thing it describes is a lie, so both are gated on the signature
  // still matching.
  const saved = savedSignature === signature
  const currentProblem = problem?.signature === signature ? problem.message : null

  const onConnect = useCallback(
    (connection: Connection) => {
      // React Flow allows a self-loop; `validateGraph` calls it a cycle. Refusing it here means the
      // person finds out while dragging rather than on save.
      if (connection.source === connection.target) return
      setEdges((current) =>
        addEdge({ ...connection, id: `${connection.source}->${connection.target}` }, current),
      )
    },
    [setEdges],
  )

  function addNode() {
    const id = newNodeId(
      addType,
      nodes.map((node) => node.id),
    )
    setNodes((current) => [
      ...current,
      {
        id,
        type: "workflow",
        // Dropped below whatever is already there rather than at the origin, so a new node is never
        // hidden under an existing one.
        position: { x: 80, y: current.length * 110 + 60 },
        data: {
          name: NODE_LABELS[addType] ?? addType,
          kind: addType,
          invalid: false,
        } satisfies WorkflowNodeData,
      },
    ])
    setConfig((current) => ({ ...current, [id]: {} }))
    setSelectedId(id)
  }

  function removeSelected() {
    if (selectedId === null) return
    setNodes((current) => current.filter((node) => node.id !== selectedId))
    // Its edges go with it. An edge pointing at a node that no longer exists is the first thing
    // `validateGraph` refuses, and leaving them would make deleting a node break the save.
    setEdges((current) =>
      current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId),
    )
    setSelectedId(null)
  }

  function rename(name: string) {
    if (selectedId === null) return
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedId ? { ...node, data: { ...node.data, name } } : node,
      ),
    )
  }

  function setField(key: string, value: string) {
    if (selectedId === null) return
    setConfig((current) => ({
      ...current,
      [selectedId]: { ...current[selectedId], [key]: value },
    }))
  }

  function onSave() {
    save.mutate(
      { path: props, body: { graph } },
      {
        onSuccess: () => {
          setSavedSignature(signature)
        },
        onError: (error) => {
          /*
            The server's message, verbatim.

            `validateGraph` names the node it objected to and explains why — "two triggers", "a
            cycle through `notify`", "`cleanup` is unreachable". Replacing that with "Could not
            save" throws away the only part that helps.
          */
          const detail = error as { error?: { message?: string } } | undefined
          setProblem({
            signature,
            message: detail?.error?.message ?? "The graph could not be saved",
          })
        },
      },
    )
  }

  /*
    Not `PageBody`: it applies the standard page padding, and the canvas has to reach the edges or
    the viewport is a box floating inside another box. The rest of its layout — the min-height-zero
    flex column that lets a child scroll — is reproduced here.
  */
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <Select
          items={NODE_KINDS.map((kind) => ({ label: kind.label, value: kind.type }))}
          value={addType}
          onValueChange={(value) => {
            setAddType(String(value ?? NODE_KINDS[0].type))
          }}
        >
          <SelectTrigger className="w-48">
            <SelectValue>{(value) => NODE_LABELS[String(value)] ?? String(value)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {NODE_KINDS.map((kind) => (
              <SelectItem key={kind.type} value={kind.type}>
                {kind.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={addNode}>
          <PlusIcon className="size-4" />
          Add node
        </Button>
        <Button size="sm" variant="ghost" onClick={removeSelected} disabled={selectedId === null}>
          <Trash2Icon className="size-4" />
          Delete
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {props.version === null ? null : <Badge variant="outline">Version {props.version}</Badge>}
          {saved ? <span className="text-xs text-muted-foreground">Saved</span> : null}
          <Button size="sm" onClick={onSave} disabled={save.isPending || nodes.length === 0}>
            <SaveIcon className="size-4" />
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {currentProblem === null ? null : (
        <div className="px-5">
          <Alert variant="destructive">
            <AlertTitle>This graph cannot run</AlertTitle>
            <AlertDescription>{currentProblem}</AlertDescription>
          </Alert>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-[28rem] flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={({ nodes: picked }) => {
              setSelectedId(picked[0]?.id ?? null)
            }}
            fitView
            /*
              Capped at 1:1. `fitView` scales to fill the viewport, so a graph with one node zooms
              it to the size of the canvas — legible, and nothing like the density the rest of the
              product uses. Zooming *out* to fit a large graph is still what you want.
            */
            fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
            proOptions={{ hideAttribution: false }}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <aside className="w-72 shrink-0 overflow-y-auto border-l border-border p-4">
          {selected === undefined ? (
            <p className="text-sm text-muted-foreground">
              {nodes.length === 0
                ? "Add a trigger to start. Every workflow needs exactly one."
                : "Select a node to configure it."}
            </p>
          ) : (
            <NodePanel
              key={selected.id}
              name={(selected.data as WorkflowNodeData).name}
              kind={(selected.data as WorkflowNodeData).kind}
              config={config[selected.id] ?? {}}
              onRename={rename}
              onField={setField}
            />
          )}
        </aside>
      </div>
    </div>
  )
}

/**
 * A config value in a text input.
 *
 * `config` is `Record<string, unknown>` because it is the customer's, and an object put there by an
 * API client would render as `[object Object]` and then be *saved back* as that string. Anything
 * that is not a scalar shows empty rather than being quietly destroyed by the form.
 */
function asText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

function NodePanel(props: {
  name: string
  kind: string
  config: Record<string, unknown>
  onRename: (name: string) => void
  onField: (key: string, value: string) => void
}) {
  const fields = CONFIG_FIELDS[props.kind] ?? []

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="node-name">Name</Label>
        <Input
          id="node-name"
          value={props.name}
          onChange={(event) => {
            props.onRename(event.target.value)
          }}
          className="mt-1"
        />
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">{props.kind}</p>
      </div>

      {isTrigger(props.kind) ? (
        <p className="rule-soft rounded-md border px-2 py-1.5 text-xs text-muted-foreground">
          A trigger starts the workflow, so nothing can connect into it.
        </p>
      ) : null}

      {fields.map((field) => (
        <div key={field.key}>
          <Label htmlFor={`field-${field.key}`}>{field.label}</Label>
          <Input
            id={`field-${field.key}`}
            value={asText(props.config[field.key])}
            placeholder={field.placeholder}
            onChange={(event) => {
              props.onField(field.key, event.target.value)
            }}
            className="mt-1"
          />
        </div>
      ))}

      {fields.length === 0 && !isTrigger(props.kind) ? (
        <p className="text-xs text-muted-foreground">This node has nothing to configure yet.</p>
      ) : null}
    </div>
  )
}
