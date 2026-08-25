/*
  The compute plane, per ADR 0026.

  Two EC2 Auto Scaling groups behind one Application Load Balancer, and Lambda for customer code.
  This replaces `eks.tf` — there is no Kubernetes, no Knative, and no node pool for tenant
  workloads, because tenant workloads are Lambda functions now.

  **One ALB, two target groups per service.** The website and the router share it, separated by
  host-based listener rules: the control-plane domain goes to the website, everything else — every
  tenant hostname under the wildcard — goes to the router. Two load balancers would mean two
  certificates and two sets of DNS for one product.
*/

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "Public entry point"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name_prefix}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from anywhere"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_v6" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from anywhere, IPv6"
  cidr_ipv6         = "::/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# Port 80 exists only to redirect. Not opening it would leave a customer who typed a bare hostname
# with a connection refused rather than a redirect to the working URL.
resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP, redirected to HTTPS"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_out" {
  security_group_id = aws_security_group.alb.id
  description       = "To the instances"
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "-1"
}

resource "aws_security_group" "service" {
  name        = "${var.name_prefix}-service"
  description = "The website and router instances"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name_prefix}-service" }
}

/*
  Only from the load balancer.

  Referenced by security-group id rather than by CIDR: the private subnets hold other things, and a
  CIDR rule would let anything in the VPC reach the application port directly — which is how a
  compromised sidecar becomes a bypass of every rule on the ALB.
*/
resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  security_group_id            = aws_security_group.service.id
  description                  = "Application port, from the ALB only"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
}

