/**
 * The website, the API and the background worker share one image and task. The existing background
 * worker owns ACME scheduling and handlers; its database leases keep work single-owner across
 * replicas. The dormant acme-worker task definition and zero-scaled service remain only so an
 * ordinary apply converges the resources created by the abandoned isolated-worker rollout.
 *
 * ## Why ECS on EC2 and not Fargate
 *
 * Fargate is not in the free tier at all — it bills per vCPU-second and GB-second from the first
 * task. ECS on the EC2 launch type charges nothing for the control plane; the only cost is the
 * instances, which this account already runs and which the free tier covers.
 *
 * ## Why two instances
 *
 * One instance made the website and API unavailable whenever that host or availability zone was
 * unhealthy. Two replicas run on distinct instances and are spread across the two serving zones.
 * A third instance is reserved only for a sequential rolling replacement, so a release never has
 * to stop either healthy replica before its replacement passes both load-balancer health checks.
 *
 * ## Why bridge networking
 *
 * `awsvpc` gives every task its own network interface, which is the better model — per-task
 * security groups, no port juggling. A `t4g.micro` supports **two** network interfaces and one is
 * the instance's own, so `awsvpc` means exactly one task per instance and the worker could never
 * share a box with the website. `bridge` has no such ceiling. The cost is that security groups are
 * per-instance rather than per-task, which is tolerable here because both ports are reachable only
 * from the load balancer either way.
 */

