# The tenant data-plane load balancer.
#
# It complements rather than replaces the control-plane ALB. The website and API stay on ALB rules;
# generated/custom tenant HTTP, sandbox egress, Postgres, and Valkey enter here. TCP 443 passes TLS
# through to Rust, which owns certificates and dispatches tenant HTTP versus authenticated CONNECT
# by SNI. Static projects remain the deliberate exception at CloudFront.
#
# Moving tenant HTTP here removes it from ALBRequestCountPerTarget, so the router also scales on the
# NLB target group's NewFlowCount. Port 80 is a real Rust listener for HTTP-01 and redirects, not an
# NLB redirect action.
#
# The cost is therefore real and additive: about $16.43/month for the balancer plus two public IPv4
# addresses. There is no free tier absorbing it — this account bills `LoadBalancerUsage` at full rate
# and Cost Explorer has shown no `Credit` record in three months.

resource "aws_security_group" "tenant_nlb" {
  name = "${var.name_prefix}-tenant-nlb"
  # No apostrophe. AWS restricts security group descriptions to a character set that excludes it,
  # and rejects the whole `CreateSecurityGroup` call — after the rest of the apply has run.
  description = "Tenant data plane load balancer"
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
  # One NLB owns every tenant protocol. Stable zonal EIPs support apex customer domains whose DNS
  # provider cannot flatten a CNAME; dual stack carries IPv6 clients to the same Rust listeners.
  ip_address_type = "dualstack"
  dynamic "subnet_mapping" {
    for_each = range(local.serving_zone_count)
    content {
      subnet_id     = aws_subnet.public[subnet_mapping.value].id
      allocation_id = aws_eip.tenant_edge[subnet_mapping.value].id
      ipv6_address  = local.tenant_edge_ipv6_addresses[subnet_mapping.value]
    }
  }

  # A database connection is long-lived and mostly idle — a connection pool holds one open between
  # queries for as long as the application runs. The default 350-second idle timeout would close
  # those from underneath the pool, which surfaces in the customer's logs as a connection reset with
  # nothing on our side having failed.
  enable_cross_zone_load_balancing = true

  enable_deletion_protection = var.deletion_protection
  tags                       = { Name = "${var.name_prefix}-tenant-nlb" }

  # ELBv2 returns the IPv4 allocation and IPv6 address as separate address objects. The AWS
  # provider flattens only the EIP-backed object into state, then proposes empty extra mappings and
  # re-adding the IPv6 values on every refresh. AWS already owns the requested fixed addresses (and
  # its API is the rollout assertion), so suppress that provider-only normalization churn.
  lifecycle {
    ignore_changes = [subnet_mapping]
  }
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

# ---------------------------------------------------------------------------
# The Rust tenant HTTP/TLS edge
# ---------------------------------------------------------------------------

locals {
  tenant_edge_provisioned = var.tenant_edge_preview_enabled || var.tenant_edge_enabled
  # Pin one address in each /64 so apex providers without ALIAS/ANAME can publish the same stable
  # IPv6 frontend that the dual-stack NLB advertises. AWS otherwise assigns an address but the
  # provider does not expose an omitted `subnet_mapping.ipv6_address` as a computed value.
  tenant_edge_ipv6_addresses = [
    for index in range(local.serving_zone_count) : cidrhost(aws_subnet.public[index].ipv6_cidr_block, 100)
  ]
}

# One stable IPv4 address per serving subnet. The dual-stack NLB supplies stable zonal IPv6
# addresses and publishes them through its AAAA response; customer A-only apex fallback uses these
# explicit EIPs, while CNAME/ALIAS/ANAME traffic receives both address families.
resource "aws_eip" "tenant_edge" {
  count  = local.serving_zone_count
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.name_prefix}-tenant-edge-${count.index + 1}" })
}

