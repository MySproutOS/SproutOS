import { readFileSync } from "node:fs"
import { globSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  findPlaceholders,
  render,
  UnknownValueError,
  UnsubstitutedPlaceholderError,
} from "./render"

/** For embedding a path in a regular expression without it being read as one. */
function escape(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

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
      "image: ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/sproutos/website:${TAG}",
      COMPLETE,
    )
    expect(rendered).toBe(
      "image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/sproutos/website:sha-abc123",
    )
  })

  it("refuses to return a manifest with a placeholder still in it", () => {
    /*
      The whole reason this is a module rather than a `sed` invocation.

      `image: ${ACCOUNT}.dkr.ecr...` is valid YAML. It passes kubeconform, applies cleanly, and
      fails at image pull — in production, minutes later, as a CrashLoopBackOff whose cause is three
      steps removed from its symptom.
    */
    expect(() =>
      render("image: ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/x:${TAG}", {
        REGION: "eu-west-1",
      }),
    ).toThrow(UnsubstitutedPlaceholderError)
  })

  it("names which placeholders were missed", () => {
    // `toThrowError` with a matcher rather than try/catch: a conditional `expect` passes when the
    // call unexpectedly succeeds and the catch block never runs.
    expect(() => render("a: ${ACCOUNT} b: ${TAG}", { TAG: "v1" })).toThrow(
      // "Something was not substituted" sends someone hunting. Naming it does not.
      expect.objectContaining({ remaining: ["ACCOUNT"] }),
    )
  })

  it("rejects a value that matches no placeholder", () => {
    /*
      A typo in a value's name — `ACCOUNT_ID` for `ACCOUNT` — would otherwise substitute nothing,
      leave `ACCOUNT` in place, and be caught by the check above with a confusing message. Caught
      here, the message says what is actually wrong.
    */
    expect(() => render("a: ${ACCOUNT}", { ACCOUNT_ID: "1" } as never)).toThrow(UnknownValueError)
  })

  it("substitutes longest-first, so one placeholder cannot eat another's prefix", () => {
    /*
      Kept after the move to `${…}` delimiters made it redundant, because it is where the hazard is
      written down. Before the delimiters this ordering was the *only* defence, and it was not
      enough: `REGION` is a substring of `AWS_REGION`, which is not a placeholder at all, so nothing
      longer ever matched it and the environment variable's own name rendered as `AWS_us-central1`.
    */
    const rendered = render(
      "a: ${ACCOUNT} b: ${ACCOUNT_ID}",
      { ACCOUNT: "111", ACCOUNT_ID: "222" } as never,
      ["ACCOUNT", "ACCOUNT_ID"],
    )
    expect(rendered).toBe("a: 111 b: 222")
  })

  /*
    The two ways bare-word substitution corrupted a manifest, asserted so they cannot come back.

    Both of these produced valid YAML that applied cleanly and started pods missing the variables
    they needed. The website could not scope its session cookie, and every GitHub sign-in failed
    silently at the last step — after the user had already authorized.
  */
  it("does not substitute a placeholder that is a substring of an unrelated word", () => {
    expect(render("- name: AWS_REGION\n  value: ${REGION}", { REGION: "us-east-1" })).toBe(
      "- name: AWS_REGION\n  value: us-east-1",
    )
  })

  it("does not substitute an environment variable whose name equals a placeholder", () => {
    expect(
      render("- name: SESSION_COOKIE_DOMAIN\n  value: ${SESSION_COOKIE_DOMAIN}", {
        SESSION_COOKIE_DOMAIN: ".example.com",
      }),
    ).toBe("- name: SESSION_COOKIE_DOMAIN\n  value: .example.com")
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
      // The path goes in the failure message by rendering it into the assertion, because `expect`
      // takes no second argument.
      expect(() => render(contents, COMPLETE)).not.toThrow(new RegExp(escape(relative)))
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
