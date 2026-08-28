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

# The search split's port, reachable from the load balancer and from nothing else. Without this the
# target group's health check times out, every target is unhealthy, and `search.sproutos.me` answers
# 503 — with the rule, the listener and the process all present and correct.
resource "aws_vpc_security_group_ingress_rule" "service_search_from_alb" {
  security_group_id            = aws_security_group.service.id
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 9200
  to_port                      = 9200
  description                  = "search split from the load balancer"
}

resource "aws_vpc_security_group_ingress_rule" "service_storage_from_alb" {
  security_group_id            = aws_security_group.service.id
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 9000
  to_port                      = 9000
  description                  = "storage split from the load balancer"
}

# The LLM proxy's port, from the load balancer only. Same failure as the search split without it:
# the health check times out, every target is unhealthy, and `llm.sproutos.me` answers 503 while the
# rule, the listener and the process are all present and correct.
resource "aws_vpc_security_group_ingress_rule" "service_llm_from_alb" {
  security_group_id            = aws_security_group.service.id
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 8788
  to_port                      = 8788
  description                  = "LLM proxy from the load balancer"
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

/*
  `search.sproutos.me`, to the router's search split on the same instances.

  This is what a customer is given when they provision an Elasticsearch service, and it is the whole
  reason `SERVICE_SEARCH_PUBLIC_HOST` can now have a value: until there was an address in front of
  `search-proxy`, the only honest answer was the 503 the route already gives, because the alternative
  — naming the cluster itself — hands out a URI that works and bypasses every tenancy check the
  platform makes.

  The same shape as `api.`: one deployment, a second port, its own target groups, moved with the
  router rather than separately. `bin/cutover.sh` moves both, for the reason written there — a
  disagreement between them means search is pointed at the colour the router just drained.

  Priority 80, ahead of `api.` at 90 and the website at 100. Each condition is a single exact host
  so the order cannot currently matter; it is ordered anyway, because "cannot currently matter" is
  a property of the conditions and not of the rules, and widening one later should not be able to
  silently reroute search.
*/
resource "aws_lb_target_group" "search" {
  for_each = local.service_colours

  name     = "${var.name_prefix}-search-${each.key}"
  port     = 9200
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  /*
    401, not 200, and not `/healthz`.

    `search-proxy` is a catch-all: every path belongs to the tenant's cluster, so there is no path
    it can reserve for a health check without taking that path away from every customer. What it
    always does, on any path, is refuse a request carrying no credential — so the refusal *is* the
    signal, and it is a strictly better one than a 200 would be. A 200 here would mean something
    answered; a 401 means the thing that answered checks credentials.

    That this can be the check at all rests on `CredentialStore::check()` being fatal at boot: a
    search split that cannot reach the control plane takes the whole router down rather than
    starting and refusing everybody, so a healthy router is a working search split.
  */
  health_check {
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "401"
  }

  deregistration_delay = 30
  tags                 = { Name = "${var.name_prefix}-search-${each.key}" }
}

resource "aws_lb_listener_rule" "search" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 80

  action {
    type = "forward"

    forward {
      target_group {
        arn    = aws_lb_target_group.search["blue"].arn
        weight = 100
      }
      target_group {
        arn    = aws_lb_target_group.search["green"].arn
        weight = 0
      }
    }
  }

  condition {
    host_header {
      values = ["${var.search_subdomain}.${var.control_plane_domain}"]
    }
  }

  # As above: the cutover owns these weights, and changing the shape of this block needs `-replace`.
  lifecycle {
    ignore_changes = [action]
  }
}

/*
  Tenant object storage. `/healthz` is exposed only after the process has resolved its refreshable
  AWS credential and checked the control-plane credential store during boot. Using the explicit
  readiness path also keeps health independent of the public S3 refusal shape.
*/
resource "aws_lb_target_group" "storage" {
  for_each = local.service_colours

  name     = "${var.name_prefix}-storage-${each.key}"
  port     = 9000
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

  deregistration_delay = 30
  tags                 = { Name = "${var.name_prefix}-storage-${each.key}" }
}