locals {
  # This is the database that already exists on the production OVH ClickHouse server. Keep one
  # value for every immutable control-plane container: a task can pass ECS health checks while
  # failing every log query later if this drifts from the server-side database name.
  ecs_clickhouse_database = "sproutos"

  # The EC2 release loaded this allowlist from Parameter Store at boot. Moving the same processes
  # into ECS without carrying the allowlist forward produced containers that were healthy at the
  # load balancer while every credential-backed operation failed at its point of use. Keep the
  # names explicit: an unrelated parameter added under the application path must not silently
  # become available to every container.
  ecs_website_parameter_names = [
    "GITHUB_OAUTH_CLIENT_ID",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GITHUB_APP_ID",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    # A release pointer, not a credential. It still comes through Parameter Store so a GitHub tag
    # workflow can promote an already-published, attested release without writing mutable version
    # text into an image or OpenTofu state. `bin/promote-cli-release.sh` is its only writer.
    "SPROUT_CLI_RELEASE_VERSION",
  ]

  # These parameters are intentionally absent until the Android custody rollout. A default
  # OpenTofu apply must remain able to register and launch an unrelated ECS task revision before
  # they exist; the later custody change supplies an explicit, preflighted enable plan. Keep this
  # independent of the Google registration credential: #192 needs these two tokens at API startup,
  # while registration can remain disabled until its separate external credential exists.
  ecs_android_api_parameter_names = var.android_custody_delivery_enabled ? [
    "APK_SIGNER_OPERATOR_TOKEN",
    "APK_SIGNER_TOKEN",
  ] : []

  ecs_api_parameter_names = [
    "CLICKHOUSE_PASSWORD",
    "DAYTONA_API_KEY",
    "DAYTONA_ORGANIZATION_ID",
    "DEPLOY_TOKEN_SECRET",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "KAFKA_BROKERS",
    "KAFKA_USAGE_EVENT_SASL_PASSWORD",
    "KAFKA_USAGE_EVENT_SASL_USERNAME",
    "LLM_PROXY_SECRET",
    "LOG_TOKEN_SECRET",
    "METERING_INGEST_HMAC_KEY",
    "NEON_API_KEY",
    "NEON_ORG_ID",
    "OPENAI_KEY",
    "SANDBOX_DAYTONA_SNAPSHOT",
    "SANDBOX_FORWARD_PROXY_ROOT_KEY",
    "SERVICE_OBJECT_STORAGE_ROOT_KEY",
    "SERVICE_VALKEY_ADMIN_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]

  ecs_android_worker_parameter_names = var.android_developer_registration_delivery_enabled ? [
    "ANDROID_DEVELOPER_ID_STATUS_API_KEY",
  ] : []

  ecs_worker_base_parameter_names = [
    "CLICKHOUSE_PASSWORD",
    "DAYTONA_API_KEY",
    "DAYTONA_ORGANIZATION_ID",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "KAFKA_BROKERS",
    "KAFKA_USAGE_EVENT_SASL_PASSWORD",
    "KAFKA_USAGE_EVENT_SASL_USERNAME",
    "LLM_PROXY_SECRET",
    "LOG_EXTENSION_CANARY_PROJECT_IDS",
    "LOG_EXTENSION_LAYER_ARN",
    "LOG_TOKEN_SECRET",
    "NEON_API_KEY",
    "NEON_ORG_ID",
    "OPENAI_KEY",
    "SANDBOX_DAYTONA_SNAPSHOT",
    "SANDBOX_FORWARD_PROXY_ROOT_KEY",
    "SEARCH_ADMIN_PASSWORD",
    "SEARCH_ADMIN_USER",
    "SEARCH_PROXY_SECURITY_ROOT_KEY",
    "SERVICE_OBJECT_STORAGE_ROOT_KEY",
    "SERVICE_VALKEY_ADMIN_URL",
    "VALKEY_PROXY_ACL_ROOT_KEY",
  ]

  ecs_acme_worker_parameter_names = concat(local.ecs_worker_base_parameter_names, [
    # The privileged nonpayment teardown performs the final configured auto-reload before it may
    # destroy provider data.
    "STRIPE_SECRET_KEY",
  ])

  ecs_website_parameter_secrets = [for name in local.ecs_website_parameter_names : {
    name      = name
    valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.application_parameter_path}/${name}"
  }]
  ecs_api_parameter_secrets = concat(
    [for name in local.ecs_api_parameter_names : {
      name      = name
      valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.application_parameter_path}/${name}"
    }],
    [for name in local.ecs_android_api_parameter_names : {
      name      = name
      valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.android_custody_parameter_path}/${name}"
    }],
  )
  ecs_worker_parameter_secrets = concat(
    [for name in local.ecs_worker_base_parameter_names : {
      name      = name
      valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.application_parameter_path}/${name}"
    }],
    [for name in local.ecs_android_worker_parameter_names : {
      name      = name
      valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.android_worker_parameter_path}/${name}"
    }],
  )
  ecs_acme_worker_parameter_secrets = [for name in local.ecs_acme_worker_parameter_names : {
    name      = name
    valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.application_parameter_path}/${name}"
  }]

  ecs_web_parameter_arns = toset(concat(
    [for secret in local.ecs_website_parameter_secrets : secret.valueFrom],
    [for secret in local.ecs_api_parameter_secrets : secret.valueFrom],
    [for secret in local.ecs_worker_parameter_secrets : secret.valueFrom],
  ))
  ecs_acme_parameter_arns = toset([
    for secret in local.ecs_acme_worker_parameter_secrets : secret.valueFrom
  ])

  # Every container in one ECS task receives the same task-role credentials. Keep this deny as
  # data so the staging test can evaluate its exact AWS IAM surface without contacting AWS.
  ecs_task_parameter_store_deny_actions = [
    "ssm:GetParameter",
    "ssm:GetParameters",
    "ssm:GetParametersByPath",
  ]
  ecs_task_parameter_store_deny_resources = concat(
    local.application_parameter_arns,
    local.android_custody_parameter_arns,
    local.android_worker_parameter_arns,
  )
}

resource "aws_ecs_cluster" "main" {
  name = var.name_prefix

  setting {
    # Off. RunningTaskCount requires paid Container Insights. The two ALB target groups are the
    # customer-visible task count, and the ASG publishes its in-service host count without it.
    name  = "containerInsights"
    value = "disabled"
  }

  tags = local.tags
}

/*
  Capacity, and what happens when there is not enough of it.

  `managed_scaling` lets ECS grow the Auto Scaling group when a replacement task cannot be placed.
  The maximum is exactly one host above the two-host steady state. The ECS service also admits only
  one extra task at a time, so that host is sufficient and capacity cannot grow without bound.

  `managed_termination_protection` is off because it requires scale-in protection on the group and
  the group here is small enough that ECS draining a task is the only ordering that matters.
*/
resource "aws_ecs_capacity_provider" "main" {
  name = "${var.name_prefix}-ec2"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.ecs.arn
    managed_termination_protection = "DISABLED"

    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 1
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = [aws_ecs_capacity_provider.main.name]

  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.main.name
    weight            = 100
  }
}

