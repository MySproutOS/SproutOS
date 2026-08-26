# The tenant data-plane load balancer.
#
# A second load balancer, and it is not a duplication of the first. The ALB carries HTTP and routes
# on the `Host` header — that is what separates the website, the API, search and the unbounded set of
# tenant hostnames across four target groups on one port. Postgres and RESP are not HTTP and carry no
# host header, so an ALB cannot see them and a network load balancer cannot see the four things the
# ALB is separating. Neither one replaces the other.
#
# **Replacing the ALB with this was considered and rejected.** It is not a saving: both are
# $0.0225/hour. The straight swap collapses those four Host-based destinations into one, and "let the
# router dispatch by Host instead" does not rescue it while the website and the router are separate
# Auto Scaling groups on separate instances — the router would have to become a load balancer across
# another fleet. It would also take out both `ALBRequestCountPerTarget` scaling policies, which have
# no network-load-balancer equivalent, and the port-80 redirect, which is an ALB action.
#
# The cost is therefore real and additive: about $16.43/month for the balancer plus two public IPv4
# addresses. There is no free tier absorbing it — this account bills `LoadBalancerUsage` at full rate
# and Cost Explorer has shown no `Credit` record in three months.

resource "aws_security_group" "tenant_nlb" {
  name        = "${var.name_prefix}-tenant-nlb"
  description = "The tenant data plane's load balancer"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name_prefix}-tenant-nlb" }
}

# The whole internet, deliberately. A customer's application connects from wherever they run it, and
# there is no address to narrow this to. What stands in front of the data is the proxy behind this
# port: it authenticates the tenant against `service_credential` and drops its own privilege with
# `SET ROLE` before any session is spliced.
resource "aws_vpc_security_group_ingress_rule" "tenant_nlb_postgres" {
  security_group_id = aws_security_group.tenant_nlb.id
  description       = "Postgres wire protocol from customers"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
}

resource "aws_vpc_security_group_egress_rule" "tenant_nlb_out" {
  security_group_id = aws_security_group.tenant_nlb.id
  description       = "To the router instances"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_lb" "tenant" {
  name               = "${var.name_prefix}-tenant-nlb"
  load_balancer_type = "network"
  security_groups    = [aws_security_group.tenant_nlb.id]

  # The same two subnets as the ALB, for the same reason and at the same price: one public IPv4
  # address per subnet spanned, billed since 1 February 2024, and two availability zones is the
  # floor AWS accepts rather than a choice.
  subnets = slice(aws_subnet.public[*].id, 0, local.serving_zone_count)

  # A database connection is long-lived and mostly idle — a connection pool holds one open between
  # queries for as long as the application runs. The default 350-second idle timeout would close
  # those from underneath the pool, which surfaces in the customer's logs as a connection reset with
  # nothing on our side having failed.
  enable_cross_zone_load_balancing = true

  enable_deletion_protection = var.deletion_protection
  tags                       = { Name = "${var.name_prefix}-tenant-nlb" }
}

/*
  The Postgres split's target groups.

  Health-checked over **HTTP on 8080**, not by opening a TCP connection to 5432. Two reasons, and the
  second is the one that matters.

  A TCP health check proves a socket accepts, which for a wire-protocol proxy means it proves almost
  nothing: `pg-proxy` accepts the connection and then waits for a startup packet that a health check
  never sends, so every probe would be a session the proxy opens, logs and abandons. Twice a minute,
  per target, forever.

  And `/healthz` is a stronger signal than the port being open, because `CredentialStore::check()` is
  fatal at boot. A router that cannot reach the control-plane database does not start and serve a
  Postgres port that refuses everybody — it exits, and the Auto Scaling group replaces it. So a
  router answering `/healthz` is a router whose Postgres split authenticated its way to the control
  plane, which is exactly the condition worth checking.
*/
resource "aws_lb_target_group" "postgres" {
  for_each = local.service_colours

  name     = "${var.name_prefix}-pg-${each.key}"
  port     = 5432
  protocol = "TCP"
  vpc_id   = aws_vpc.main.id

  /*
    Client IP preservation off, which is a security-group decision rather than a privacy one.

    With it on, a target sees the customer's address as the source and the instance's security group
    must therefore admit `0.0.0.0/0` on 5432 — the rule referencing this balancer's own group would
    never match. Off, the targets see the balancer, the reference works, and the port stays closed to
    everything that does not arrive through it.

    The cost is that `pg-proxy` logs the balancer's address rather than the customer's on a refused
    password. Worth it: the alternative is a database port open to the internet at the network layer
    and relying entirely on the proxy to be the only thing listening.
  */
  preserve_client_ip = false

  health_check {
    protocol            = "HTTP"
    path                = "/healthz"
    port                = "8080"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    matcher             = "200"
  }

  deregistration_delay = 30
  tags                 = { Name = "${var.name_prefix}-pg-${each.key}" }
}