resource "aws_lb_listener_rule" "storage" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 75

  action {
    type = "forward"

    forward {
      target_group {
        arn    = aws_lb_target_group.storage["blue"].arn
        weight = 100
      }
      target_group {
        arn    = aws_lb_target_group.storage["green"].arn
        weight = 0
      }
    }
  }

  condition {
    host_header {
      values = ["${var.storage_subdomain}.${var.control_plane_domain}"]
    }
  }

  lifecycle {
    ignore_changes = [action]
  }
}

/*
  The LLM proxy: the router's fifth listener, on the ALB rather than the NLB.

  It speaks HTTP, so it belongs where TLS already terminates. That matters more than tidiness: a
  sandbox is a rented machine outside this VPC — Daytona's, not ours — and the token it carries goes
  over the public internet on every model call. The listener rule below is what makes the proxy
  reachable at all; without it `LLM_PROXY_URL` names a host that resolves to the ALB and matches no
  rule, which is a 404 on every agent turn and nothing in the router's logs to explain it.

  Health-checked on `/`, expecting 401, for exactly the reason `search` is: the proxy is a catch-all
  — every path is forwarded to the customer's model provider — so there is no path it can reserve
  without taking it away from a provider. A 200 would mean something answered; a 401 means the thing
  that answered checks tokens.
*/
resource "aws_lb_target_group" "llm" {
  for_each = local.service_colours

  name     = "${var.name_prefix}-llm-${each.key}"
  port     = 8788
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  health_check {
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "401"
  }

  /*
    Longer than the others, and the reason is the traffic.

    An agent turn is a single streaming response that legitimately runs for minutes. Draining a
    target in thirty seconds would cut every turn in flight at a cutover, and a customer watching
    their agent stop mid-sentence has no way to tell that from a crash.
  */
  deregistration_delay = 300
  tags                 = { Name = "${var.name_prefix}-llm-${each.key}" }
}

resource "aws_lb_listener_rule" "llm" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 70

  action {
    type = "forward"

    forward {
      target_group {
        arn    = aws_lb_target_group.llm["blue"].arn
        weight = 100
      }
      target_group {
        arn    = aws_lb_target_group.llm["green"].arn
        weight = 0
      }
    }
  }

  condition {
    host_header {
      values = ["${var.llm_subdomain}.${var.control_plane_domain}"]
    }
  }

  # The cutover owns these weights; changing the shape of this block needs `-replace`.
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

/*
  The tenant domain's own certificate.

  Separate from the one above because they cover different names and, more to the point, because a
  tenant hostname and the apex that authenticates our users should not be vouched for by the same
  certificate. `*.sproutos.run` is one label, same as the control plane's wildcard and for the same
  reason — which is why a preview host is `pr-42--myapp` and not `pr-42.myapp`.

  This is the *default* certificate for tenant traffic. Customer domains are not here: they arrive
  at runtime, one `aws_lb_listener_certificate` equivalent per domain added through the API, because
  a customer adding a domain cannot wait for an apply.
*/
resource "aws_acm_certificate" "tenant_apps" {
  domain_name               = var.tenant_domain
  subject_alternative_names = ["*.${var.tenant_domain}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${var.name_prefix}-tenant-cert" }
}

/*
  Attached to the listener rather than replacing its default.

  A listener has one default certificate and any number of additional ones chosen by SNI. The
  control plane's stays the default: it is what an unmatched request gets, and answering a stray
  connection with the tenant certificate would name a domain the visitor did not ask for.
*/
resource "aws_lb_listener_certificate" "tenant_apps" {
  listener_arn    = aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.tenant_apps.certificate_arn
}

# ---------------------------------------------------------------------------
# The instances
# ---------------------------------------------------------------------------

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

/*
  Five roles, because the ECS machine, legacy website, router, ordinary application, certificate
  worker, and ECS launcher do not all need the same powers.

  - **`instance`** — the ECS machine and the legacy website instance while that path remains.
  - **`router_instance`** — only the Rust router instances, which must read TLS private keys.
  - **`task`** — the application inside the containers. The website, the API and the worker.
  - **`acme_task`** — only the isolated certificate worker.
  - **`ecs_execution`** (in `ecs.tf`) — ECS itself, starting a task: pull the image, fetch the
    secret, write the logs.

  These were briefly one role, which was wrong in a way worth recording. Sharing `instance` with the
  tasks looked like avoiding duplication — the permissions the application needs really are the ones
  the old EC2 release needed. But the instance role also has to hold `ecs:RegisterContainerInstance`
  and the agent's poll and submit calls, and a shared role hands all of that to the customer-facing
  API process. The application does not register container instances.

  The *application* permissions are a policy of their own, attached to both, so they are written
  once and cannot drift while the EC2 path still exists.
*/
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