# Public deliberately. TLS stays encrypted through the NLB; rustls selects generated/custom tenant
# HTTP or the authenticated sandbox CONNECT proxy from SNI and refuses every unknown hostname.
resource "aws_vpc_security_group_ingress_rule" "tenant_nlb_forward_proxy" {
  security_group_id = aws_security_group.tenant_nlb.id
  description       = "Tenant HTTPS and authenticated sandbox egress"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# Daytona's HTTPS-upstream chaining currently returns 502 before a CONNECT request reaches Rust.
# This is the same authenticated proxy and the same NLB, exposed as a cleartext HTTP upstream; TLS
# to each HTTPS destination remains end-to-end inside CONNECT. Remove this listener when Daytona's
# documented HTTPS upstream mode works in production.
resource "aws_vpc_security_group_ingress_rule" "tenant_nlb_forward_proxy_http" {
  security_group_id = aws_security_group.tenant_nlb.id
  description       = "Authenticated Daytona HTTP upstream proxy"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 3128
  to_port           = 3128
}

resource "aws_vpc_security_group_ingress_rule" "tenant_edge_https" {
  count = var.tenant_edge_preview_enabled ? 1 : 0

  security_group_id = aws_security_group.tenant_nlb.id
  description       = "Temporary Rust TLS edge preview"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 8444
  to_port           = 8444
}

resource "aws_vpc_security_group_ingress_rule" "tenant_edge_https_ipv6" {
  count = var.tenant_edge_preview_enabled ? 1 : 0

  security_group_id = aws_security_group.tenant_nlb.id
  description       = "Temporary IPv6 Rust TLS edge preview"
  cidr_ipv6         = "::/0"
  ip_protocol       = "tcp"
  from_port         = 8444
  to_port           = 8444
}

resource "aws_lb_target_group" "forward_proxy" {
  for_each = local.service_colours

  # `egress` is also the short name used by `bin/cutover.sh`; keep the two identical so a router
  # release can derive these groups rather than carrying another pair of mutable ARNs.
  name     = "${var.name_prefix}-egress-${each.key}"
  port     = 3128
  protocol = "TCP"
  vpc_id   = aws_vpc.main.id

  # Legacy pre-edge path. The NLB terminates TLS and the router receives CONNECT on 3128 until the
  # staged rustls edge passes its high-port smoke and tenant_edge_enabled is flipped.
  preserve_client_ip = false

  # The forward proxy is another listener in the router process. Its honest readiness signal is the
  # shared HTTP endpoint, rather than an unauthenticated synthetic CONNECT on the public protocol.
  health_check {
    protocol            = "HTTP"
    path                = "/healthz"
    port                = "8080"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    matcher             = "200"
  }

  # CONNECT tunnels are bounded to five minutes in the proxy. Give the old colour that same drain
  # window so cutover does not truncate a package download or Git fetch mid-transfer.
  deregistration_delay = 300
  tags                 = { Name = "${var.name_prefix}-egress-${each.key}" }
}

resource "aws_lb_target_group" "tenant_https" {
  for_each = local.service_colours

  name     = "${var.name_prefix}-edge-${each.key}"
  port     = 8443
  protocol = "TCP"
  vpc_id   = aws_vpc.main.id
  # Dual-stack NLB traffic reaches the IPv4 instance target through address-family translation, so
  # the socket peer cannot preserve an IPv6 viewer. PPv2 is scoped to these two new edge groups and
  # is parsed before TLS/HTTP; existing Postgres, Valkey, egress, and health paths remain unchanged.
  preserve_client_ip = false
  proxy_protocol_v2  = true

  health_check {
    protocol            = "HTTP"
    path                = "/ready/tls"
    port                = "8082"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    matcher             = "200"
  }

  deregistration_delay = 300
  tags                 = { Name = "${var.name_prefix}-edge-${each.key}" }
}

# Changing the public :443 protocol is deliberately a listener replacement. Besides making the
# TLS-to-TCP transition explicit in a saved plan, replacement causes AWS to install the configured
# Rust-edge target groups instead of preserving the blue/green action that cutover scripts own.
resource "terraform_data" "tenant_edge_mode" {
  triggers_replace = var.tenant_edge_enabled
}

resource "aws_lb_listener" "forward_proxy" {
  load_balancer_arn = aws_lb.tenant.arn
  port              = 443
  protocol          = var.tenant_edge_enabled ? "TCP" : "TLS"
  certificate_arn   = var.tenant_edge_enabled ? null : aws_acm_certificate.tenant.arn
  ssl_policy        = var.tenant_edge_enabled ? null : "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type = "forward"

    forward {
      target_group {
        arn    = var.tenant_edge_enabled ? aws_lb_target_group.tenant_https["blue"].arn : aws_lb_target_group.forward_proxy["blue"].arn
        weight = 100
      }
      target_group {
        arn    = var.tenant_edge_enabled ? aws_lb_target_group.tenant_https["green"].arn : aws_lb_target_group.forward_proxy["green"].arn
        weight = 0
      }
    }
  }

  lifecycle {
    ignore_changes       = [default_action]
    replace_triggered_by = [terraform_data.tenant_edge_mode]
  }
}