# The API's port, from the ALB only, on the same instances. A separate rule rather than a widened
# range: 8080 and 3001 are the two ports anything may reach, and naming them separately means adding
# a third is a deliberate line rather than a bound nobody re-reads.
resource "aws_vpc_security_group_ingress_rule" "service_api_from_alb" {
  security_group_id            = aws_security_group.service.id
  description                  = "API port, from the ALB only"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3001
  to_port                      = 3001
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "service_out" {
  security_group_id = aws_security_group.service.id
  description       = "Outbound, for AWS APIs and the OVH backends"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "service_out_v6" {
  security_group_id = aws_security_group.service.id
  description       = "Outbound, IPv6"
  cidr_ipv6         = "::/0"
  ip_protocol       = "-1"
}

# ---------------------------------------------------------------------------
# The load balancer
# ---------------------------------------------------------------------------

resource "aws_lb" "main" {
  name               = "${var.name_prefix}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  ip_address_type    = "dualstack"

  /*
    Two subnets, not the three that exist.

    An ALB holds one public IPv4 address per subnet it spans, and since 1 February 2024 AWS bills
    every public IPv4 address — so a third availability zone with nothing in it was $3.60 a month
    for an address nothing answers on. These are AWS's addresses, not Elastic IPs: they cannot be
    allocated, released, or reduced any other way than by narrowing the subnet list.

    **Two is the floor, not a choice.** AWS rejects an application load balancer with fewer than two
    subnets in two availability zones, so this cannot follow the rest of the estate down to one.

    The Auto Scaling groups below are sliced from the same `local.serving_zone_count`, because a
    load balancer narrower than its targets silently drops the ones it cannot reach.
  */
  subnets = slice(aws_subnet.public[*].id, 0, local.serving_zone_count)

  # A tenant application can legitimately hold a connection open — a server-sent event stream, a
  # long poll. The default 60s would cut those at exactly one minute, which reads to the customer
  # as their own bug.
  idle_timeout = 300

  enable_deletion_protection = var.deletion_protection
  tags                       = { Name = "${var.name_prefix}-alb" }
}

/*
  Two target groups per service, and the listener rule decides which is live.

  This is the blue/green mechanism (§3.5): a deploy fills the idle group, the group's own health
  checks decide whether it is serving, and the cutover is a `modify-rule` changing one ARN. Rollback
  is the same call with the previous ARN, which is why both groups are declared here rather than one
  being created at deploy time.
*/
locals {
  service_colours = toset(["blue", "green"])
}

resource "aws_lb_target_group" "website" {
  for_each = local.service_colours

  name     = "${var.name_prefix}-web-${each.key}"
  port     = 8080
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  health_check {
    path                = "/healthz"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  # Long enough for an in-flight request to finish, short enough that a rollback is not held up by
  # connections nobody is using.
  deregistration_delay = 30
  tags                 = { Name = "${var.name_prefix}-web-${each.key}" }
}

/*
  The API, on its own target group and its own port.

  `api.sproutos.me` used to be a second `host_header` value on the website's rule, pointing at the
  website's port-8080 group. That could never have worked: the API is a separate deployment on 3001
  (see `AGENTS.md`), Next.js has no `/v1/*` routes, and every request to the API host would have
  been answered by the website with a 404 — or, as it actually was, a 503, because nothing was
  running there at all.

  Same instances, different port. An Auto Scaling group can register with several target groups, so
  this needs no second fleet: the website process listens on 8080 and the API process on 3001 on
  the same box, and the load balancer picks by hostname.

  **`/ready`, not `/health`.** `apps/internal-api/src/health.ts` splits them deliberately: `/health`
  is liveness and must never touch a dependency, `/ready` checks the database. A target group is
  exactly the readiness case — failing it removes the instance from rotation, which is reversible
  the moment Postgres comes back, and is what should happen to an API that cannot reach its
  database. Pointing this at `/health` would keep sending traffic to an instance that can only
  return errors.
*/
resource "aws_lb_target_group" "api" {
  for_each = local.service_colours

  name     = "${var.name_prefix}-api-${each.key}"
  port     = 3001
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  health_check {
    path                = "/ready"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  deregistration_delay = 30
  tags                 = { Name = "${var.name_prefix}-api-${each.key}" }
}

resource "aws_lb_target_group" "router" {
  for_each = local.service_colours

  name     = "${var.name_prefix}-router-${each.key}"
  port     = 8080
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  health_check {
    path                = "/healthz"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    # 200 only. The router answers `/healthz` itself when the request is not for a tenant, so a
    # 404 here means the process is not the router — accepting it would let a wrong binary pass.
    matcher = "200"
  }

  deregistration_delay = 30
  tags                 = { Name = "${var.name_prefix}-router-${each.key}" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.tenant.arn

  /*
    The router is the default, and the website is the exception.

    Round that way because tenant hostnames are unbounded and the control plane's are three. A
    default of "website" would need a rule matching every tenant host, which is not expressible.
  */
  /*
    Both target groups, weighted.

    A single `target_group_arn` was here first and made the *green* scaling policy impossible to
    create: a target-tracking policy on `ALBRequestCountPerTarget` is rejected with "The load
    balancer does not route traffic to the target group", because an unrouted group has no request
    count to track. AWS refused it at apply; nothing in a plan could have seen it.

    Weighted forward fixes that and is the better shape anyway: both groups are attached, green
    simply gets none of the traffic, and the cutover is a change of weights rather than a change of
    ARN — which also makes a gradual shift possible later without touching this again.
  */
  default_action {
    type = "forward"

    forward {
      target_group {
        arn    = aws_lb_target_group.router["blue"].arn
        weight = 100
      }
      target_group {
        arn    = aws_lb_target_group.router["green"].arn
        weight = 0
      }
    }
  }

  /*
    The deploy flips this between blue and green outside OpenTofu. Without this, the next `apply`
    would silently roll production back to whichever colour the state file remembers.

    **The cost, which bit once:** this hides changes to the *shape* of the action too, not only the
    weights. Terraform cannot ignore the weights alone — `target_group` is a block, and a weight
    cannot be addressed apart from the ARN beside it. So an earlier run created this listener with a
    single unweighted `TargetGroupArn`, green was never attached, and green's scaling policy was
    rejected with "the load balancer does not route traffic to the target group" — while `plan`
    reported no changes at all. **Changing the shape of this block needs `-replace`.**
  */
  lifecycle {
    ignore_changes = [default_action]
  }
}

resource "aws_lb_listener_rule" "website" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type = "forward"

    forward {
      target_group {
        arn    = aws_lb_target_group.website["blue"].arn
        weight = 100
      }
      target_group {
        arn    = aws_lb_target_group.website["green"].arn
        weight = 0
      }
    }
  }

  condition {
    host_header {
      # The apex only. `api.` has its own rule below, at a lower priority number so it is matched
      # first — a rule listing both would send API requests to a process with no API routes.
      values = [var.control_plane_domain]
    }
  }

  # Same reasoning, and the same trap, as the listener above: the cutover owns the weights, and a
  # change to the shape of this block is invisible to `plan` and needs `-replace`.
  lifecycle {
    ignore_changes = [action]
  }
}

/*
  `api.sproutos.me`, to the API's port on the same instances.

  Priority 90, ahead of the website's 100. ALB rules are evaluated in ascending priority and the
  first match wins, so this has to be the lower number — the website rule matches the apex only, but
  ordering it first is what keeps that true if either condition is ever widened.
*/
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 90

  action {
    type = "forward"

    forward {
      target_group {
        arn    = aws_lb_target_group.api["blue"].arn
        weight = 100
      }
      target_group {
        arn    = aws_lb_target_group.api["green"].arn
        weight = 0
      }
    }
  }

  condition {
    host_header {
      values = ["api.${var.control_plane_domain}"]
    }
  }

  # As above: the cutover owns these weights, and changing the shape of this block needs `-replace`.
  lifecycle {
    ignore_changes = [action]
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

/*
  One certificate covering the control plane and every tenant host.

  `*.<domain>` covers exactly one label, which is why a preview hostname is `pr-42--myapp` and not
  `pr-42.myapp` — the second form would need a certificate per project.
*/
resource "aws_acm_certificate" "tenant" {
  domain_name               = var.control_plane_domain
  subject_alternative_names = ["*.${var.control_plane_domain}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${var.name_prefix}-cert" }
}

# ---------------------------------------------------------------------------
# The instances
# ---------------------------------------------------------------------------

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_iam_role" "instance" {
  name = "${var.name_prefix}-instance"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

/*
  What the router is allowed to do.

  `lambda:InvokeFunction` on the tenant function prefix and nothing else. Not `*`: the router holds
  the platform's credential on a public-facing box, and the blast radius of that box being taken is
  bounded by this statement.
*/
resource "aws_iam_role_policy" "instance" {
  name = "${var.name_prefix}-instance"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:sproutos-app-*"
      },
      {
        # The release the instance boots from, and the pointer that names it.
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.artifacts.arn}/releases/*"
      },
      {
        /*
          The database password, which exists only in Secrets Manager.

          `manage_master_user_password` keeps it out of `terraform.tfstate`; the consequence is that
          the instance has to fetch it at boot to compose `DATABASE_URL`. Scoped to the one secret
          RDS manages for this instance, not to `*`.
        */
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_db_instance.control_plane.master_user_secret[0].secret_arn
      },
      {
        /*
          Reading an encrypted object takes two permissions, not one.

          The artifacts bucket is SSE-KMS under `aws_kms_key.secrets` (see `registry.tf`), and
          `s3:GetObject` alone is not enough: S3 answers **`AccessDenied` on GetObject** while the
          thing actually refused is `kms:Decrypt`. The message does name the key, but only if
          somebody is reading it — the instance's own symptom was a bootstrap that failed and an
          Auto Scaling group that replaced it, over and over, with no log anywhere but on the
          instance being destroyed.

          Decrypt only, and only through S3: `kms:ViaService` means this cannot be used to read
          anything else the key protects, which includes the database's master password.
        */
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.secrets.arn
        Condition = {
          # Two services, because the same key protects the release in S3 and the database password
          # in Secrets Manager. Still a `ViaService` list rather than an unconditional grant: this
          # role cannot use the key directly, only through the two services that hold things it is
          # entitled to read.
          StringEquals = {
            "kms:ViaService" = [
              "s3.${var.aws_region}.amazonaws.com",
              "secretsmanager.${var.aws_region}.amazonaws.com",
            ]
          }
        }
      },
      {
        # Tenant object storage. Scoped to the `v-*` prefix, which is what makes the bucket-name
        # check in the router a boundary rather than a formality — see `storage.tf`.
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
        Resource = [
          "arn:aws:s3:::${var.tenant_bucket_prefix}*",
          "arn:aws:s3:::${var.tenant_bucket_prefix}*/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.envelope.arn
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "instance_ssm" {
  role = aws_iam_role.instance.name
  # Session Manager instead of SSH. No key pairs to distribute, no port 22 open, and every session
  # is logged against an IAM principal.
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name_prefix}-instance"
  role = aws_iam_role.instance.name
}

resource "aws_launch_template" "service" {
  for_each = toset(["website", "router"])

  name_prefix   = "${var.name_prefix}-${each.key}-"
  image_id      = data.aws_ssm_parameter.al2023_arm64.value
  instance_type = var.service_instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.instance.arn
  }

  vpc_security_group_ids = [aws_security_group.service.id]

  user_data = base64encode(templatefile("${path.module}/user-data.sh.tftpl", {
    service          = each.key
    artifacts_bucket = aws_s3_bucket.artifacts.bucket
    aws_region       = var.aws_region
    valkey_url       = "rediss://${aws_elasticache_replication_group.platform.primary_endpoint_address}:6379"
    tenant_domain    = var.control_plane_domain

    # Kept in step with `.config/mise.toml` and the deploy workflow by hand, because three places
    # is already one too many. A mismatch means the release was built on one Node and runs on
    # another.
    node_version = var.node_version

    # Read at boot by the website instances only, to compose `DATABASE_URL`. The ARN is not a
    # secret; what it names is, and reading it needs the instance role.
    database_secret_arn = aws_db_instance.control_plane.master_user_secret[0].secret_arn
    database_endpoint   = aws_db_instance.control_plane.endpoint
    database_name       = aws_db_instance.control_plane.db_name
  }))

  metadata_options {
    # IMDSv2 only. v1 is a plain GET, so any server-side request forgery in a tenant-facing process
    # reads the instance's credentials; v2 needs a PUT to get a token, which forgery cannot do.
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  monitoring {
    enabled = true
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name_prefix}-${each.key}", Service = each.key }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "website" {
  for_each = local.service_colours

  name = "${var.name_prefix}-web-${each.key}"
  # The same zones the load balancer spans — see `local.serving_zone_count`. An instance outside
  # them boots, passes its own health check, and is never sent a request.
  vpc_zone_identifier = slice(aws_subnet.private[*].id, 0, local.serving_zone_count)
  # Both, because both processes run on these instances. A target group is a port on a set of
  # instances, not a fleet of its own.
  target_group_arns = [
    aws_lb_target_group.website[each.key].arn,
    aws_lb_target_group.api[each.key].arn,
  ]

  # Zero is a valid size: only one colour serves at a time, and the idle one should cost nothing.
  min_size         = 0
  max_size         = var.service_max_count
  desired_capacity = each.key == "blue" ? var.service_desired_count : 0

  health_check_type         = "ELB"
  health_check_grace_period = 120

  launch_template {
    id      = aws_launch_template.service["website"].id
    version = "$Latest"
  }

  lifecycle {
    # Scaling and cutover both happen outside OpenTofu.
    ignore_changes = [desired_capacity]
  }

  tag {
    key                 = "Name"
    value               = "${var.name_prefix}-web-${each.key}"
    propagate_at_launch = true
  }
}

resource "aws_autoscaling_group" "router" {
  for_each = local.service_colours

  name = "${var.name_prefix}-router-${each.key}"
  # The same zones the load balancer spans — see `local.serving_zone_count`. An instance outside
  # them boots, passes its own health check, and is never sent a request.
  vpc_zone_identifier = slice(aws_subnet.private[*].id, 0, local.serving_zone_count)
  target_group_arns   = [aws_lb_target_group.router[each.key].arn]

  min_size         = 0
  max_size         = var.service_max_count
  desired_capacity = each.key == "blue" ? var.service_desired_count : 0

  health_check_type         = "ELB"
  health_check_grace_period = 120

  launch_template {
    id      = aws_launch_template.service["router"].id
    version = "$Latest"
  }

  lifecycle {
    ignore_changes = [desired_capacity]
  }

  tag {
    key                 = "Name"
    value               = "${var.name_prefix}-router-${each.key}"
    propagate_at_launch = true
  }
}

# ---------------------------------------------------------------------------
# The execution role every tenant function assumes
# ---------------------------------------------------------------------------

/*
  One role for every customer function, not one per tenant.

  A role per tenant would be the instinct, and it is wrong here for the reason a per-tenant IAM user
  was wrong for object storage: IAM roles are a hard account quota, so a role per project caps the
  platform at a few thousand customers and puts the tenant boundary in a policy document nothing in
  this repository can test. The boundary is the function itself — a Lambda cannot see another
  function's environment or code — and the credentials a tenant's code gets are the ones the router
  hands it, which is code we own and test.
*/
resource "aws_iam_role" "lambda_execution" {
  name = "${var.name_prefix}-lambda-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role = aws_iam_role.lambda_execution.name
  # Logs only. Deliberately the whole of it: a customer's function has no reason to reach any AWS
  # API, and anything it does need arrives as an environment variable the control plane sealed.
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ---------------------------------------------------------------------------
# The platform's own Valkey
# ---------------------------------------------------------------------------

resource "aws_security_group" "cache" {
  name        = "${var.name_prefix}-cache"
  description = "Platform Valkey"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name_prefix}-cache" }
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_service" {
  security_group_id            = aws_security_group.cache.id
  description                  = "Valkey, from the website and router only"
  referenced_security_group_id = aws_security_group.service.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.name_prefix}-cache"
  subnet_ids = aws_subnet.private[*].id
}

/*
  One small node, node-based rather than serverless.

  ElastiCache Serverless is $0.084 per GB-hour — $61.32 per GB-month against $0.0102 per GiB-hour on
  a node, 8.2x before ECPU charges. This holds a route map, some billing counters and the router's
  own queue: a small keyspace of short strings and integers. If it outgrows the node the answer is
  to measure and resize, not to have provisioned for an imagined future.
*/
resource "aws_elasticache_replication_group" "platform" {
  replication_group_id = "${var.name_prefix}-platform"
  description          = "Route map, billing counters, the router's queue"
  engine               = "valkey"
  engine_version       = var.valkey_version
  node_type            = var.cache_node_type
  num_cache_clusters   = 1
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.cache.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  # `allkeys-lru`, not `noeviction`. Everything in here is a cache of something Postgres holds — a
  # route can be republished, a counter re-derived from the ledger — so shedding the coldest key
  # under pressure is correct. The tenant queue Valkey is the opposite and is configured separately,
  # on OVH: a dropped job is a job that never ran.
  parameter_group_name = aws_elasticache_parameter_group.platform.name

  tags = { Name = "${var.name_prefix}-platform-cache" }
}

resource "aws_elasticache_parameter_group" "platform" {
  name   = "${var.name_prefix}-platform"
  family = var.valkey_parameter_family

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }
}

# ---------------------------------------------------------------------------
# Scaling
# ---------------------------------------------------------------------------

/*
  Target tracking on request count, not on CPU.

  Both services are IO-bound — the router waits on Lambda, the website waits on the API — so CPU
  stays low while latency climbs, and a CPU-based policy would scale after the users had already
  noticed. Requests per target is the thing that actually correlates with being overloaded here.

  On both colours, which is only possible because the listener forwards to both with weights. The
  idle group receives no traffic, so its request count is zero and the policy never scales it out —
  the policy existing is what matters, so that a cutover does not need one created at the moment
  traffic arrives.
*/
resource "aws_autoscaling_policy" "website" {
  for_each = local.service_colours

  name                   = "${var.name_prefix}-web-${each.key}-requests"
  autoscaling_group_name = aws_autoscaling_group.website[each.key].name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.main.arn_suffix}/${aws_lb_target_group.website[each.key].arn_suffix}"
    }
    target_value = var.requests_per_target
    # Scaling in on a group that is at zero between deploys would thrash. Out only; the deploy sets
    # the floor and `fill-idle.sh` sets it back.
    disable_scale_in = true
  }
}

resource "aws_autoscaling_policy" "router" {
  for_each = local.service_colours

  name                   = "${var.name_prefix}-router-${each.key}-requests"
  autoscaling_group_name = aws_autoscaling_group.router[each.key].name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.main.arn_suffix}/${aws_lb_target_group.router[each.key].arn_suffix}"
    }
    target_value     = var.requests_per_target
    disable_scale_in = true
  }
}