resource "aws_iam_role" "router_instance" {
  name = "${var.name_prefix}-router-instance"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# What the ECS agent needs to join the cluster and run work. Only the machine gets this.
resource "aws_iam_role_policy_attachment" "instance_ecs_agent" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_role" "task" {
  name = "${var.name_prefix}-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_role" "acme_task" {
  name = "${var.name_prefix}-acme-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

/*
  What the router is allowed to do.

  `lambda:InvokeFunction` on the tenant function prefix and nothing else. Not `*`: the router holds
  the platform's credential on a public-facing box, and the blast radius of that box being taken is
  bounded by this statement.
*/
resource "aws_iam_policy" "application" {
  name        = "${var.name_prefix}-application"
  description = "Shared application permissions for legacy services and ordinary ECS tasks."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["lambda:InvokeFunction"]
        Resource = [
          "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:sproutos-app-*",
          # The migration runner, invoked synchronously before a release takes traffic.
          "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:sproutos-migrate-*",
        ]
      },
      {
        /*
          Publishing a customer's function, which nothing was allowed to do.

          ADR 0026 made Lambda the customer compute, and the only Lambda permission this role ever
          had was `InvokeFunction` — so `publishFunction` could call a function it could not create.
          Every deployment in the account is `error`, which is why an `AccessDenied` here was never
          seen by anyone.

          Scoped to the two name prefixes `functionName()` and `runMigration()` build, so this
          cannot touch a platform function; `GetFunction` is included because `functionExists`
          decides between create and update by asking, and a denied read would look like "not
          there" and route every deploy into a create that then fails.
        */
        Effect = "Allow"
        Action = [
          "lambda:CreateFunction",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:PublishVersion",
          "lambda:CreateAlias",
          "lambda:GetAlias",
          "lambda:UpdateAlias",
          "lambda:DeleteFunction",
          "lambda:TagResource",
        ]
        Resource = [
          "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:sproutos-app-*",
          "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:sproutos-migrate-*",
        ]
      },
      {
        /*
          Attaching a layer requires permission to read its version.

          Two layers: the log extension, in this account, and AWS's public Lambda Web Adapter in
          753240598075. Both are addressed by ARN at publish time and neither is a wildcard.
        */
        Effect = "Allow"
        Action = ["lambda:GetLayerVersion"]
        Resource = [
          "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:layer:*",
          "arn:aws:lambda:${var.aws_region}:753240598075:layer:LambdaAdapterLayer*",
        ]
      },
      {
        /*
          Giving the customer's function its execution role.

          `CreateFunction` fails without `iam:PassRole`, and the error names the role rather than
          the missing permission. Scoped to the one role and conditioned on the service that may
          receive it, so this cannot be used to hand that role to anything but Lambda.
        */
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = aws_iam_role.lambda_execution.arn
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "lambda.amazonaws.com"
          }
        }
      },
      {
        # The release the instance boots from, and the pointer that names it.
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.artifacts.arn}/releases/*"
      },
      {
        /*
          The server certificate the Postgres split presents to tenants.

          S3 rather than Parameter Store because a certificate chain does not fit: the standard tier
          caps a value at 4096 characters and a Let's Encrypt fullchain is about 4800. The advanced
          tier would take it, and is billed per parameter per month for a file that is public by
          construction — every client that connects is handed a copy of it.

          Its private key is the secret half and is *not* here. That lives in Parameter Store as a
          SecureString and reaches the process through `LoadCredential`, so the two halves never sit
          in the same store and a read of this prefix yields nothing that can impersonate anything.
        */
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.artifacts.arn}/tls/*"
      },
      {
        /*
          The database password, which exists only in Secrets Manager.

          `manage_master_user_password` keeps it out of `terraform.tfstate`; the consequence is that
          the instance has to fetch it at boot to compose `DATABASE_URL`. Scoped to the one secret
          RDS manages for this instance, not to `*`.
        */
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_db_instance.control_plane.master_user_secret[0].secret_arn,
        ]
      },
      {
        /*
          The application's own secrets — GitHub OAuth, webhooks, Stripe — read once at boot.

          `GetParametersByPath` is authorized against the *path* rather than each parameter, so both
          ARNs are needed: the path itself and everything under it. Scoped to this one path, which
          is what stops the role reading any other parameter in the account.
        */
        Effect   = "Allow"
        Action   = ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"]
        Resource = local.application_parameter_arns
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
        Effect = "Allow"
        /*
          `GenerateDataKey` as well as `Decrypt`, because two of the buckets this key protects are
          *written* to: a PUT into an SSE-KMS bucket needs a data key, and without this S3 answers
          `AccessDenied` on PutObject while the thing refused is KMS — the same displaced error this
          comment already describes for reads. It applies to the assets bucket too, which has been
          grantable-but-unwritable since it was created and never exercised.

          Not a decrypt capability: a data key can be created without being able to read anything.
        */
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.secrets.arn
        Condition = {
          # Three services, because the same key protects the release in S3, the database password in
          # Secrets Manager, and the application's secrets in Parameter Store. Still a `ViaService`
          # list rather than an unconditional grant: this role cannot use the key directly, only
          # through the three services that hold things it is entitled to read.
          StringEquals = {
            "kms:ViaService" = [
              "s3.${var.aws_region}.amazonaws.com",
              "secretsmanager.${var.aws_region}.amazonaws.com",
              "ssm.${var.aws_region}.amazonaws.com",
            ]
          }
        }
      },
      {
        # Tenant object storage. Listing is limited to logical service prefixes in the one physical
        # bucket; no instance can list another platform bucket or the bucket root.
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:ListBucketVersions"]
        Resource = aws_s3_bucket.tenant_objects.arn
        Condition = {
          StringLike = {
            "s3:prefix" = ["v-*", "v-*/*"]
          }
        }
      },
      {
        # The proxy rewrites a customer's logical `v-<id>` bucket below this exact object prefix.
        # No bucket lifecycle or policy action is granted to the public-facing instances.
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource = [
          "${aws_s3_bucket.tenant_objects.arn}/v-*",
          "${aws_s3_bucket.tenant_objects.arn}/v-*/*",
        ]
      },
      {
        /*
          Tenant static assets, which this role signs uploads for rather than uploading itself.

          A presigned URL carries the *signer's* authority — the deploy action holds no AWS
          credential of its own — so without this the URL is generated happily and the tenant's PUT
          is refused by S3 with the signer named nowhere the tenant can see.

          Scoped to the `static/` prefix: the same bucket is shared by every project, and the key
          prefix is the tenancy boundary that `deploy.ts` builds from the deploy token.
        */
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
        Resource = [
          "${aws_s3_bucket.tenant_static.arn}/static/*",
          "${aws_s3_bucket.tenant_static.arn}/sites/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.tenant_static.arn
        Condition = {
          StringLike = {
            "s3:prefix" = ["static/*", "sites/*"]
          }
        }
      },
      {
        # The background worker imports only CloudFront's dedicated standard-v2 log prefix. It
        # cannot read any other log bucket or prefix, and never needs write/delete authority.
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.tenant_static_logs.arn}/tenant-static/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.tenant_static_logs.arn
        Condition = {
          StringLike = {
            "s3:prefix" = ["tenant-static/*"]
          }
        }
      },
      {
        # Provider aggregate totals are reconciliation input only. CloudWatch does not support
        # resource-level IAM for GetMetricStatistics; the job still requests the one configured
        # tenant-static distribution and cannot mutate metrics or manufacture tenant usage.
        Effect   = "Allow"
        Action   = ["cloudwatch:GetMetricStatistics"]
        Resource = "*"
      },
      {
        # The last write of a static release: one atomic hostname-to-digest pointer at the edge.
        Effect = "Allow"
        Action = [
          "cloudfront-keyvaluestore:DescribeKeyValueStore",
          "cloudfront-keyvaluestore:PutKey",
          "cloudfront-keyvaluestore:DeleteKey",
        ]
        Resource = aws_cloudfront_key_value_store.tenant_static.arn
      },
      {
        /*
          Tenant build archives — the other half of the same deploy, which had no grant at all.

          The comment above applies unchanged: a presigned URL carries the signer's authority, so
          without this the URL is generated happily and the customer's PUT is refused by S3 with a
          bare 403 in their CI log. `GetObject` as well as `PutObject` because `publishFunction`
          hands Lambda the bucket and key and Lambda reads it as us.

          A separate bucket from `artifacts` on purpose — see `tenant-builds.tf`.
        */
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.tenant_builds.arn}/builds/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.envelope.arn
      },
    ]
  })
}

