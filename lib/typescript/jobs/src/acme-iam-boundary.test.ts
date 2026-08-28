import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const compute = await readFile(new URL("../../../../tofu/compute.tf", import.meta.url), "utf8")
const ecs = await readFile(new URL("../../../../tofu/ecs.tf", import.meta.url), "utf8")
const ecsHostBootstrap = await readFile(
  new URL("../../../../tofu/ecs-host-bootstrap.sh", import.meta.url),
  "utf8",
)
const outputs = await readFile(new URL("../../../../tofu/outputs.tf", import.meta.url), "utf8")
const variables = await readFile(new URL("../../../../tofu/variables.tf", import.meta.url), "utf8")
const deploy = await readFile(new URL("../../../../tofu/DEPLOY.md", import.meta.url), "utf8")
const handoff = await readFile(
  new URL("../../../../bin/handoff-ecs-task-definitions.sh", import.meta.url),
  "utf8",
)
const planGuard = await readFile(
  new URL("../../../../bin/check-acme-worker-rollout-plan.sh", import.meta.url),
  "utf8",
)

function resourceFrom(source: string, type: string, name: string): string {
  const marker = `resource "${type}" "${name}"`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`Missing ${marker}`)
  const next = source.indexOf('\nresource "', start + marker.length)
  return source.slice(start, next < 0 ? undefined : next)
}

function resource(type: string, name: string): string {
  return resourceFrom(compute, type, name)
}