resource "aws_lb_listener" "forward_proxy_http" {
  load_balancer_arn = aws_lb.tenant.arn
  port              = 3128
  protocol          = "TCP"

  default_action {
    type = "forward"

    forward {
      target_group {
        arn    = aws_lb_target_group.forward_proxy["blue"].arn
        weight = 100
      }
      target_group {
        arn    = aws_lb_target_group.forward_proxy["green"].arn
        weight = 0
      }
    }
  }

  # Blue/green cutover owns the weights after the listener is created.
  lifecycle { ignore_changes = [default_action] }
}

resource "aws_lb_listener" "tenant_https" {
  count = var.tenant_edge_preview_enabled ? 1 : 0

  load_balancer_arn = aws_lb.tenant.arn
  port              = 8444
  protocol          = "TCP"

  default_action {
    type = "forward"
    forward {
      target_group {
        arn    = aws_lb_target_group.tenant_https["blue"].arn
        weight = var.tenant_edge_preview_colour == "blue" ? 100 : 0
      }
      target_group {
        arn    = aws_lb_target_group.tenant_https["green"].arn
        weight = var.tenant_edge_preview_colour == "green" ? 100 : 0
      }
    }
  }

  # Created once for preview and retained through cutover. The selected preview colour is the
  # initial owner; after that bin/cutover.sh owns both weights just like the other listeners.
  lifecycle { ignore_changes = [default_action] }
}

resource "aws_vpc_security_group_ingress_rule" "service_forward_proxy_from_nlb" {
  security_group_id            = aws_security_group.service.id
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tenant_nlb.id
  from_port                    = 3128
  to_port                      = 3128
  description                  = "Legacy sandbox forward proxy from the tenant load balancer"
}

resource "aws_vpc_security_group_ingress_rule" "service_tenant_https_from_nlb" {
  security_group_id            = aws_security_group.service.id
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tenant_nlb.id
  from_port                    = 8443
  to_port                      = 8443
  description                  = "Rust tenant TLS edge from the tenant load balancer"
}