# The ECS-optimised image for arm64, by SSM parameter rather than a pinned AMI id. An AMI id is
# region-specific and goes stale; this always resolves to the current one, and instances are
# replaced on a launch-template change anyway.
data "aws_ssm_parameter" "ecs_arm64" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id"
}

resource "aws_launch_template" "ecs" {
  name_prefix   = "${var.name_prefix}-ecs-"
  image_id      = data.aws_ssm_parameter.ecs_arm64.value
  instance_type = var.service_instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.instance.arn
  }

  vpc_security_group_ids = [aws_security_group.service.id]

  metadata_options {
    http_tokens        = "required"
    http_protocol_ipv6 = "disabled"
    # Two hops, not one: the ECS agent runs in a container and its request to the metadata service
    # crosses a network namespace, which counts as a hop. At one, the agent cannot read the
    # instance's credentials and the instance never joins the cluster — with no error that mentions
    # the metadata service.
    http_put_response_hop_limit = 2
  }

  # Plugin execution needs a reviewed Docker seccomp profile before this host may join ECS. The
  # bootstrap pins the exact AL2023 Docker/runc builds used to materialize the profile and leaves
  # ECS stopped on any drift or validation failure.
  # EC2 enforces its 16 KiB user-data limit after base64 decoding. The embedded, integrity-checked
  # bootstrap and seccomp profile exceed that uncompressed; cloud-init detects gzip user data and
  # expands it before executing the script.
  user_data = base64gzip(<<-EOT
    #!/usr/bin/env bash
    set -euo pipefail
    install -d -m 0755 /usr/local/sbin
    printf '%s' '${base64encode(file("${path.module}/ecs-host-bootstrap.sh"))}' \
      | base64 --decode >/usr/local/sbin/sproutos-ecs-bootstrap
    printf '%s  %s\n' \
      '${filesha256("${path.module}/ecs-host-bootstrap.sh")}' \
      /usr/local/sbin/sproutos-ecs-bootstrap \
      | sha256sum --check --status
    chmod 0555 /usr/local/sbin/sproutos-ecs-bootstrap
    SPROUT_ECS_CLUSTER='${aws_ecs_cluster.main.name}' \
    SPROUT_SECCOMP_PROFILE_B64='${base64encode(file("${path.module}/ecs-seccomp-profile.json"))}' \
    SPROUT_SECCOMP_PROFILE_SHA256='${filesha256("${path.module}/ecs-seccomp-profile.json")}' \
    SPROUT_DOCKER_RPM='docker-25.0.16-1.amzn2023.0.4.aarch64' \
    SPROUT_RUNC_RPM='runc-1.3.5-1.amzn2023.0.2.aarch64' \
      /usr/local/sbin/sproutos-ecs-bootstrap
  EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.tags, { Name = "${var.name_prefix}-ecs" })
  }
}

resource "aws_autoscaling_group" "ecs" {
  name                = "${var.name_prefix}-ecs"
  vpc_zone_identifier = slice(aws_subnet.private[*].id, 0, local.serving_zone_count)

  min_size         = var.ecs_instance_count
  max_size         = var.ecs_instance_count + 1
  desired_capacity = var.ecs_instance_count

  # Auto Scaling group metrics are opt-in. Publish only the count this availability alarm uses.
  enabled_metrics     = ["GroupInServiceInstances"]
  metrics_granularity = "1Minute"

  launch_template {
    id      = aws_launch_template.ecs.id
    version = "$Latest"
  }

  # ECS manages this through the capacity provider; OpenTofu setting it too would fight the
  # autoscaler on every apply.
  lifecycle {
    ignore_changes = [desired_capacity]
  }

  # A launch-template revision changes the host boundary itself: AMI, bootstrap, Docker policy or
  # the template-plugin seccomp allowlist. Keep both serving hosts healthy while the reserved third
  # slot comes up, then replace the old hosts one at a time so a corrected boundary actually reaches
  # production instead of existing only in `$Latest`.
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 100
      max_healthy_percentage = 150
      instance_warmup        = 300
    }
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }

  tag {
    key                 = "Name"
    value               = "${var.name_prefix}-ecs"
    propagate_at_launch = true
  }
}