describe("tenant-edge IAM boundary", () => {
  it("retains legacy platform IAM only behind the explicit fallback gate", () => {
    const application = resource("aws_iam_policy", "application")
    expect(application).toContain(
      'description = "What the website, API and worker may do. Attached to the instance role and the task role."',
    )
    expect(application).toContain("var.acme_fallback_iam_enabled ?")
    expect(application).toContain("route53:ChangeResourceRecordSets")
    expect(application).not.toContain("aws_s3_bucket.tenant_certificates")
    const fallbackAttachment = resource("aws_iam_role_policy_attachment", "task_acme_worker")
    expect(fallbackAttachment).toContain("var.acme_fallback_iam_enabled ? 1 : 0")
    expect(fallbackAttachment).toContain("aws_iam_role.task.name")
    expect(compute).toContain("from = aws_iam_role_policy_attachment.task_acme_worker")
    expect(compute).toContain("to   = aws_iam_role_policy_attachment.task_acme_worker[0]")
    expect(resource("aws_iam_role_policy_attachment", "instance_application")).toContain(
      "aws_iam_policy.application.arn",
    )
  })

  it("gives the dedicated certificate task permanent ACME authority", () => {
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
    expect(ecs).toContain(
      '{ name = "ACME_HANDLER_OWNERSHIP_ENABLED", value = var.acme_handler_ownership_enabled ? "1" : "0" }',
    )
    const acmeTask = resourceFrom(ecs, "aws_ecs_task_definition", "acme_worker")
    expect(ecs).toContain("ecs_acme_worker_parameter_names = local.ecs_worker_base_parameter_names")
    expect(acmeTask).toContain("local.ecs_acme_worker_parameter_secrets")
    expect(acmeTask).not.toContain("APK_SIGNER")
    expect(acmeTask).not.toContain("ANDROID_DEVELOPER_ID_STATUS_API_KEY")
    expect(resourceFrom(ecs, "aws_iam_role_policy", "acme_execution_secrets")).toContain(
      "local.ecs_acme_parameter_arns",
    )
    expect(ecs).not.toContain("local.ecs_worker_parameter_names")
  })

  it("keeps private-key reads on a router-only instance role", () => {
    const reader = resource("aws_iam_policy", "router_certificate_read")
    expect(reader).toContain("s3:GetObjectVersion")
    expect(reader).toContain("aws_s3_bucket.tenant_certificates")
    expect(
      resource("aws_iam_role_policy_attachment", "router_instance_certificate_read"),
    ).toContain("aws_iam_role.router_instance.name")
    expect(resource("aws_iam_instance_profile", "router")).toContain(
      "aws_iam_role.router_instance.name",
    )
    expect(compute.match(/aws_iam_policy\.router_certificate_read\.arn/g)).toHaveLength(1)
    expect(resource("aws_iam_role_policy_attachment", "instance_application")).not.toContain(
      "router_certificate_read",
    )
    expect(resource("aws_iam_role_policy_attachment", "task_application")).not.toContain(
      "router_certificate_read",
    )
    expect(resource("aws_launch_template", "service")).toContain(
      'each.key == "router" ? aws_iam_instance_profile.router.arn : aws_iam_instance_profile.instance.arn',
    )
  })

  it("blocks bridge-networked ECS tasks from the host credential endpoint", () => {
    expect(ecs).toContain('http_protocol_ipv6 = "disabled"')
    expect(ecs).toContain('file("${path.module}/ecs-host-bootstrap.sh")')
    expect(ecsHostBootstrap).toContain(
      "/usr/sbin/iptables -w 10 -C DOCKER-USER -i docker+ -d 169.254.169.254/32 -j DROP",
    )
    expect(ecsHostBootstrap).toContain(
      "/usr/sbin/iptables -w 10 -I DOCKER-USER 1 -i docker+ -d 169.254.169.254/32 -j DROP",
    )
    expect(ecsHostBootstrap).toContain(
      "ExecStartPost=/usr/local/sbin/sproutos-block-container-imds",
    )
    expect(ecsHostBootstrap).toContain("systemctl restart docker")
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
    expect(ecs).toContain('field = "attribute:ecs.availability-zone"')
    expect(ecs).toContain('type  = "binpack"')
    expect(ecs).toContain('field = "memory"')
    expect(ecs).toContain('type = "distinctInstance"')
    expect(ecs).toContain('availability_zone_rebalancing      = "ENABLED"')
    expect(ecs).toContain("deployment_maximum_percent         = 150")
    expect(ecs).toContain("deployment_minimum_healthy_percent = 100")
    const acmeTaskStart = ecs.indexOf('resource "aws_ecs_task_definition" "acme_worker"')
    const acmeTaskEnd = ecs.indexOf('resource "aws_cloudwatch_log_group" "ecs"', acmeTaskStart)
    const acmeTask = ecs.slice(acmeTaskStart, acmeTaskEnd)
    expect(acmeTask).toContain("requires_compatibilities = []")
    expect(acmeTask).toContain("enable_fault_injection   = false")
    expect(acmeTask).toContain("portMappings      = []")
    expect(acmeTask).toContain("mountPoints       = []")
    expect(acmeTask).toContain("systemControls    = []")
    expect(acmeTask).toContain("volumesFrom       = []")
  })

  it("hands both exact applied task contracts to the release before rollout continues", () => {
    expect(outputs).toContain('output "ecs_web_task_definition_arn"')
    expect(outputs).toContain('output "ecs_acme_worker_task_definition_arn"')
    expect(outputs).toContain('output "acme_worker_rollout_state"')
    expect(handoff).toContain('ECS_BASE_TASK_DEFINITION="$web_task_arn"')
    expect(handoff).toContain('ECS_BASE_ACME_TASK_DEFINITION="$acme_task_arn"')
    expect(handoff).toContain('"$DEPLOY_SCRIPT"')
    expect(deploy).toContain("bin/handoff-ecs-task-definitions.sh")
    expect(deploy).toContain("ACME_JOBS_ENABLED")
    expect(deploy).toContain("ACME_HANDLER_OWNERSHIP_ENABLED")
    expect(deploy).toContain("wait explicitly for two healthy isolated tasks before any handoff")
    expect(deploy).toContain("`ACME_JOBS_ENABLED=1`")
    expect(deploy).toContain("ACME_DIRECTORY_URL")
    expect(deploy).toContain("PLATFORM_EDGE_ROLLOUT_ENABLED")
    expect(deploy).toContain("CUSTOM_DOMAINS_ENABLED")
  })

  it("makes zero-owner and platform-owner-without-IAM plans invalid", () => {
    const ownership = variables.slice(
      variables.indexOf('variable "acme_handler_ownership_enabled"'),
      variables.indexOf('variable "custom_domain_issuance_enabled"'),
    )
    expect(ownership).toContain("!var.acme_handler_ownership_enabled || var.acme_worker_enabled")
    expect(ownership).toContain(
      "var.acme_fallback_iam_enabled || var.acme_handler_ownership_enabled",
    )
    expect(handoff).toContain("refusing zero-owner handoff")
    expect(handoff).toContain("refusing no-IAM handoff")
    expect(planGuard).toContain("saved plan has zero owners")
    expect(planGuard).toContain("saved plan removes fallback IAM")
    expect(planGuard).toContain("saved plan replaces aws_iam_policy.application")
  })
})
