import { readFileSync } from "node:fs"
import { globSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  findPlaceholders,
  PLACEHOLDERS,
  render,
  UnknownValueError,
  UnsubstitutedPlaceholderError,
} from "./render"

const COMPLETE = {
  ACCOUNT: "123456789012",
  REGION: "us-east-1",
  TAG: "sha-abc123",
  TENANT_NAMESPACE: "project-01j4pm",
  KMS_KEY_ARN: "arn:aws:kms:us-east-1:123456789012:key/abc",
  CONTROL_PLANE_DB_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:db",
  TENANT_POSTGRES_HOST: "tenant-db.internal",
  TENANT_VALKEY_HOST: "tenant-valkey.internal",
  TENANT_OPENSEARCH_HOST: "tenant-search.internal",
} as const

describe("render", () => {
  it("substitutes every placeholder", () => {
    const rendered = render(
      "image: ACCOUNT.dkr.ecr.REGION.amazonaws.com/sproutos/website:TAG",
      COMPLETE,
    )
    expect(rendered).toBe(
      "image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/sproutos/website:sha-abc123",
    )
  })

  it("refuses to return a manifest with a placeholder still in it", () => {
    /*
      The whole reason this is a module rather than a `sed` invocation.

      `image: ACCOUNT.dkr.ecr...` is valid YAML. It passes kubeconform, applies cleanly, and fails
      at image pull — in production, minutes later, as a CrashLoopBackOff whose cause is three steps
      removed from its symptom.
    */
    expect(() =>
      render("image: ACCOUNT.dkr.ecr.REGION.amazonaws.com/x:TAG", { REGION: "eu-west-1" }),
    ).toThrow(UnsubstitutedPlaceholderError)
  })

  it("names which placeholders were missed", () => {
    try {
      render("a: ACCOUNT b: TAG", { TAG: "v1" })
      expect.unreachable("should have thrown")
    } catch (error) {
      // "Something was not substituted" sends someone hunting. Naming it does not.
      expect((error as UnsubstitutedPlaceholderError).remaining).toEqual(["ACCOUNT"])
    }
  })

  it("rejects a value that matches no placeholder", () => {
    /*
      A typo in a value's name — `ACCOUNT_ID` for `ACCOUNT` — would otherwise substitute nothing,
      leave `ACCOUNT` in place, and be caught by the check above with a confusing message. Caught
      here, the message says what is actually wrong.
    */
    expect(() => render("a: ACCOUNT", { ACCOUNT_ID: "1" } as never)).toThrow(UnknownValueError)
  })

  it("substitutes longest-first, so one placeholder cannot eat another's prefix", () => {
    /*
      Tested with a synthetic pair, because no real placeholder is a prefix of another — so the real
      list cannot demonstrate the hazard, and the first version of this test asserted only that
      `sort` sorts. It passed with the ordering removed from `render` entirely.

      The hazard is real the day somebody adds `ACCOUNT_ID`: replacing in declaration order turns it
      into `123456789012_ID`, which is valid YAML, wrong, and silent.
    */
    const rendered = render(
      "a: ACCOUNT b: ACCOUNT_ID",
      { ACCOUNT: "111", ACCOUNT_ID: "222" } as never,
      ["ACCOUNT", "ACCOUNT_ID"],
    )
    expect(rendered).toBe("a: 111 b: 222")
  })

  it("leaves a manifest with no placeholders untouched", () => {
    const plain = "apiVersion: v1\nkind: ConfigMap\n"
    expect(render(plain, COMPLETE)).toBe(plain)
  })
})

describe("the checked-in manifests", () => {
  const manifests = globSync("deploy/**/*.yaml", { cwd: `${import.meta.dirname}/../../../..` }).map(
    (relative) => ({
      relative,
      contents: readFileSync(`${import.meta.dirname}/../../../../${relative}`, "utf8"),
    }),
  )

  it("were found at all", () => {
    // A glob that matches nothing would make every assertion below vacuously true — which is the
    // shape of half the bugs found in this repo today.
    expect(manifests.length).toBeGreaterThan(4)
  })

  it("render completely with a full set of values", () => {
    /*
      This is the test that catches a placeholder added to a manifest and not to `PLACEHOLDERS`.

      Without it, a new `CLUSTER_NAME` in some future manifest renders to itself, passes every schema
      check, and is applied to a cluster as the literal string.
    */
    for (const { relative, contents } of manifests) {
      expect(() => render(contents, COMPLETE), relative).not.toThrow()
    }
  })

  it("still contain placeholders, so this is not testing nothing", () => {
    // If someone hard-codes an account id into a manifest, the tests above keep passing while the
    // repo quietly stops being deployable anywhere else. At least one file must still need
    // rendering.
    const withPlaceholders = manifests.filter(
      ({ contents }) => findPlaceholders(contents).length > 0,
    )
    expect(withPlaceholders.length).toBeGreaterThan(0)
  })
})