/*
  Application task definitions are release artifacts in deploy/ecs, rendered with an immutable
  image by GitHub Actions. OpenTofu owns the service and reads the latest registered revision only
  to bootstrap or repair the service pointer; it never registers application containers.
*/
removed {
  from = aws_ecs_task_definition.web

  lifecycle {
    destroy = false
  }
}

data "aws_ecs_task_definition" "web" {
  task_definition = "${var.name_prefix}-web"
}

locals {
  ecs_web_release_template = jsondecode(file("${path.module}/../deploy/ecs/web-task-definition.json"))
}

check "ecs_control_plane_container_isolation" {
  assert {
    condition = alltrue([
      for container in local.ecs_web_release_template.containerDefinitions :
      contains(container.dockerSecurityOptions, "no-new-privileges") &&
      contains(container.linuxParameters.capabilities.drop, "ALL")
    ])
    error_message = "Every ECS control-plane container must drop ALL capabilities and use no-new-privileges while the Docker seccomp exception is daemon-wide."
  }
}

/*
  Dormant compatibility definition for the abandoned isolated-worker rollout. Keeping it in state
  avoids mixing destructive cleanup into the tenant-edge cutover. The corresponding service is
  pinned at zero; certificate jobs run in the ordinary platform worker above.
*/
resource "aws_ecs_task_definition" "acme_worker" {
  family       = "${var.name_prefix}-acme-worker"
  network_mode = "bridge"
  # Match the explicit defaults returned by ECS, just like the web task above, so refreshing the
  # isolated task contract does not propose an identical replacement revision forever.
  requires_compatibilities = []
  enable_fault_injection   = false
  # A production-style bundle measured 139.4 MiB RSS before doing ACME work. 256 MiB leaves 84%
  # startup headroom and, together with the 640 MiB web task, fits within one registered host.
  memory = 256
  cpu    = 128

  depends_on = [
    aws_iam_role_policy_attachment.acme_execution,
    aws_iam_role_policy.acme_execution_secrets,
  ]
  execution_role_arn = aws_iam_role.acme_execution.arn
  task_role_arn      = aws_iam_role.acme_task.arn

  # This zero-scaled compatibility resource is intentionally inert. Application releases and edge
  # flags must not register new revisions for a worker that no longer runs.
  lifecycle {
    ignore_changes = [container_definitions]
  }

  container_definitions = jsonencode([{
    name              = "acme-worker"
    image             = var.web_image
    essential         = true
    memoryReservation = 192
    command           = ["node", "/opt/sproutos/api/worker.js"]
    portMappings      = []
    mountPoints       = []
    systemControls    = []
    volumesFrom       = []

    environment = concat([
      { name = "WORKER_PROFILE", value = "acme" },
      { name = "TENANT_CERTIFICATE_BUCKET", value = aws_s3_bucket.tenant_certificates.id },
      { name = "ACME_ACCOUNT_KEY_SECRET_ID", value = aws_secretsmanager_secret.acme_account_key.id },
      { name = "ACME_CONTACT_EMAIL", value = "acme@${var.control_plane_domain}" },
      { name = "ACME_DIRECTORY_URL", value = var.acme_directory_url },
      { name = "PLATFORM_EDGE_EGRESS_HOSTNAME", value = "${var.egress_subdomain}.${var.control_plane_domain}" },
      { name = "PLATFORM_ACME_TENANT_ZONE_ID", value = aws_route53_zone.tenant.zone_id },
      { name = "PLATFORM_ACME_EGRESS_ZONE_ID", value = data.aws_route53_zone.main.zone_id },
      # ASG names are a stable naming contract. Depending on the resources here would couple an
      # ACME task-contract correction to router launch-template and target-group rollout changes.
      { name = "PLATFORM_ROUTER_ASG_NAMES", value = join(",", [for colour in local.service_colours : "${var.name_prefix}-router-${colour}"]) },
      { name = "TENANT_CERTIFICATE_KMS_KEY_ARN", value = aws_kms_key.secrets.arn },
      { name = "PLATFORM_CERTIFICATE_OBJECT_KEY", value = "platform-edge/current.json" },
      { name = "PLATFORM_EDGE_ROLLOUT_ENABLED", value = var.tenant_edge_enabled || var.tenant_edge_preview_enabled ? "1" : "0" },
      ], [
      # The isolated worker also owns the four deployment/teardown handlers that mutate tenant DNS.
      # Carry the ordinary worker's complete runtime contract so moving the IAM boundary does not
      # turn static publication or project teardown into an environment-dependent failure.
      { name = "AWS_REGION", value = var.aws_region },
      { name = "AWS_ACCOUNT_ID", value = var.aws_account_id },
      { name = "TENANT_DOMAIN", value = var.tenant_domain },
      { name = "TENANT_STATIC_BUCKET", value = aws_s3_bucket.tenant_static.id },
      { name = "TENANT_STATIC_LOG_BUCKET", value = aws_s3_bucket.tenant_static_logs.id },
      { name = "TENANT_STATIC_LOG_PREFIX", value = "tenant-static/" },
      { name = "TENANT_ZONE_ID", value = aws_route53_zone.tenant.zone_id },
      { name = "TENANT_STATIC_DISTRIBUTION_DOMAIN", value = aws_cloudfront_distribution.tenant_static.domain_name },
      { name = "TENANT_STATIC_KEY_VALUE_STORE_ARN", value = aws_cloudfront_key_value_store.tenant_static.arn },
      { name = "TENANT_INGRESS_HOST", value = var.tenant_edge_enabled ? "ingress.${var.tenant_domain}" : "preview-ingress.${var.tenant_domain}" },
      { name = "SERVICE_BUILD_BUCKET", value = aws_s3_bucket.tenant_builds.id },
      { name = "LAMBDA_EXECUTION_ROLE_ARN", value = aws_iam_role.lambda_execution.arn },
      { name = "VALKEY_URL", value = "rediss://${aws_elasticache_replication_group.platform.primary_endpoint_address}:6379" },
      { name = "DATABASE_HOST", value = aws_db_instance.control_plane.endpoint },
      { name = "DATABASE_NAME", value = aws_db_instance.control_plane.db_name },
      { name = "CLICKHOUSE_URL", value = "https://${var.clickhouse_subdomain}.${var.control_plane_domain}" },
      { name = "CLICKHOUSE_DATABASE", value = local.ecs_clickhouse_database },
      { name = "CLICKHOUSE_USER", value = "sproutos" },
      { name = "KMS_KEY_ID", value = aws_kms_key.envelope.arn },
      { name = "NEXT_PUBLIC_API_URL", value = "https://api.${var.control_plane_domain}" },
      { name = "LLM_PROXY_URL", value = "https://${var.llm_subdomain}.${var.control_plane_domain}" },
      # Daytona's documented HTTPS-upstream mode currently fails before CONNECT reaches Rust.
      # Keep the destination TLS end-to-end through CONNECT, but use the dedicated cleartext proxy
      # listener until Daytona repairs HTTPS proxy chaining. The per-sandbox credential is derived,
      # revocable with lifecycle state, and accepted only by the forward-proxy listener.
      { name = "SANDBOX_FORWARD_PROXY_URL", value = "http://${var.egress_subdomain}.${var.control_plane_domain}:3128" },
      { name = "KAFKA_RUNTIME_LOG_TOPIC", value = "runtime-logs" },
      { name = "KAFKA_USAGE_EVENT_TOPIC", value = "usage-events" },
      { name = "SEARCH_ADMIN_URL", value = "https://${var.opensearch_subdomain}.${var.control_plane_domain}" },
      { name = "LAMBDA_WEB_ADAPTER_LAYER_VERSION", value = tostring(var.lambda_web_adapter_layer_version) },
      { name = "SERVICE_POSTGRES_PROVIDER", value = "neon" },
      { name = "SERVICE_POSTGRES_PUBLIC_HOST", value = "${var.postgres_subdomain}.${var.control_plane_domain}" },
      { name = "SERVICE_POSTGRES_PUBLIC_PORT", value = "5432" },
      { name = "SERVICE_SEARCH_PUBLIC_HOST", value = "${var.search_subdomain}.${var.control_plane_domain}" },
      { name = "SERVICE_SEARCH_PUBLIC_PORT", value = "443" },
      { name = "SERVICE_VALKEY_PUBLIC_HOST", value = "${var.tenant_valkey_subdomain}.${var.control_plane_domain}" },
      { name = "SERVICE_VALKEY_PUBLIC_PORT", value = "6379" },
      { name = "SERVICE_OBJECT_STORAGE_ENABLED", value = tostring(var.storage_proxy_enabled) },
      { name = "SERVICE_OBJECT_STORAGE_REGION", value = var.aws_region },
      { name = "SERVICE_OBJECT_STORAGE_PUBLIC_ENDPOINT", value = "https://${var.storage_subdomain}.${var.control_plane_domain}" },
      { name = "SERVICE_OBJECT_STORAGE_SHARED_BUCKET", value = aws_s3_bucket.tenant_objects.id },
      { name = "SERVICE_OBJECT_STORAGE_PATH_STYLE", value = "true" },
    ])

    secrets = concat([{
      name      = "DATABASE_SECRET"
      valueFrom = aws_db_instance.control_plane.master_user_secret[0].secret_arn
    }], local.ecs_acme_worker_parameter_secrets)

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "acme-worker"
      }
    }
  }])

  tags = local.tags
}

