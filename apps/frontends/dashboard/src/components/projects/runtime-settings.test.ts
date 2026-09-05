import { describe, expect, it } from "vitest"
import { compatibleRuntimes, preferredRuntime, type RuntimeEntry } from "./runtime-settings"

const entries = [
  {
    id: "nodejs24.x",
    language: "node",
    languageLabel: "Node.js",
    label: "Node.js 24",
    os: "Amazon Linux 2023",
    status: "recommended",
    selectable: true,
    deprecatedAt: new Date("2028-04-30"),
    selectionEndsAt: null,
    compatiblePresets: ["next", "hono", "web", "function"],
  },
  {
    id: "python3.14",
    language: "python",
    languageLabel: "Python",
    label: "Python 3.14",
    os: "Amazon Linux 2023",
    status: "recommended",
    selectable: true,
    deprecatedAt: new Date("2029-06-30"),
    selectionEndsAt: null,
    compatiblePresets: ["function"],
  },
  {
    id: "provided.al2023",
    language: "custom",
    languageLabel: "Custom",
    label: "Custom runtime (AL2023)",
    os: "Amazon Linux 2023",
    status: "recommended",
    selectable: true,
    deprecatedAt: new Date("2029-06-30"),
    selectionEndsAt: null,
    compatiblePresets: ["web", "function"],
  },
  {
    id: "nodejs20.x",
    language: "node",
    languageLabel: "Node.js",
    label: "Node.js 20",
    os: "Amazon Linux 2023",
    status: "deprecated",
    selectable: false,
    deprecatedAt: new Date("2026-04-30"),
    selectionEndsAt: null,
    compatiblePresets: ["next"],
  },
] satisfies RuntimeEntry[]

describe("runtime settings choices", () => {
  it("groups choices by language after preset and lifecycle filtering", () => {
    const choices = compatibleRuntimes(entries, "function")
    expect(choices.map((entry) => entry.id)).toEqual([
      "nodejs24.x",
      "python3.14",
      "provided.al2023",
    ])
    expect([...new Set(choices.map((entry) => entry.languageLabel))]).toEqual([
      "Node.js",
      "Python",
      "Custom",
    ])
  })

  it("uses the custom runtime for web, Node 24 for functions, and none for static targets", () => {
    expect(preferredRuntime(entries, "web")).toBe("provided.al2023")
    expect(preferredRuntime(entries, "function")).toBe("nodejs24.x")
    expect(preferredRuntime(entries, "static")).toBeNull()
  })
})