resource "aws_vpc_security_group_ingress_rule" "tenant_nlb_http" {
  count = local.tenant_edge_provisioned ? 1 : 0

  security_group_id = aws_security_group.tenant_nlb.id
  description       = "ACME HTTP-01 and tenant HTTPS redirects"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "tenant_nlb_http_ipv6" {
  count = local.tenant_edge_provisioned ? 1 : 0

  security_group_id = aws_security_group.tenant_nlb.id
  description       = "IPv6 ACME HTTP-01 and tenant HTTPS redirects"
  cidr_ipv6         = "::/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_lb_target_group" "tenant_http" {
  for_each = local.service_colours

  name               = "${var.name_prefix}-edge-http-${each.key}"
  port               = 8081
  protocol           = "TCP"
  vpc_id             = aws_vpc.main.id
  preserve_client_ip = false
  proxy_protocol_v2  = true

  health_check {
    protocol            = "HTTP"
    path                = "/ready/http"
    port                = "8082"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    matcher             = "200"
  }

  deregistration_delay = 30
  tags                 = { Name = "${var.name_prefix}-edge-http-${each.key}" }
}

resource "aws_lb_listener" "tenant_http" {
  count = local.tenant_edge_provisioned ? 1 : 0

  load_balancer_arn = aws_lb.tenant.arn
  port              = 80
  protocol          = "TCP"

  default_action {
    type = "forward"

    forward {
      target_group {
        arn    = aws_lb_target_group.tenant_http["blue"].arn
        weight = var.tenant_edge_preview_colour == "blue" ? 100 : 0
      }
      target_group {
        arn    = aws_lb_target_group.tenant_http["green"].arn
        weight = var.tenant_edge_preview_colour == "green" ? 100 : 0
      }
    }
  }

  lifecycle {
    # Same persistent preview-to-production listener contract as HTTPS above.
    ignore_changes = [default_action]
  }
}

resource "aws_vpc_security_group_ingress_rule" "service_tenant_http_from_nlb" {
  security_group_id            = aws_security_group.service.id
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tenant_nlb.id
  from_port                    = 8081
  to_port                      = 8081
  description                  = "Rust tenant HTTP and ACME edge from the tenant load balancer"
}

resource "aws_vpc_security_group_ingress_rule" "service_tenant_edge_readiness_from_nlb" {
  security_group_id            = aws_security_group.service.id
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tenant_nlb.id
  from_port                    = 8082
  to_port                      = 8082
  description                  = "Proxy Protocol tenant edge readiness from its load balancer"
}

/*
  `egress.<domain>`, an exact alias to the tenant NLB.

  The control-plane wildcard resolves to the ALB, so relying on it would send CONNECT requests to
  the wrong load balancer. As with Postgres, the exact record wins over that wildcard.
*/
resource "aws_route53_record" "forward_proxy" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${var.egress_subdomain}.${var.control_plane_domain}"
  type    = "A"

  alias {
    name                   = aws_lb.tenant.dns_name
    zone_id                = aws_lb.tenant.zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "forward_proxy_ipv6" {
  count = 1

  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${var.egress_subdomain}.${var.control_plane_domain}"
  type    = "AAAA"

  alias {
    name                   = aws_lb.tenant.dns_name
    zone_id                = aws_lb.tenant.zone_id
    evaluate_target_health = false
  }
}

/*
  One stable traffic name for customer DNS instructions. Subdomains CNAME here; apex providers may
  flatten it, and providers without flattening use the EIP A records returned by the API.
*/
resource "aws_route53_record" "tenant_ingress" {
  zone_id = aws_route53_zone.tenant.zone_id
  name    = "ingress.${var.tenant_domain}"
  type    = "A"

  alias {
    name                   = aws_lb.tenant.dns_name
    zone_id                = aws_lb.tenant.zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "tenant_ingress_ipv6" {
  count = 1

  zone_id = aws_route53_zone.tenant.zone_id
  name    = "ingress.${var.tenant_domain}"
  type    = "AAAA"

  alias {
    name                   = aws_lb.tenant.dns_name
    zone_id                = aws_lb.tenant.zone_id
    evaluate_target_health = false
  }
}

# A stable, non-production name for exercising platform certificates, HTTP-01, custom-domain SNI,
# and both address families before generated traffic moves. Keep it after cutover so a staging test
# hostname is not broken merely because the production listener replaced the preview listener.
resource "aws_route53_record" "tenant_edge_preview" {
  count = local.tenant_edge_provisioned ? 1 : 0

  zone_id = aws_route53_zone.tenant.zone_id
  name    = "preview-ingress.${var.tenant_domain}"
  type    = "A"

  alias {
    name                   = aws_lb.tenant.dns_name
    zone_id                = aws_lb.tenant.zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "tenant_edge_preview_ipv6" {
  count = local.tenant_edge_provisioned ? 1 : 0

  zone_id = aws_route53_zone.tenant.zone_id
  name    = "preview-ingress.${var.tenant_domain}"
  type    = "AAAA"

  alias {
    name                   = aws_lb.tenant.dns_name
    zone_id                = aws_lb.tenant.zone_id
    evaluate_target_health = false
  }
}
