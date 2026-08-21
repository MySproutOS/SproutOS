import { describe, expect, it } from "vitest"
import {
  environmentDigest,
  environmentSecret,
  environmentSecretName,
  isDeliverableKey,
} from "./env"

const project = "01a01e12-1700-76ac-9713-dd208babdf5a"

describe("environmentSecretName", () => {
  it("changes when a value changes", () => {
    /*
      The property the whole design rests on. Knative cuts a new revision when the *pod spec*
      changes, and a Secret referenced by a fixed name is the same pod spec whatever is inside it —
      so a customer would set a value, see it saved, and watch their site go on using the old one
      until something unrelated forced a redeploy.
    */
    const before = environmentSecretName(project, [{ key: "API_URL", value: "one" }])
    const after = environmentSecretName(project, [{ key: "API_URL", value: "two" }])

    expect(after).not.toBe(before)
  })

  it("does not change when the same variables come back in a different order", () => {
    // Otherwise every deploy cuts a revision, because a query without a total order eventually
    // returns rows in a different one.
    expect(
      environmentSecretName(project, [
        { key: "B", value: "2" },
        { key: "A", value: "1" },
      ]),
    ).toBe(
      environmentSecretName(project, [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ]),
    )
  })

  it("distinguishes two environments a separator could have merged", () => {
    // `A=1,B=2` under any delimiter is also `A=1,B` plus `=2`. A customer whose value contains the
    // delimiter would otherwise share a Secret with a different environment — and get it.
    expect(environmentDigest([{ key: "A", value: "1,B=2" }])).not.toBe(
      environmentDigest([
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ]),
    )
  })

  it("is a name Kubernetes accepts", () => {
    // Object names are DNS subdomains: lowercase alphanumerics, `-` and `.`, 253 characters.
    const name = environmentSecretName(project, [{ key: "A", value: "1" }])

    expect(name).toMatch(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
    expect(name.length).toBeLessThanOrEqual(253)
  })

  it("gives two projects with identical environments different names", () => {
    // They share a namespace when they share an organization, and one would then read the other's.
    const other = "01a01e12-1700-76ac-9713-dd208bab0000"
    const entries = [{ key: "A", value: "1" }]

    expect(environmentSecretName(project, entries)).not.toBe(environmentSecretName(other, entries))
  })
})

describe("isDeliverableKey", () => {
  it("accepts what a Secret key may contain", () => {
    for (const key of ["DATABASE_URL", "port", "a.b", "a-b", "A1"]) {
      expect(isDeliverableKey(key)).toBe(true)
    }
  })

  it("refuses what the API server would reject the whole object for", () => {
    // And that is the point: one variable named with a space makes *every* variable undeliverable,
    // with a 422 on the Secret several steps from the variable that caused it.
    for (const key of ["has space", "curly{}", "", "a/b", "é"]) {
      expect(isDeliverableKey(key)).toBe(false)
    }
  })
})

describe("environmentSecret", () => {
  it("uses stringData, so nothing here encodes base64 twice", () => {
    const secret = environmentSecret(project, "tenant-x", [{ key: "A", value: "1" }])

    expect(secret.stringData).toEqual({ A: "1" })
    expect(secret).not.toHaveProperty("data")
  })

  it("labels itself with the project, so teardown can find it", () => {
    // The names are content-hashed and a project accumulates them, so the only way to collect a
    // deleted project's Secrets is a label selector.
    const secret = environmentSecret(project, "tenant-x", [{ key: "A", value: "1" }])

    expect(secret.metadata.labels["sproutos.dev/project"]).toBe(project)
  })
})