/*
  Container logs, and the one place CloudWatch is still used deliberately.

  ADR 0026 removed CloudWatch from the *tenant* log path — customers' logs go to ClickHouse through
  Kafka, because CloudWatch charges $0.50/GB before a line reaches us. These are our own three
  processes on one instance, and a container that fails to start writes its reason here and nowhere
  else. Seven days, because the value of a startup failure is entirely in the hour after it happens.
*/
resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/sproutos/ecs"
  retention_in_days = 7
  tags              = local.tags
}

/*
  One service, registered with both target groups.

  A service may register with several, which is what lets one task serve the apex on 8080 and the
  API host on 3001 without a second deployment. It is also why they cannot be separately rolled:
  they are the same task, and that is the honest expression of what was already true when they
  shared an instance and a release tarball.
*/
resource "aws_ecs_service" "web" {
  name            = "${var.name_prefix}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = data.aws_ecs_task_definition.web.arn
  desired_count   = var.ecs_instance_count

  availability_zone_rebalancing = "ENABLED"

  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.main.name
    weight            = 100
  }

  # Availability-zone spread must be first for ECS's AZ rebalancer. `distinctInstance` is the hard
  # boundary; the second spread keeps placement deterministic within a zone if the cluster grows.
  ordered_placement_strategy {
    type  = "spread"
    field = "attribute:ecs.availability-zone"
  }

  ordered_placement_strategy {
    type  = "spread"
    field = "instanceId"
  }

  placement_constraints {
    type = "distinctInstance"
  }

  # Two healthy replicas remain serving while ECS starts one replacement on the one spare host.
  # 150% caps the service at three tasks, so ECS replaces replicas sequentially; 100% prevents it
  # from draining either old task until the new task is healthy in both target groups.
  deployment_maximum_percent         = 150
  deployment_minimum_healthy_percent = 100

  # A waiter timing out is only CI noticing a broken deployment. The circuit breaker is ECS acting
  # on it: stop launching the bad revision and restore the last completed task definition without
  # requiring a second workflow run. This matters most after the one-time traffic move to green,
  # when green is production rather than an idle staging target.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  health_check_grace_period_seconds = 120

  /*
    The idle colour, so ECS and the Auto Scaling groups never share a target group.

    Both register targets; if they shared one, the load balancer would round-robin between an ECS
    task and an EC2 instance running a different release, and which one answered would be luck.
    ECS takes green while the EC2 instances hold blue, `cutover.sh` moves the weight when green is
    healthy, and the old groups are scaled to zero afterwards. The same mechanism that rolls a
    release also rolls the platform it runs on.
  */
  load_balancer {
    target_group_arn = aws_lb_target_group.website["green"].arn
    container_name   = "website"
    container_port   = 8080
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api["green"].arn
    container_name   = "api"
    container_port   = 3001
  }

  # The image tag moves on every release and the deploy updates the service directly; an apply that
  # reset it would roll production back to whatever the state file remembered. Desired count is
  # deliberately not ignored: OpenTofu must detect and repair a manual scale-down below two.
  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = local.tags
}

