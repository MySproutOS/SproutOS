/**
 * The website, the API and the background worker: one image, three containers, one instance.
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
  # they exist; the later custody change supplies an explicit, preflighted enable plan.
  ecs_android_api_parameter_names = var.android_custody_delivery_enabled ? [
    "APK_SIGNER_OPERATOR_TOKEN",
    "APK_SIGNER_TOKEN",
  ] : []

  ecs_api_parameter_names = concat(local.ecs_android_api_parameter_names, [
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
  ])

  ecs_android_worker_parameter_names = var.android_custody_delivery_enabled ? [
    "ANDROID_DEVELOPER_ID_STATUS_API_KEY",
  ] : []

  ecs_worker_parameter_names = concat(local.ecs_android_worker_parameter_names, [
    "CLICKHOUSE_PASSWORD",
    "DAYTONA_API_KEY",
    "DAYTONA_ORGANIZATION_ID",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "KAFKA_BROKERS",
    "KAFKA_USAGE_EVENT_SASL_PASSWORD",
    "KAFKA_USAGE_EVENT_SASL_USERNAME",
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
  ])

  ecs_application_parameter_arns = [
    for name in toset(concat(
      local.ecs_website_parameter_names,
      local.ecs_api_parameter_names,
      local.ecs_worker_parameter_names,
    )) : "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.application_parameter_path}/${name}"
  ]
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
    http_tokens = "required"
    # Two hops, not one: the ECS agent runs in a container and its request to the metadata service
    # crosses a network namespace, which counts as a hop. At one, the agent cannot read the
    # instance's credentials and the instance never joins the cluster — with no error that mentions
    # the metadata service.
    http_put_response_hop_limit = 2
  }

  # Plugin execution needs a reviewed Docker seccomp profile before this host may join ECS. The
  # bootstrap pins the exact AL2023 Docker/runc builds used to materialize the profile and leaves
  # ECS stopped on any drift or validation failure.
  user_data = base64encode(<<-EOT
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
  One task, three containers.

  The alternative was one container running a shell that started two processes and waited on
  whichever exited first, which is what the EC2 release did. That gave one log stream for two
  processes, one memory limit shared between them, and a supervision loop that had to be exactly
  right or a dead process went unnoticed — which is precisely the class of bug that has cost the
  most time on this deployment. Three containers hand that job to ECS: separate logs, separate
  reservations, and a crash that shows up as a container exit rather than being inferred.

  **All three are `essential`.** ECS does not restart an individual container within a task — if a
  non-essential one exits it simply stays exited, silently, until the task is replaced for some
  other reason. A worker that dies quietly and is never noticed is the worse failure, so the worker
  is essential too: its crash cycles the task, which is loud and self-healing. The cost is a few
  seconds of the site restarting with it, and that is the right trade at this size.
*/
resource "aws_ecs_task_definition" "web" {
  family       = "${var.name_prefix}-web"
  network_mode = "bridge"

  # Task-level, shared by the containers below. A `t4g.micro` has 1024 MiB and the ECS agent and
  # the OS need some of it, so this leaves headroom rather than claiming the lot and having the
  # kernel decide what to kill.
  memory = 768
  cpu    = 1024

  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name              = "website"
      image             = var.web_image
      essential         = true
      memoryReservation = 320
      dockerSecurityOptions = [
        "no-new-privileges",
      ]
      linuxParameters = {
        capabilities = {
          drop = ["ALL"]
        }
      }

      portMappings = [{
        containerPort = 8080
        # The service security group intentionally exposes only this exact port from the ALB. An
        # ephemeral host port registers successfully but every health check then times out. Fixed
        # is safe because the service's 100/0 deployment policy replaces rather than overlaps tasks,
        # and the task's memory reservation already limits this instance to one copy.
        hostPort = 8080
        protocol = "tcp"
      }]

      environment = [
        { name = "PORT", value = "8080" },
        { name = "NEXT_PUBLIC_API_URL", value = "https://api.${var.control_plane_domain}" },
        { name = "NEXT_PUBLIC_HOST_URL", value = "https://${var.control_plane_domain}" },
        { name = "DATABASE_HOST", value = aws_db_instance.control_plane.endpoint },
        { name = "DATABASE_NAME", value = aws_db_instance.control_plane.db_name },
        { name = "KMS_KEY_ID", value = aws_kms_key.envelope.arn },
        { name = "SESSION_COOKIE_DOMAIN", value = ".${var.control_plane_domain}" },
        { name = "SPA_ASSET_ORIGIN", value = "https://${aws_cloudfront_distribution.spa.domain_name}" },
      ]

      secrets = concat(
        [{ name = "DATABASE_SECRET", valueFrom = aws_db_instance.control_plane.master_user_secret[0].secret_arn }],
        [for name in local.ecs_website_parameter_names : {
          name      = name
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.application_parameter_path}/${name}"
        }],
      )

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "website"
        }
      }
    },
    {
      name              = "api"
      image             = var.web_image
      essential         = true
      memoryReservation = 320
      command           = ["node", "/opt/sproutos/api/server.js"]
      dockerSecurityOptions = [
        "no-new-privileges",
      ]
      linuxParameters = {
        capabilities = {
          drop = ["ALL"]
        }
      }

      portMappings = [{
        containerPort = 3001
        # Same fixed-port/security-group contract as the website listener above.
        hostPort = 3001
        protocol = "tcp"
      }]

      environment = [
        { name = "API_PORT", value = "3001" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "TENANT_DOMAIN", value = var.tenant_domain },
        # The API signs direct build uploads. Without this value it silently falls back to the
        # nonexistent local-development bucket and every CLI/Action deploy fails at the first PUT.
        { name = "SERVICE_BUILD_BUCKET", value = aws_s3_bucket.tenant_builds.id },
        { name = "TENANT_STATIC_BUCKET", value = aws_s3_bucket.tenant_static.id },
        { name = "TENANT_ZONE_ID", value = aws_route53_zone.tenant.zone_id },
        { name = "TENANT_STATIC_DISTRIBUTION_DOMAIN", value = aws_cloudfront_distribution.tenant_static.domain_name },
        { name = "TENANT_STATIC_KEY_VALUE_STORE_ARN", value = aws_cloudfront_key_value_store.tenant_static.arn },
        { name = "TENANT_INGRESS_HOST", value = var.tenant_edge_enabled ? "ingress.${var.tenant_domain}" : "preview-ingress.${var.tenant_domain}" },
        { name = "TENANT_INGRESS_IPV4_ADDRESSES", value = join(",", aws_eip.tenant_edge[*].public_ip) },
        { name = "TENANT_INGRESS_IPV6_ADDRESSES", value = local.tenant_edge_provisioned ? join(",", local.tenant_edge_ipv6_addresses) : "" },
        { name = "CUSTOM_DOMAINS_ENABLED", value = var.custom_domain_issuance_enabled ? "1" : "0" },
        # The entrypoint composes DATABASE_URL from these plus the injected secret. The host and
        # database name are not secret; only the credentials are, and those arrive separately.
        { name = "DATABASE_HOST", value = aws_db_instance.control_plane.endpoint },
        { name = "DATABASE_NAME", value = aws_db_instance.control_plane.db_name },
        # Where the log viewer reads from. The OVH box behind its Traefik, restricted to this
        # estate's egress address — see `ovh/docker-compose.yaml`. IPv4-only by design: the proxy
        # cannot see a client's IPv6 source there, and an allowlist that cannot see the source is
        # not an allowlist.
        { name = "CLICKHOUSE_URL", value = "https://${var.clickhouse_subdomain}.${var.control_plane_domain}" },
        { name = "CLICKHOUSE_DATABASE", value = local.ecs_clickhouse_database },
        { name = "CLICKHOUSE_USER", value = "sproutos" },
        { name = "VALKEY_URL", value = "rediss://${aws_elasticache_replication_group.platform.primary_endpoint_address}:6379" },
        { name = "NEXT_PUBLIC_HOST_URL", value = "https://${var.control_plane_domain}" },
        { name = "NEXT_PUBLIC_API_URL", value = "https://api.${var.control_plane_domain}" },
        { name = "SESSION_COOKIE_DOMAIN", value = ".${var.control_plane_domain}" },
        { name = "KMS_KEY_ID", value = aws_kms_key.envelope.arn },
        { name = "LLM_PROXY_URL", value = "https://${var.llm_subdomain}.${var.control_plane_domain}" },
        { name = "SANDBOX_FORWARD_PROXY_URL", value = "https://${var.egress_subdomain}.${var.control_plane_domain}" },
        { name = "KAFKA_RUNTIME_LOG_TOPIC", value = "runtime-logs" },
        { name = "KAFKA_USAGE_EVENT_TOPIC", value = "usage-events" },
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
      ]

      secrets = concat([
        # Assembled by the API from the secret RDS manages, rather than written into this file. A
        # connection string in a task definition is a connection string in `describe-task-definition`
        # output, which is readable by anything with ECS read access.
        { name = "DATABASE_SECRET", valueFrom = aws_db_instance.control_plane.master_user_secret[0].secret_arn },
        ], [for name in local.ecs_api_parameter_names : {
          name      = name
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.application_parameter_path}/${name}"
      }])

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "api"
        }
      }
    },
    {
      /*
        The background worker, which until now shipped in the release and was never started.

        `worker.ts` says it should be a separate process from the API — a long job holding an
        event-loop turn delays every request behind it — and the tarball packaged it and then ran
        only the two servers. Every job the platform queued sat there. A container makes the
        omission impossible: it either has a command or the task definition does not apply.
      */
      name              = "worker"
      image             = var.web_image
      essential         = true
      memoryReservation = 128
      command           = ["node", "/opt/sproutos/api/worker.js"]
      dockerSecurityOptions = [
        "no-new-privileges",
      ]
      linuxParameters = {
        capabilities = {
          drop = ["ALL"]
        }
      }

      environment = [
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_ACCOUNT_ID", value = var.aws_account_id },
        { name = "TENANT_DOMAIN", value = var.tenant_domain },
        { name = "TENANT_STATIC_BUCKET", value = aws_s3_bucket.tenant_static.id },
        { name = "TENANT_STATIC_LOG_BUCKET", value = aws_s3_bucket.tenant_static_logs.id },
        { name = "TENANT_STATIC_LOG_PREFIX", value = "tenant-static/" },
        { name = "TENANT_STATIC_DISTRIBUTION_ID", value = aws_cloudfront_distribution.tenant_static.id },
        { name = "TENANT_ZONE_ID", value = aws_route53_zone.tenant.zone_id },
        { name = "TENANT_STATIC_DISTRIBUTION_DOMAIN", value = aws_cloudfront_distribution.tenant_static.domain_name },
        { name = "TENANT_STATIC_KEY_VALUE_STORE_ARN", value = aws_cloudfront_key_value_store.tenant_static.arn },
        { name = "TENANT_INGRESS_HOST", value = var.tenant_edge_enabled ? "ingress.${var.tenant_domain}" : "preview-ingress.${var.tenant_domain}" },
        { name = "TENANT_CERTIFICATE_BUCKET", value = aws_s3_bucket.tenant_certificates.id },
        { name = "ROUTER_CERTIFICATE_MIN_ACKS", value = tostring(var.router_certificate_min_acks) },
        { name = "ACME_ACCOUNT_KEY_SECRET_ID", value = aws_secretsmanager_secret.acme_account_key.id },
        { name = "ACME_CONTACT_EMAIL", value = "acme@${var.control_plane_domain}" },
        { name = "ACME_DIRECTORY_URL", value = var.acme_directory_url },
        { name = "CONTROL_PLANE_DOMAIN", value = var.control_plane_domain },
        { name = "CONTROL_PLANE_ZONE_ID", value = data.aws_route53_zone.main.zone_id },
        { name = "PLATFORM_EDGE_EGRESS_HOSTNAME", value = "${var.egress_subdomain}.${var.control_plane_domain}" },
        { name = "PLATFORM_ACME_TENANT_ZONE_ID", value = aws_route53_zone.tenant.zone_id },
        { name = "PLATFORM_ACME_EGRESS_ZONE_ID", value = data.aws_route53_zone.main.zone_id },
        # These names are part of the stable naming contract, not runtime attributes. Referencing
        # the ASG resources here makes every infrastructure-only task-definition plan inherit the
        # router launch templates and tenant target groups, so an unrelated application contract
        # correction cannot be reviewed or applied independently of an edge rollout.
        { name = "PLATFORM_ROUTER_ASG_NAMES", value = join(",", [for colour in local.service_colours : "${var.name_prefix}-router-${colour}"]) },
        { name = "TENANT_CERTIFICATE_KMS_KEY_ARN", value = aws_kms_key.secrets.arn },
        { name = "PLATFORM_CERTIFICATE_OBJECT_KEY", value = "platform-edge/current.json" },
        { name = "PLATFORM_EDGE_ROLLOUT_ENABLED", value = var.tenant_edge_enabled || var.tenant_edge_preview_enabled ? "1" : "0" },
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
        { name = "SANDBOX_FORWARD_PROXY_URL", value = "https://${var.egress_subdomain}.${var.control_plane_domain}" },
        { name = "KAFKA_RUNTIME_LOG_TOPIC", value = "runtime-logs" },
        { name = "KAFKA_USAGE_EVENT_TOPIC", value = "usage-events" },
        { name = "SEARCH_ADMIN_URL", value = "https://${var.opensearch_subdomain}.${var.control_plane_domain}" },
        { name = "LAMBDA_WEB_ADAPTER_LAYER_VERSION", value = tostring(var.lambda_web_adapter_layer_version) },
        # Safe only because project teardown resolves the recorded database_instance.provider.
        # Never let the worker choose a destructive driver from DATABASE_URL alone.
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
      ]

      secrets = concat([
        { name = "DATABASE_SECRET", valueFrom = aws_db_instance.control_plane.master_user_secret[0].secret_arn },
        ], [for name in local.ecs_worker_parameter_names : {
          name      = name
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.application_parameter_path}/${name}"
      }])

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "worker"
        }
      }
    },
  ])

  tags = local.tags
}

# The daemon-wide seccomp exception is acceptable only while every process on this dedicated task
# host remains both capability-free and unable to gain privilege. This evaluates the serialized
# task definition rather than trusting three visually similar source blocks to remain in sync.
check "ecs_control_plane_container_isolation" {
  assert {
    condition = alltrue([
      for container in jsondecode(aws_ecs_task_definition.web.container_definitions) :
      contains(container.dockerSecurityOptions, "no-new-privileges") &&
      contains(container.linuxParameters.capabilities.drop, "ALL")
    ])
    error_message = "Every ECS control-plane container must drop ALL capabilities and use no-new-privileges while the Docker seccomp exception is daemon-wide."
  }
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
  task_definition = aws_ecs_task_definition.web.arn
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
        Resource = local.ecs_application_parameter_arns
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