/*
  TCP, not TLS, and this is the one thing about this file that is not good enough.

  A TLS listener would terminate the customer's encryption here and forward plaintext inside the VPC,
  which is what the Valkey listener does. Postgres cannot work that way: it negotiates TLS *inside*
  its own protocol — the client connects in the clear and sends `SSLRequest`, and the server answers
  `S` or `N` — so there is no TLS handshake at the front of the connection for a listener to
  terminate.

  `pg-proxy` answers `N`. Its own comment is honest about it: "In production this proxy is behind a
  TLS terminator and the honest answer changes". There is no TLS terminator that can sit in front of
  Postgres, so the answer that changes has to come from the proxy itself, and it has not been
  written yet.

  **Until it is, a customer's database traffic crosses the public internet unencrypted.** That is
  recorded here rather than in a ticket because this listener is the thing that makes it reachable,
  and whoever reads this file next should not have to discover it from the wire.
*/
resource "aws_lb_listener" "postgres" {
  load_balancer_arn = aws_lb.tenant.arn
  port              = 5432
  protocol          = "TCP"

  default_action {
    type = "forward"

    forward {
      target_group {
        arn    = aws_lb_target_group.postgres["blue"].arn
        weight = 100
      }
      target_group {
        arn    = aws_lb_target_group.postgres["green"].arn
        weight = 0
      }
    }
  }

  # The cutover owns the weights, exactly as it does on the ALB. Changing the *shape* of this block
  # is invisible to a plan and needs `-replace` — see the listener in `compute.tf`, where that cost
  # was paid once already.
  lifecycle {
    ignore_changes = [default_action]
  }
}

# The router's port, reachable from this balancer and from nothing else.
resource "aws_vpc_security_group_ingress_rule" "service_postgres_from_nlb" {
  security_group_id            = aws_security_group.service.id
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tenant_nlb.id
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres split from the tenant load balancer"
}

# And the health check, which arrives on 8080 from the same place.
resource "aws_vpc_security_group_ingress_rule" "service_health_from_nlb" {
  security_group_id            = aws_security_group.service.id
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tenant_nlb.id
  from_port                    = 8080
  to_port                      = 8080
  description                  = "Health checks from the tenant load balancer"
}

/*
  `postgres.<domain>`, an alias to the balancer.

  An explicit record even though `*.<domain>` already resolves, because that wildcard points at the
  ALB — an exact record beats a wildcard in Route 53, and without this a customer's `psql` would
  reach an application load balancer that has never heard of the Postgres wire protocol.
*/
resource "aws_route53_record" "postgres" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${var.postgres_subdomain}.${var.control_plane_domain}"
  type    = "A"

  alias {
    name                   = aws_lb.tenant.dns_name
    zone_id                = aws_lb.tenant.zone_id
    evaluate_target_health = false
  }
}

# ---------------------------------------------------------------------------
# The Valkey split
# ---------------------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "tenant_nlb_valkey" {
  security_group_id = aws_security_group.tenant_nlb.id
  description       = "RESP over TLS from customers"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 6379
  to_port           = 6379
}

resource "aws_lb_target_group" "valkey" {
  for_each = local.service_colours

  name     = "${var.name_prefix}-valkey-${each.key}"
  port     = 6379
  protocol = "TCP"
  vpc_id   = aws_vpc.main.id

  # Same reasoning as the Postgres group above: the targets see this balancer rather than the
  # customer, so the instance security group can reference this one instead of admitting the
  # internet on 6379.
  preserve_client_ip = false

  # And the same health check, for the same reason: RESP has no idle greeting to check, and a
  # router answering `/healthz` is a router whose splits reached the control plane, because
  # `CredentialStore::check()` is fatal at boot.
  health_check {
    protocol            = "HTTP"
    path                = "/healthz"
    port                = "8080"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    matcher             = "200"
  }

  deregistration_delay = 30
  tags                 = { Name = "${var.name_prefix}-valkey-${each.key}" }
}

/*
  TLS here, unlike Postgres, and the difference is the protocol rather than the policy.

  RESP carries no in-band upgrade: a client that asks for `rediss://` opens a TLS connection and
  speaks RESP inside it, so there *is* a handshake at the front for a listener to terminate. Postgres
  negotiates inside its own protocol and therefore cannot be terminated here at all — see the comment
  on that listener.

  So a customer's Valkey traffic is encrypted end to end and their Postgres traffic is not, which is
  an honest statement of where the work has got to rather than a design.
*/
resource "aws_lb_listener" "valkey" {
  load_balancer_arn = aws_lb.tenant.arn
  port              = 6379
  protocol          = "TLS"
  certificate_arn   = aws_acm_certificate.tenant.arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type = "forward"

    forward {
      target_group {
        arn    = aws_lb_target_group.valkey["blue"].arn
        weight = 100
      }
      target_group {
        arn    = aws_lb_target_group.valkey["green"].arn
        weight = 0
      }
    }
  }

  lifecycle {
    ignore_changes = [default_action]
  }
}

resource "aws_vpc_security_group_ingress_rule" "service_valkey_from_nlb" {
  security_group_id            = aws_security_group.service.id
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tenant_nlb.id
  from_port                    = 6379
  to_port                      = 6379
  description                  = "Valkey split from the tenant load balancer"
}
