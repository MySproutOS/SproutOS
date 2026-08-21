import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/*
  Every request this client makes has to go through the CA-aware path.

  The API server presents a certificate signed by the cluster's own CA, which is not in Node's
  default trust store and never will be. `inClusterConfig` has always read that CA into
  `certificateAuthority`; the client ignored it, so every call from inside a pod failed
  `unable to verify the first certificate`.

  The first version of the fix converted `request` and left `logs` on global `fetch` — the formatter
  had reflowed those lines between the patch being written and applied, the replacement silently
  matched nothing, and the result was a client that worked until the one call that reads a sandbox's
  output.

  Asserted against the source, because the property is "no code path uses `fetch`" and no runtime
  observation covers a branch that was not taken.
*/
describe("the kube client's transport", () => {
  const source = readFileSync(new URL("./kube.ts", import.meta.url), "utf8")

  it("never calls global fetch, which cannot be given a certificate authority", () => {
    expect(source).not.toMatch(/\bfetch\(/)
  })

  it("uses the configured certificate authority", () => {
    expect(source).toMatch(/new Agent\(\{ ca: config\.certificateAuthority/)
  })

  it("was reading the CA all along, which is the part that makes this a bug rather than a gap", () => {
    expect(source).toMatch(/certificateAuthority: readFileSync/)
  })
})
