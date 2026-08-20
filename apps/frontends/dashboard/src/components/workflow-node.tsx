import { Handle, Position, type NodeProps } from "@xyflow/react"
import { isTrigger, NODE_LABELS } from "@frontends/dashboard/data/workflow-graph"

export type WorkflowNodeData = {
  name: string
  kind: string
  invalid: boolean
}

/**
 * One node on the canvas.
 *
 * Styled from the design tokens rather than React Flow's stylesheet, so a node looks like the rest
 * of the product. The library's CSS is still imported — it positions the viewport and draws the
 * edge paths, which is the part worth having.
 *
 * A trigger has **no input handle**. `validateGraph` refuses an edge pointing at a trigger, so
 * offering a target a person can drag to would be offering a connection the save then rejects.
 * The shape of the node is the explanation.
 */
export function WorkflowNode({ data, selected }: NodeProps) {
  const node = data as WorkflowNodeData
  const trigger = isTrigger(node.kind)

  return (
    <div
      className={[
        "min-w-44 rounded-lg border bg-soil-800 px-3 py-2 shadow-sm transition-colors",

        selected ? "border-ring ring-3 ring-ring/20" : "border-border",
        node.invalid ? "border-destructive" : "",
      ].join(" ")}
    >
      {trigger ? null : (
        <Handle
          type="target"
          position={Position.Left}
          className="!size-2 !border-border !bg-muted"
        />
      )}
      <p className="truncate text-[13px] leading-tight font-medium text-foreground">{node.name}</p>
      <p className="truncate font-mono text-[11px] text-muted-foreground">
        {NODE_LABELS[node.kind] ?? node.kind}
      </p>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2 !border-border !bg-muted"
      />
    </div>
  )
}
