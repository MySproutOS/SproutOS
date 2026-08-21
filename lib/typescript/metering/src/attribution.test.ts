import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { attributionLabels, ORGANIZATION_ID_LABEL, PROJECT_ID_LABEL } from "./attribution"

type Vector = {
  note: string
  labels: Record<string, string>
  organizationId: string | null
  projectId: string | null
}

function fixture(): { organizationId: string; projectId: string; cases: Vector[] } {
  const path = join(
    import.meta.dirname,
    "../../../rust/metering-proto/fixtures/attribution-labels.json",
  )
  return JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof fixture>
}

/*
  The other half of the contract `services/metering-agent` asserts.

  The agent's test proves it reads these keys. This one proves the control plane writes them. Both
  passing is the only thing that makes a sample attributable — and until now the agent's half passed
  alone, against keys nothing produced.
*/
describe("attribution labels", () => {
  it("uses the key names the agent reads", () => {
    const vectors = fixture()
    expect(ORGANIZATION_ID_LABEL).toBe(vectors.organizationId)
    expect(PROJECT_ID_LABEL).toBe(vectors.projectId)
  })

  it("produces exactly the labels of every attributable vector", () => {
    const attributable = fixture().cases.filter((vector) => vector.organizationId !== null)
    expect(attributable.length).toBeGreaterThan(1)

    for (const vector of attributable) {
      const labels = attributionLabels(vector.organizationId!, vector.projectId ?? undefined)
      expect(labels).toEqual(vector.labels)
    }
  })

  /*
    A project-less workload carries no project label at all, rather than an empty one.

    `""` is a valid Kubernetes label value and would parse as a project id of empty string, which is
    not a project — the agent would treat the sample as belonging to a project that does not exist
    rather than to none.
  */
  it("omits the project label rather than emptying it", () => {
    expect(attributionLabels("01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f")).not.toHaveProperty(
      PROJECT_ID_LABEL,
    )
  })

  it("does not produce the key the control plane used to write", () => {
    const labels = attributionLabels(
      "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
      "01912d40-0000-7000-8000-0000000000a1",
    )
    expect(labels).not.toHaveProperty("sproutos.dev/project")
  })
})
