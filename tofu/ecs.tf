/**
 * The website, the API and the background worker: one image, three containers, one instance.
 *
 * ## Why ECS on EC2 and not Fargate
 *
 * Fargate is not in the free tier at all — it bills per vCPU-second and GB-second from the first
 * task. ECS on the EC2 launch type charges nothing for the control plane; the only cost is the
 * instances, which this account already runs and which the free tier covers.
 *
 * ## Why one instance
 *
 * The free tier is **750 instance-hours a month in aggregate**, not per instance. One `t4g.micro`
 * running continuously is about 720 of them, so "free" means one instance, not one per service.
 * Three tasks on three instances would cost roughly $12 a month to run three processes that
 * together use a few hundred megabytes.
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

resource "aws_ecs_cluster" "main" {
  name = var.name_prefix

  setting {
    # Off. It is per-metric CloudWatch billing for numbers the ALB and the Auto Scaling group
    # already report, on a platform whose observability story is ClickHouse.
    name  = "containerInsights"
    value = "disabled"
  }

  tags = local.tags
}

/*
  Capacity, and what happens when there is not enough of it.

  `managed_scaling` lets ECS grow the Auto Scaling group when a task cannot be placed. The maximum
  is deliberately small: this is a free-tier deployment, and an autoscaler that can quietly reach
  for a fourth instance is an autoscaler that can quietly leave the free tier.

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

  # The only thing an ECS instance needs at boot: which cluster to join.
  user_data = base64encode(<<-EOT
    #!/usr/bin/env bash
    echo "ECS_CLUSTER=${aws_ecs_cluster.main.name}" >> /etc/ecs/ecs.config
    echo "ECS_ENABLE_CONTAINER_METADATA=true" >> /etc/ecs/ecs.config
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

      portMappings = [{
        containerPort = 8080
        # 0 means ECS picks an ephemeral host port and registers it with the target group. Fixed
        # ports would prevent two tasks of the same service ever sharing an instance, which is the
        # thing bridge mode is here to allow.
        hostPort = 0
        protocol = "tcp"
      }]

      environment = [
        { name = "PORT", value = "8080" },
        { name = "NEXT_PUBLIC_API_URL", value = "https://api.${var.control_plane_domain}" },
        { name = "NEXT_PUBLIC_HOST_URL", value = "https://${var.control_plane_domain}" },
      ]

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

      portMappings = [{
        containerPort = 3001
        hostPort      = 0
        protocol      = "tcp"
      }]

      environment = [
        { name = "API_PORT", value = "3001" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "TENANT_DOMAIN", value = var.control_plane_domain },
        # The entrypoint composes DATABASE_URL from these plus the injected secret. The host and
        # database name are not secret; only the credentials are, and those arrive separately.
        { name = "DATABASE_HOST", value = aws_db_instance.control_plane.endpoint },
        { name = "DATABASE_NAME", value = aws_db_instance.control_plane.db_name },
      ]

      secrets = [
        # Assembled by the API from the secret RDS manages, rather than written into this file. A
        # connection string in a task definition is a connection string in `describe-task-definition`
        # output, which is readable by anything with ECS read access.
        { name = "DATABASE_SECRET", valueFrom = aws_db_instance.control_plane.master_user_secret[0].secret_arn },
      ]

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

      environment = [
        { name = "AWS_REGION", value = var.aws_region },
        { name = "DATABASE_HOST", value = aws_db_instance.control_plane.endpoint },
        { name = "DATABASE_NAME", value = aws_db_instance.control_plane.db_name },
      ]

      secrets = [
        { name = "DATABASE_SECRET", valueFrom = aws_db_instance.control_plane.master_user_secret[0].secret_arn },
      ]

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

  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.main.name
    weight            = 100
  }

  # 100/0 rather than the default 200/100: there is one instance, so there is nowhere to put a
  # second copy of the task while the first drains. A brief gap on deploy is the cost of a
  # single-instance free-tier deployment, and pretending otherwise would just make deploys hang.
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0

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
  # reset it would roll production back to whatever the state file remembered.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
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
    ]
  })
}
