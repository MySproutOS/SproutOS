import { describe, expect, it } from "vitest"
import { NODE_RUNTIME, needsSandbox, plannedSteps } from "./execute"
import { NODE_TYPES, type WorkflowGraph } from "./graph"

const graph = (nodes: WorkflowGraph["nodes"], edges: WorkflowGraph["edges"] = []) => ({
  nodes,
  edges,
})

const node = (id: string, type: (typeof NODE_TYPES)[number]) => ({
  id,
  type,
  name: id,
  config: {},
})

describe("NODE_RUNTIME", () => {
  it("covers every node type, so a new one cannot default to running in the worker", () => {
    // A `Record<NodeType, Runtime>` makes this a compile error too. Asserted at runtime as well
    // because the table is the security boundary and a cast would silence the compiler.
    //
    // Compared as a set so a failure names the missing type; vitest's matcher takes one argument,
    // so `expect(value, type)` cannot carry the label.
    expect(Object.keys(NODE_RUNTIME).sort()).toEqual([...NODE_TYPES].sort())
  })

  /*
    The four that must never run in the job worker.

    The worker holds the control-plane database URL, the envelope KMS key, the GitHub App
    credentials and a Kubernetes service account, and it is not under the tenant NetworkPolicy — so
    a customer-supplied URL fetched from there reaches the API server, another tenant's database,
    and the instance metadata service. Writing them out one by one rather than looping, so that
    moving one to "control-plane" has to be done deliberately, in this list, with this comment
    above it.
  */
  it("keeps customer-supplied destinations and code out of the control plane", () => {
    expect(NODE_RUNTIME["action.http"]).toBe("sandbox")
    expect(NODE_RUNTIME["action.code"]).toBe("sandbox")
    expect(NODE_RUNTIME["action.database"]).toBe("sandbox")
    expect(NODE_RUNTIME["action.email"]).toBe("sandbox")
  })

  it("allows the nodes that carry neither", () => {
    expect(NODE_RUNTIME["trigger.manual"]).toBe("control-plane")
    expect(NODE_RUNTIME["control.branch"]).toBe("control-plane")
    expect(NODE_RUNTIME["control.delay"]).toBe("control-plane")
  })
})

describe("plannedSteps", () => {
  it("orders steps so a node never precedes what it depends on", () => {
    const steps = plannedSteps(
      graph(
        [node("t", "trigger.manual"), node("a", "control.delay"), node("b", "control.branch")],
        [
          { from: "t", to: "a" },
          { from: "a", to: "b" },
        ],
      ),
    )
    expect(steps.map((step) => step.nodeId)).toEqual(["t", "a", "b"])
  })

  it("marks the trigger, which records what started the run rather than executing", () => {
    const steps = plannedSteps(graph([node("t", "trigger.webhook")]))
    expect(steps[0]?.isTrigger).toBe(true)
  })

  /*
    The step has to carry what the node was configured with.

    It did not: `stepRowsFor` wrote `{}` and a sandboxed `action.http` was handed no url — for a
    node whose graph had one. Copied onto the step rather than read back through the version, so a
    graph edited after a failed run cannot rewrite why it failed.
  */
  it("carries each node's config, which is what the sandbox runs on", () => {
    const steps = plannedSteps(
      graph(
        [
          node("t", "trigger.manual"),
          { ...node("h", "action.http"), config: { url: "https://example.com/" } },
        ],
        [{ from: "t", to: "h" }],
      ),
    )
    expect(steps.find((step) => step.nodeId === "h")?.config).toEqual({
      url: "https://example.com/",
    })
  })

  it("carries each node's runtime, which is what the executor refuses on", () => {
    const steps = plannedSteps(
      graph([node("t", "trigger.manual"), node("h", "action.http")], [{ from: "t", to: "h" }]),
    )
    expect(steps.map((step) => step.runtime)).toEqual(["control-plane", "sandbox"])
  })
})

describe("needsSandbox", () => {
  it("is true for any graph that does real work", () => {
    expect(needsSandbox(graph([node("t", "trigger.manual"), node("h", "action.http")]))).toBe(true)
  })

  it("is false for a graph of pure control flow", () => {
    expect(needsSandbox(graph([node("t", "trigger.manual"), node("d", "control.delay")]))).toBe(
      false,
    )
  })
})