locals {
  ecs_web_target_groups = {
    website = aws_lb_target_group.website["green"]
    api     = aws_lb_target_group.api["green"]
  }
}

# These alarms intentionally use native ALB and Auto Scaling metrics. ECS RunningTaskCount exists
# only with paid Container Insights; a task that cannot serve is already visible here as fewer than
# two healthy targets, while GroupInServiceInstances catches loss of the host capacity beneath it.
resource "aws_cloudwatch_metric_alarm" "ecs_healthy_targets" {
  for_each = local.ecs_web_target_groups

  alarm_name          = "${var.name_prefix}-ecs-${each.key}-healthy-targets"
  alarm_description   = "Fewer than two healthy ${each.key} targets means the ECS control plane has lost redundancy."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = var.ecs_instance_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = each.value.arn_suffix
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_unhealthy_targets" {
  for_each = local.ecs_web_target_groups

  alarm_name          = "${var.name_prefix}-ecs-${each.key}-unhealthy-targets"
  alarm_description   = "At least one ${each.key} target is explicitly unhealthy."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = each.value.arn_suffix
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_in_service_hosts" {
  alarm_name          = "${var.name_prefix}-ecs-in-service-hosts"
  alarm_description   = "Fewer than two in-service ECS hosts cannot sustain the two-replica service."
  namespace           = "AWS/AutoScaling"
  metric_name         = "GroupInServiceInstances"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = var.ecs_instance_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.ecs.name
  }

  tags = local.tags
}

