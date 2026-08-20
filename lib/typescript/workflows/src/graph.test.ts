import { describe, expect, it } from "vitest"
import {
  hashGraph,
  InvalidGraphError,
  topologicalOrder,
  validateGraph,
  type WorkflowGraph,
} from "./graph"

/** Run something that must throw, and hand back the error to assert on unconditionally. */
function caught(body: () => void): InvalidGraphError {
  try {
    body()
  } catch (error) {
    if (error instanceof InvalidGraphError) return error
    throw error
  }
  throw new Error("expected the graph to be rejected")
}

function graph(overrides: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    nodes: [
      { id: "t", type: "trigger.manual", name: "Start", config: {} },
      { id: "a", type: "action.http", name: "Fetch", config: { url: "https://example.com" } },
      { id: "b", type: "action.email", name: "Notify", config: {} },
    ],
    edges: [
      { from: "t", to: "a" },
      { from: "a", to: "b" },
    ],
    ...overrides,
  }
}

describe("validateGraph", () => {
  it("accepts a graph that can actually run", () => {
    expect(() => {
      validateGraph(graph())
    }).not.toThrow()
  })

  it("insists on exactly one trigger", () => {
    // None: nothing starts it. Two: two entry points and no single answer to "what ran, and why".
    expect(() => {
      validateGraph(
        graph({ nodes: [{ id: "a", type: "action.http", name: "Fetch", config: {} }], edges: [] }),
      )
    }).toThrow(/needs a trigger/)

    expect(() => {
      validateGraph(
        graph({
          nodes: [
            { id: "t", type: "trigger.manual", name: "Start", config: {} },
            { id: "t2", type: "trigger.cron", name: "Nightly", config: {} },
          ],
          edges: [],
        }),
      )
    }).toThrow(/only have one trigger/)
  })

  it("refuses a cycle and says where it closes", () => {
    const cyclic = graph({
      edges: [
        { from: "t", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    })

    // The editor needs a node to highlight, which is why this is a DFS rather than "the
    // topological sort left some nodes over".
    const error = caught(() => {
      validateGraph(cyclic)
    })
    expect(error).toBeInstanceOf(InvalidGraphError)
    expect(error.nodeId).toBe("a")
  })

  it("calls a self-edge what it is", () => {
    // A cycle of length one. Reporting "there is a cycle" would be mysterious when the answer is
    // sitting right there.
    expect(() => {
      validateGraph(
        graph({
          edges: [
            { from: "t", to: "a" },
            { from: "a", to: "a" },
          ],
        }),
      )
    }).toThrow(/cannot connect to itself/)
  })

  it("refuses an edge leading back into the trigger", () => {
    expect(() => {
      validateGraph(
        graph({
          edges: [
            { from: "t", to: "a" },
            { from: "a", to: "t" },
          ],
        }),
      )
    }).toThrow(/back into the trigger/)
  })

  it("refuses a node the trigger cannot reach", () => {
    // A node the editor draws and the runner never executes is a lie about what the workflow
    // does, and it is invariably a disconnected edge someone meant to attach.
    const error = caught(() => {
      validateGraph(graph({ edges: [{ from: "t", to: "a" }] }))
    })
    expect(error.nodeId).toBe("b")
    expect(error.problem).toContain("not connected")
  })

  it("reports a dangling edge as a dangling edge, not as a structural mystery", () => {
    expect(() => {
      validateGraph(
        graph({
          edges: [
            { from: "t", to: "a" },
            { from: "a", to: "ghost" },
          ],
        }),
      )
    }).toThrow(/Edge to unknown node: ghost/)
  })

  it("refuses duplicate ids and unknown types", () => {
    expect(() => {
      validateGraph(
        graph({
          nodes: [
            { id: "t", type: "trigger.manual", name: "Start", config: {} },
            { id: "t", type: "action.http", name: "Clash", config: {} },
          ],
          edges: [],
        }),
      )
    }).toThrow(/Duplicate node id/)

    expect(() => {
      validateGraph(
        graph({
          nodes: [
            { id: "t", type: "trigger.manual", name: "Start", config: {} },
            // @ts-expect-error deliberately not a node type
            { id: "x", type: "action.mine_bitcoin", name: "Nope", config: {} },
          ],
          edges: [{ from: "t", to: "x" }],
        }),
      )
    }).toThrow(/Unknown node type/)
  })

  it("refuses an empty workflow", () => {
    expect(() => {
      validateGraph({ nodes: [], edges: [] })
    }).toThrow(/at least one node/)
  })
})

describe("topologicalOrder", () => {
  it("never runs a node before what it depends on", () => {
    expect(topologicalOrder(graph())).toEqual(["t", "a", "b"])
  })

  it("is stable when the graph allows several valid orders", () => {
    // A run's step order lands in a log a person compares across runs. "The same graph produced a
    // different order" is a bug report nobody can act on, so ties break on id.
    const diamond = graph({
      nodes: [
        { id: "t", type: "trigger.manual", name: "Start", config: {} },
        { id: "zebra", type: "action.http", name: "Z", config: {} },
        { id: "alpha", type: "action.http", name: "A", config: {} },
        { id: "join", type: "action.email", name: "Join", config: {} },
      ],
      edges: [
        { from: "t", to: "zebra" },
        { from: "t", to: "alpha" },
        { from: "zebra", to: "join" },
        { from: "alpha", to: "join" },
      ],
    })

    expect(topologicalOrder(diamond)).toEqual(["t", "alpha", "zebra", "join"])
    expect(topologicalOrder(diamond)).toEqual(topologicalOrder(diamond))
  })
})

describe("hashGraph", () => {
  it("ignores where the nodes sit on the canvas", async () => {
    // A version per nudge would make the history useless for the question it exists to answer:
    // what actually changed about what this runs.
    const moved = graph({
      nodes: graph().nodes.map((node) => ({ ...node, position: { x: 900, y: 40 } })),
    })
    expect(await hashGraph(moved)).toBe(await hashGraph(graph()))
  })

  it("ignores key order inside a node's config", async () => {
    const reordered = graph({
      nodes: [
        { id: "t", type: "trigger.manual", name: "Start", config: {} },
        {
          id: "a",
          type: "action.http",
          name: "Fetch",
          config: { method: "GET", url: "https://example.com" },
        },
        { id: "b", type: "action.email", name: "Notify", config: {} },
      ],
    })
    const other = graph({
      nodes: [
        { id: "t", type: "trigger.manual", name: "Start", config: {} },
        {
          id: "a",
          type: "action.http",
          name: "Fetch",
          config: { url: "https://example.com", method: "GET" },
        },
        { id: "b", type: "action.email", name: "Notify", config: {} },
      ],
    })
    expect(await hashGraph(reordered)).toBe(await hashGraph(other))
  })

  it("notices a change to what the workflow actually does", async () => {
    const changed = graph({
      nodes: graph().nodes.map((node) =>
        node.id === "a" ? { ...node, config: { url: "https://elsewhere.example" } } : node,
      ),
    })
    expect(await hashGraph(changed)).not.toBe(await hashGraph(graph()))
  })

  it("notices a rewired edge even when the nodes are identical", async () => {
    const rewired = graph({
      edges: [
        { from: "t", to: "b" },
        { from: "b", to: "a" },
      ],
    })
    expect(await hashGraph(rewired)).not.toBe(await hashGraph(graph()))
  })
})
