import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const compute = await readFile(new URL("../../../../tofu/compute.tf", import.meta.url), "utf8")
const ecs = await readFile(new URL("../../../../tofu/ecs.tf", import.meta.url), "utf8")

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
    expect(resource("aws_iam_policy", "application")).not.toContain(
      "aws_s3_bucket.tenant_certificates",
    )
    expect(resource("aws_iam_role_policy_attachment", "instance_application")).toContain(
      "aws_iam_policy.application.arn",
    )
  })

  it("attaches ACME authority only to the dedicated certificate task role", () => {
    expect(resource("aws_iam_policy", "control_plane_dns")).toContain(
      "route53:ChangeResourceRecordSets",
    )
    expect(resource("aws_iam_role_policy_attachment", "acme_task_control_plane_dns")).toContain(
      "aws_iam_role.acme_task.name",
    )
    expect(resource("aws_iam_role_policy_attachment", "acme_task_control_plane_dns")).not.toContain(
      "aws_iam_role.task.name",
    )
    const deploymentDns = resource("aws_iam_policy", "control_plane_dns")
    expect(deploymentDns).toContain("route53:ChangeResourceRecordSetsNormalizedRecordNames")
    expect(deploymentDns).toContain('["*.${var.tenant_domain}"]')
    expect(deploymentDns).toContain('["A", "AAAA"]')
    expect(resource("aws_iam_policy", "acme_worker")).toContain("route53:ChangeResourceRecordSets")
    expect(resource("aws_iam_policy", "acme_worker")).toContain("s3:ListBucketVersions")
    expect(resource("aws_iam_role_policy_attachment", "acme_task_worker")).toContain(
      "aws_iam_role.acme_task.name",
    )
    expect(resource("aws_iam_role_policy_attachment", "task_application")).toContain(
      "aws_iam_role.task.name",
    )
    expect(resource("aws_iam_role_policy_attachment", "task_application")).not.toContain(
      "aws_iam_role.acme_task.name",
    )
    expect(compute).not.toContain(
      'resource "aws_iam_role_policy_attachment" "instance_acme_worker"',
    )
    expect(ecs).toContain("task_role_arn      = aws_iam_role.acme_task.arn")
    expect(ecs).toContain('{ name = "WORKER_PROFILE", value = "acme" }')
    expect(ecs).toContain("var.acme_worker_enabled ? var.ecs_instance_count : 0")
    expect(ecs).toContain("local.ecs_worker_parameter_names")
  })

  it("keeps private-key reads on router instances rather than the public ECS task role", () => {
    const reader = resource("aws_iam_policy", "router_certificate_read")
    expect(reader).toContain("s3:GetObjectVersion")
    expect(reader).toContain("aws_s3_bucket.tenant_certificates")
    expect(
      resource("aws_iam_role_policy_attachment", "instance_router_certificate_read"),
    ).toContain("aws_iam_role.instance.name")
    expect(resource("aws_iam_role_policy_attachment", "task_application")).not.toContain(
      "router_certificate_read",
    )
  })

  it("limits Route 53 writes to the two exact ACME TXT names", () => {
    const policy = resource("aws_iam_policy", "acme_worker")
    expect(policy).toContain("route53:ChangeResourceRecordSetsNormalizedRecordNames")
    expect(policy).toContain('"_acme-challenge.${var.tenant_domain}"')
    expect(policy).toContain(
      '"_acme-challenge.${var.egress_subdomain}.${var.control_plane_domain}"',
    )
    expect(policy).toContain('"route53:ChangeResourceRecordSetsRecordTypes"')
    expect(policy).toContain('["TXT"]')
    expect(policy).toContain('"route53:ChangeResourceRecordSetsActions"')
    expect(policy).not.toContain('"A", "AAAA"')
  })

  it("fits the measured worker beside the bounded web task on one registered host", () => {
    expect(ecs).toContain("memory = 640")
    expect(ecs).toContain("memory = 256")
    expect(ecs).toContain("memoryReservation = 192")
    expect(ecs).toContain('type  = "binpack"')
    expect(ecs).toContain('field = "memory"')
  })
})