resource "aws_ecs_service" "acme_worker" {
  name            = "${var.name_prefix}-acme-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.acme_worker.arn
  # Retained only so existing state can converge without deleting the service during the edge
  # rollout. Certificate work runs in the ordinary platform worker; this service stays empty.
  desired_count = 0

  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.main.name
    weight            = 100
  }

  # These constraints are inert while desired_count is zero, but keep existing state stable until
  # the dormant service is removed in a separate cleanup.
  ordered_placement_strategy {
    type  = "spread"
    field = "attribute:ecs.availability-zone"
  }

  ordered_placement_strategy {
    type  = "binpack"
    field = "memory"
  }

  placement_constraints {
    type = "distinctInstance"
  }

  availability_zone_rebalancing      = "ENABLED"
  deployment_maximum_percent         = 150
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = local.tags
}

/*
  The role ECS itself uses to start a task: pull the image, read the secrets, write the logs.

  Distinct from the task role, which is what the *application* gets. ECS needs the database secret
  to inject it as an environment variable before the container exists; the container then needs
  nothing to read it. Conflating the two would give the application the ability to fetch every
  secret the platform can, rather than the one it was handed.
*/
resource "aws_iam_role" "ecs_execution" {
  name = "${var.name_prefix}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "read-task-secrets"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_db_instance.control_plane.master_user_secret[0].secret_arn
      },
      {
        # ECS resolves task-definition `secrets` before a container starts. The application task
        # role is therefore irrelevant here; this execution role needs the exact Parameter Store
        # calls itself or the task fails as `ResourceInitializationError`.
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = local.ecs_web_parameter_arns
      },
      {
        # The same pairing the instance role needed: a secret encrypted with a customer-managed key
        # takes two permissions, and the missing one reports as AccessDenied on the *other* service.
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.secrets.arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com"
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.secrets.arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com"
          }
        }
      },
    ]
  })
}

resource "aws_iam_role" "acme_execution" {
  name = "${var.name_prefix}-acme-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "acme_execution" {
  role       = aws_iam_role.acme_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "acme_execution_secrets" {
  name = "read-acme-task-secrets"
  role = aws_iam_role.acme_execution.id

  # The isolated task needs the same database secret and ordinary worker configuration, but never
  # the Google registration key or either signer credential. A separate execution role makes that
  # boundary enforceable even if a future ACME task definition tries to name one of them.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_db_instance.control_plane.master_user_secret[0].secret_arn
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = local.ecs_acme_parameter_arns
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.secrets.arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com"
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.secrets.arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com"
          }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "ecs_task_no_parameter_store" {
  name = "deny-runtime-parameter-store"
  role = aws_iam_role.task.id

  # The application policy is still shared with the legacy EC2 roles and grants path reads for
  # their boot script. ECS does not need that runtime authority: its execution role resolves the
  # exact task-definition secret ARNs before containers start. Without this explicit deny, every
  # container in the shared task could fetch the API-only operator token from Parameter Store even
  # though ECS injects it into the API container alone.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Deny"
      Action   = local.ecs_task_parameter_store_deny_actions
      Resource = local.ecs_task_parameter_store_deny_resources
    }]
  })
}