/*
  Attached to every application principal for as long as the legacy EC2 paths exist.

  The EC2 Auto Scaling groups still run the tarball release while ECS is brought up beside them, so
  the same permissions are needed in two places. When the old groups are retired this attachment
  goes with them and only the task role keeps it.
*/
resource "aws_iam_role_policy_attachment" "instance_application" {
  role       = aws_iam_role.instance.name
  policy_arn = aws_iam_policy.application.arn
}

resource "aws_iam_role_policy_attachment" "router_instance_application" {
  role       = aws_iam_role.router_instance.name
  policy_arn = aws_iam_policy.application.arn
}

resource "aws_iam_role_policy_attachment" "task_application" {
  role       = aws_iam_role.task.name
  policy_arn = aws_iam_policy.application.arn
}

/*
  Router-only certificate reads. Keep private-key object access out of the public ECS website/API
  task role; the router instances read an exact immutable VersionId and never list the bucket.
*/
resource "aws_iam_policy" "router_certificate_read" {
  name        = "${var.name_prefix}-router-certificate-read"
  description = "Read exact versioned rustls certificate objects from router instances."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:GetObjectVersion"]
      Resource = "${aws_s3_bucket.tenant_certificates.arn}/*"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "router_instance_certificate_read" {
  role       = aws_iam_role.router_instance.name
  policy_arn = aws_iam_policy.router_certificate_read.arn
}

/*
  Static-tenant DNS mutation belongs to the isolated deployment/certificate worker, never to the
  public website/API task or Rust router.

  The legacy router instances and ECS control-plane task previously shared `application`, so the
  router inherited the ability to rewrite tenant records even though its data path only reads
  hostname routes from Valkey. The dedicated task may change only generated A/AAAA hosts below the
  tenant suffix; ACME TXT mutation remains in its separately constrained statement below.
*/
resource "aws_iam_policy" "control_plane_dns" {
  name        = "${var.name_prefix}-control-plane-dns"
  description = "Publish exact static tenant records from the control-plane worker."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets"]
        Resource = "arn:aws:route53:::hostedzone/${aws_route53_zone.tenant.zone_id}"
        Condition = {
          "ForAllValues:StringLike" = {
            "route53:ChangeResourceRecordSetsNormalizedRecordNames" = ["*.${var.tenant_domain}"]
          }
          "ForAllValues:StringEquals" = {
            "route53:ChangeResourceRecordSetsRecordTypes" = ["A", "AAAA"]
            "route53:ChangeResourceRecordSetsActions"     = ["UPSERT", "DELETE"]
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["route53:ListResourceRecordSets"]
        Resource = "arn:aws:route53:::hostedzone/${aws_route53_zone.tenant.zone_id}"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "acme_task_control_plane_dns" {
  role       = aws_iam_role.acme_task.name
  policy_arn = aws_iam_policy.control_plane_dns.arn
}

resource "aws_iam_role_policy_attachment" "acme_task_application" {
  role       = aws_iam_role.acme_task.name
  policy_arn = aws_iam_policy.application.arn
}

/*
  Certificate issuance is a control-plane responsibility, not a router capability.

  Keep the ACME account key, DNS-01 mutation, certificate-object writes, and router refresh grant
  off the shared application policy: that policy is also attached to the public-facing EC2/router
  role while the legacy release path exists. The current website/API/worker containers share one
  ECS task roles are shared by every container in a task, so the certificate poller is a separate
  task and role. The public website, API, ordinary worker, and routers receive no account-key,
  certificate-write, DNS-write, or restart capability. Static publication and teardown also run in
  the isolated task because they need the separately constrained generated-host A/AAAA grant.
*/
resource "aws_iam_policy" "acme_worker" {
  name        = "${var.name_prefix}-acme-worker"
  description = "Issue and publish tenant-edge certificates from the background worker."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.acme_account_key.arn
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
        ]
        Resource = "${aws_s3_bucket.tenant_certificates.arn}/*"
      },
      {
        # Account deletion purges every retained version of a tenant certificate's private key.
        Effect   = "Allow"
        Action   = ["s3:ListBucketVersions"]
        Resource = aws_s3_bucket.tenant_certificates.arn
        Condition = {
          StringLike = {
            "s3:prefix" = ["custom-domains/*", "platform-edge/*"]
          }
        }
      },
      {
        Sid      = "ChangeExactTenantAcmeTxt"
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets"]
        Resource = "arn:aws:route53:::hostedzone/${aws_route53_zone.tenant.zone_id}"
        Condition = {
          "ForAllValues:StringEquals" = {
            "route53:ChangeResourceRecordSetsNormalizedRecordNames" = ["_acme-challenge.${var.tenant_domain}"]
            "route53:ChangeResourceRecordSetsRecordTypes"           = ["TXT"]
            "route53:ChangeResourceRecordSetsActions"               = ["CREATE", "UPSERT", "DELETE"]
          }
        }
      },
      {
        Sid      = "ChangeExactEgressAcmeTxt"
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets"]
        Resource = "arn:aws:route53:::hostedzone/${data.aws_route53_zone.main.zone_id}"
        Condition = {
          "ForAllValues:StringEquals" = {
            "route53:ChangeResourceRecordSetsNormalizedRecordNames" = ["_acme-challenge.${var.egress_subdomain}.${var.control_plane_domain}"]
            "route53:ChangeResourceRecordSetsRecordTypes"           = ["TXT"]
            "route53:ChangeResourceRecordSetsActions"               = ["CREATE", "UPSERT", "DELETE"]
          }
        }
      },
      {
        Sid    = "ReadAcmeZones"
        Effect = "Allow"
        Action = ["route53:ListResourceRecordSets"]
        Resource = [
          "arn:aws:route53:::hostedzone/${aws_route53_zone.tenant.zone_id}",
          "arn:aws:route53:::hostedzone/${data.aws_route53_zone.main.zone_id}",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["route53:GetChange"]
        Resource = "arn:aws:route53:::change/*"
      },
      {
        Effect = "Allow"
        Action = ["autoscaling:StartInstanceRefresh"]
        # Constructed instead of referencing the ASGs so their launch template may depend on this
        # policy without introducing a Terraform dependency cycle.
        Resource = "arn:aws:autoscaling:${var.aws_region}:${var.aws_account_id}:autoScalingGroup:*:autoScalingGroupName/${var.name_prefix}-router-*"
      },
      {
        Effect   = "Allow"
        Action   = ["autoscaling:DescribeInstanceRefreshes"]
        Resource = "*"
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
        Action   = ["kms:GenerateDataKey"]
        Resource = aws_kms_key.secrets.arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com"
          }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "acme_task_worker" {
  role       = aws_iam_role.acme_task.name
  policy_arn = aws_iam_policy.acme_worker.arn
}

resource "aws_iam_role_policy_attachment" "instance_ssm" {
  role = aws_iam_role.instance.name
  # Session Manager instead of SSH. No key pairs to distribute, no port 22 open, and every session
  # is logged against an IAM principal.
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}


resource "aws_iam_role_policy_attachment" "router_instance_ssm" {
  role       = aws_iam_role.router_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name_prefix}-instance"
  role = aws_iam_role.instance.name
}

resource "aws_iam_instance_profile" "router" {
  name = "${var.name_prefix}-router-instance"
  role = aws_iam_role.router_instance.name
}

resource "aws_launch_template" "service" {
  for_each = toset(["website", "router"])

  name_prefix   = "${var.name_prefix}-${each.key}-"
  image_id      = data.aws_ssm_parameter.al2023_arm64.value
  instance_type = var.service_instance_type

  iam_instance_profile {
    arn = each.key == "router" ? aws_iam_instance_profile.router.arn : aws_iam_instance_profile.instance.arn
  }

  vpc_security_group_ids = [aws_security_group.service.id]

  /*
    Gzipped, not merely base64-encoded, because EC2 caps user data at 16384 bytes.

    That is a hard API limit on the *decoded* bytes and the script crossed it — `CreateLaunchTemplateVersion`
    answers `InvalidUserData.Malformed: User data is limited to 16384 bytes`, so a version is simply
    never created. The failure is at apply and it is loud, but it is loud in the wrong place: what it
    reads as is "OpenTofu could not write a launch template", not "the boot script is too long", and
    an apply whose output is being filtered for the interesting lines can lose it entirely.

    cloud-init sniffs the gzip magic bytes and decompresses before it decides what kind of user data
    this is, so nothing in the script changes. The script is 18,958 bytes and compresses to 8,147,
    which is not a close call — this is prose-heavy shell, and prose is what gzip is best at.

    The alternative was to cut the comments. They are the reason anybody can read this file, most of
    them exist because something in here was once wrong in a way that took hours to find, and buying
    room by deleting them would be paying in the only currency this file has.
  */
  user_data = base64gzip(templatefile("${path.module}/user-data.sh.tftpl", {
    service          = each.key
    artifacts_bucket = aws_s3_bucket.artifacts.bucket
    aws_region       = var.aws_region
    valkey_url       = "rediss://${aws_elasticache_replication_group.platform.primary_endpoint_address}:6379"
    tenant_domain    = var.tenant_domain

    lambda_web_adapter_layer_version = var.lambda_web_adapter_layer_version
    aws_account_id                   = var.aws_account_id

    # Kept in step with `.config/mise.toml` and the deploy workflow by hand, because three places
    # is already one too many. A mismatch means the release was built on one Node and runs on
    # another.
    node_version = var.node_version

    # Read at boot by both services now, to compose `DATABASE_URL`. The ARN is not a secret; what
    # it names is, and reading it needs each service's instance role.
    database_secret_arn        = aws_db_instance.control_plane.master_user_secret[0].secret_arn
    application_parameter_path = local.application_parameter_path
    envelope_kms_key_arn       = aws_kms_key.envelope.arn
    spa_asset_origin           = aws_cloudfront_distribution.spa.domain_name
    lambda_execution_role_arn  = aws_iam_role.lambda_execution.arn
    tenant_static_bucket       = aws_s3_bucket.tenant_static.id
    tenant_zone_id             = aws_route53_zone.tenant.zone_id
    tenant_static_distribution = aws_cloudfront_distribution.tenant_static.domain_name
    tenant_static_kvs_arn      = aws_cloudfront_key_value_store.tenant_static.arn
    tenant_builds_bucket       = aws_s3_bucket.tenant_builds.id
    database_endpoint          = aws_db_instance.control_plane.endpoint
    database_name              = aws_db_instance.control_plane.db_name

    # The backend the router's search split forwards to, on the OVH box behind its Traefik. Derived
    # rather than written down twice: `dns.tf` creates the record from the same variable, so the
    # name the instance is told and the name that resolves cannot drift apart.
    opensearch_subdomain            = var.opensearch_subdomain
    search_subdomain                = var.search_subdomain
    storage_subdomain               = var.storage_subdomain
    storage_proxy_enabled           = var.storage_proxy_enabled
    postgres_subdomain              = var.postgres_subdomain
    tenant_valkey_subdomain         = var.tenant_valkey_subdomain
    control_plane_domain            = var.control_plane_domain
    llm_subdomain                   = var.llm_subdomain
    egress_subdomain                = var.egress_subdomain
    tenant_objects_bucket           = aws_s3_bucket.tenant_objects.id
    tenant_certificate_bucket       = aws_s3_bucket.tenant_certificates.id
    tenant_certificate_kms_key_arn  = aws_kms_key.secrets.arn
    platform_certificate_object_key = "platform-edge/current.json"
    acme_account_key_secret_id      = aws_secretsmanager_secret.acme_account_key.id
    acme_directory_url              = var.acme_directory_url
    tenant_edge_runtime_enabled     = var.tenant_edge_enabled || var.tenant_edge_preview_enabled
    tenant_ingress_host             = var.tenant_edge_enabled ? "ingress.${var.tenant_domain}" : "preview-ingress.${var.tenant_domain}"
    tenant_ingress_ipv4_addresses   = join(",", aws_eip.tenant_edge[*].public_ip)
    tenant_ingress_ipv6_addresses   = local.tenant_edge_provisioned ? join(",", local.tenant_edge_ipv6_addresses) : ""
    custom_domains_enabled          = var.custom_domain_issuance_enabled
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
  # Both, because both listeners run in this process. A target group is a port on a set of
  # instances, not a fleet of its own — the same reasoning as the website's pair above.
  #
  # Adding the group without adding it here creates a target group with no targets, which the
  # console shows as a healthy-looking resource and the load balancer answers 503 from. Nothing
  # errors: `search.<domain>` simply has nowhere to send a request.
  target_group_arns = concat(
    [
      aws_lb_target_group.router[each.key].arn,
      aws_lb_target_group.search[each.key].arn,
      # The LLM proxy, which is where a sandbox's model traffic goes. Missing from this list it would
      # be a target group with no targets: healthy-looking in the console, 503 from the balancer, and
      # nothing in any log saying why every agent turn failed.
      aws_lb_target_group.llm[each.key].arn,
      # Postgres, Valkey, and both ports of the Rust tenant edge on the network load balancer.
      # HTTPS also dispatches authenticated sandbox egress by SNI — see `nlb.tf`.
      aws_lb_target_group.postgres[each.key].arn,
      aws_lb_target_group.valkey[each.key].arn,
      aws_lb_target_group.forward_proxy[each.key].arn,
    ],
    /*
      A staged rollout, not merely an optional feature.

      With ELB health checks enabled AWS requires every attached target group to report healthy. If
      this group is attached while the serving release predates `storage-proxy`, port 9000 is down,
      Auto Scaling replaces that otherwise-healthy router, and the replacement repeats the failure.
      The false default lets infrastructure and the binary land first; a later explicit apply enrolls
      storage in replacement health only after the process has been observed healthy.
    */
    var.storage_proxy_enabled ? [aws_lb_target_group.storage[each.key].arn] : [],
    var.tenant_edge_enabled || var.tenant_edge_preview_enabled ? [
      aws_lb_target_group.tenant_https[each.key].arn,
      aws_lb_target_group.tenant_http[each.key].arn,
    ] : [],
  )

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

/*
  Tenant HTTPS no longer increments the ALB request metric once generated and custom hosts move to
  the NLB. ActiveFlowCount is the concurrent work the TCP edge is actually holding. The raw NLB
  metric is a target-group total, so tracking it directly would keep the same value after adding a
  router and could scale to max without relieving the alarm. Divide by HealthyHostCount to produce
  a per-serving-router signal that falls when capacity is added. IF also keeps metric math defined
  while an idle colour has no healthy targets.

  Multiple target-tracking policies are intentional; Auto Scaling chooses enough capacity to
  satisfy either the remaining ALB service traffic or the tenant edge. Scale-in remains disabled
  because blue/green deployment owns draining an idle colour.
*/
resource "aws_autoscaling_policy" "router_tenant_edge" {
  for_each = local.tenant_edge_provisioned ? local.service_colours : toset([])

  name                   = "${var.name_prefix}-router-${each.key}-tenant-edge-flows"
  autoscaling_group_name = aws_autoscaling_group.router[each.key].name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    customized_metric_specification {
      metrics {
        id          = "flows"
        return_data = false

        metric_stat {
          period = 60
          stat   = "Average"

          metric {
            metric_name = "ActiveFlowCount"
            namespace   = "AWS/NetworkELB"

            dimensions {
              name  = "LoadBalancer"
              value = aws_lb.tenant_edge[0].arn_suffix
            }
            dimensions {
              name  = "TargetGroup"
              value = aws_lb_target_group.tenant_https[each.key].arn_suffix
            }
          }
        }
      }

      metrics {
        id          = "healthy"
        return_data = false

        metric_stat {
          period = 60
          stat   = "Average"

          metric {
            metric_name = "HealthyHostCount"
            namespace   = "AWS/NetworkELB"

            dimensions {
              name  = "LoadBalancer"
              value = aws_lb.tenant_edge[0].arn_suffix
            }
            dimensions {
              name  = "TargetGroup"
              value = aws_lb_target_group.tenant_https[each.key].arn_suffix
            }
          }
        }
      }

      metrics {
        id          = "flows_per_target"
        expression  = "flows / IF(healthy > 0, healthy, 1)"
        label       = "Tenant edge active TCP flows per healthy router"
        return_data = true
      }
    }

    target_value     = var.tenant_edge_active_flows_per_target
    disable_scale_in = true
  }
}
