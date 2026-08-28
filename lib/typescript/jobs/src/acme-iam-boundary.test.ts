import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const compute = await readFile(new URL("../../../../tofu/compute.tf", import.meta.url), "utf8")

function resource(type: string, name: string): string {
  const marker = `resource "${type}" "${name}"`
  const start = compute.indexOf(marker)
  if (start < 0) throw new Error(`Missing ${marker}`)
  const next = compute.indexOf('\nresource "', start + marker.length)
  return compute.slice(start, next < 0 ? undefined : next)
}

describe("tenant-edge IAM boundary", () => {
  it("never gives the public router's shared application policy Route 53 mutation", () => {
    expect(resource("aws_iam_policy", "application")).not.toContain(
      "route53:ChangeResourceRecordSets",
    )
    expect(resource("aws_iam_role_policy_attachment", "instance_application")).toContain(
      "aws_iam_policy.application.arn",
    )
  })

  it("attaches static and ACME DNS mutation only to the ECS control-plane task role", () => {
    expect(resource("aws_iam_policy", "control_plane_dns")).toContain(
      "route53:ChangeResourceRecordSets",
    )
    expect(resource("aws_iam_role_policy_attachment", "task_control_plane_dns")).toContain(
      "aws_iam_role.task.name",
    )
    expect(resource("aws_iam_policy", "acme_worker")).toContain("route53:ChangeResourceRecordSets")
    expect(resource("aws_iam_role_policy_attachment", "task_acme_worker")).toContain(
      "aws_iam_role.task.name",
    )
    expect(compute).not.toContain(
      'resource "aws_iam_role_policy_attachment" "instance_acme_worker"',
    )
  })
})
