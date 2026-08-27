import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { BILLABLE_DIMENSIONS, isBillableDimension } from "./dimensions"
import { parseBatch } from "./parse"

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../rust/metering-proto/fixtures/billable-dimensions.json", import.meta.url),
    "utf8",
  ),
) as { dimensions: string[] }

const attributeKeys = JSON.parse(
  readFileSync(
    new URL("../../../rust/metering-proto/fixtures/attribute-key-vectors.json", import.meta.url),
    "utf8",
  ),
) as { valid: string[]; invalid: string[] }

function batchWithAttribute(key: string) {
  return {
    source: "test-meter",
    events: [
      {
        external_id: "event-1",
        organization_id: "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
        dimension: "site_request",
        quantity: 1,
        occurred_at: 1_723_459_200_000,
        attributes: { [key]: "value" },
      },
    ],
  }
}

describe("billable dimensions", () => {
  it("exactly matches the shared cross-language contract", () => {
    expect(BILLABLE_DIMENSIONS).toEqual(fixture.dimensions)
    expect(new Set(BILLABLE_DIMENSIONS).size).toBe(BILLABLE_DIMENSIONS.length)
  })

  it("narrows only current dimensions", () => {
    for (const dimension of fixture.dimensions) expect(isBillableDimension(dimension)).toBe(true)

    expect(isBillableDimension("site_vcpu_second")).toBe(false)
    expect(isBillableDimension("db_storage_gib_second")).toBe(false)
    expect(isBillableDimension(42)).toBe(false)
  })

  it("rejects an unknown wire dimension before it reaches a storage constraint", () => {
    const parsed = parseBatch({
      source: "test-meter",
      events: [
        {
          external_id: "event-1",
          organization_id: "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
          dimension: "db_storage_gib_second",
          quantity: 1,
          occurred_at: 1_723_459_200_000,
        },
      ],
    })

    expect(parsed).toEqual({
      ok: false,
      reason: "events[0]: dimension must be a current billable dimension",
    })
  })

  it("accepts exactly the shared attribute-key vocabulary", () => {
    for (const key of attributeKeys.valid) expect(parseBatch(batchWithAttribute(key)).ok).toBe(true)
    for (const key of attributeKeys.invalid) {
      expect(parseBatch(batchWithAttribute(key))).toEqual({
        ok: false,
        reason: "events[0]: attributes must be a flat string map with keys matching [a-z0-9._-]+",
      })
    }
  })
})
