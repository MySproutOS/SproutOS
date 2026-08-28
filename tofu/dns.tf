/*
  DNS, and the certificate validation that depends on it.

  The hosted zone is not created here. `sproutos.me` was registered at Namecheap and delegated to
  Route 53 by hand, and a `aws_route53_zone` resource would create a *second* zone with different
  name servers — the delegation would still point at the first, and nothing would resolve. Adopting
  the existing zone by data source is the only correct shape for a domain registered elsewhere.
*/

data "aws_route53_zone" "main" {
  name         = "${var.control_plane_domain}."
  private_zone = false
}

/*
  The tenant zone, which *is* created here — unlike the one above.

  The comment at the top of this file explains why `sproutos.me` is a data source: it was delegated
  to Route 53 by hand, so a resource would create a second zone with different name servers and the
  delegation would still point at the first.

  `sproutos.run` is the opposite situation and needs the opposite shape. Nothing has been delegated
  yet, so there is no zone to adopt — one has to exist before Namecheap can be pointed at anything.
  The order is: create this, read its name servers, set them at the registrar, and only then let
  ACM try to validate. A certificate requested before delegation resolves sits in
  `PENDING_VALIDATION` until it times out, because the validation record is published somewhere the
  world is not yet asking.
*/
resource "aws_route53_zone" "tenant" {
  name = "${var.tenant_domain}."

  comment = "Tenant applications. Delegated from Namecheap; see ADR 0018."

  tags = {
    Name = var.tenant_domain
  }
}

# ---------------------------------------------------------------------------
# Certificate validation
# ---------------------------------------------------------------------------

/*
  One record per distinct validation name.

  ACM returns one option per name on the certificate, and for `example.com` plus `*.example.com`
  both options are frequently the *same* record — same name, same value. Creating two records with
  one name is a duplicate-resource error, so the options are keyed by name and de-duplicated. This
  is the standard shape and it exists for exactly that case.
*/
resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.tenant.domain_validation_options :
    option.domain_name => {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }...
  }

  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value[0].name
  type    = each.value[0].type
  records = [each.value[0].value]
  ttl     = 60

  # ACM rotates these when the certificate is replaced, and a stale record blocks the new one.
  allow_overwrite = true
}

/*
  Blocks until ACM has actually seen the records.

  Without this the listener can be created with a certificate still in `PENDING_VALIDATION`, which
  AWS accepts and then serves nothing on — a load balancer that exists, answers TCP, and fails every
  handshake, with the cause three resources away.
*/
resource "aws_acm_certificate_validation" "tenant" {
  certificate_arn         = aws_acm_certificate.tenant.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

# ---------------------------------------------------------------------------
# What points at the load balancer
# ---------------------------------------------------------------------------

/*
  Alias records, not CNAMEs.

  A zone apex cannot hold a CNAME — that is DNS, not AWS — so `sproutos.me` has to be an alias.
  Aliases are also free to resolve where a CNAME is billed per query, which at one lookup per
  tenant request is not nothing.

  `evaluate_target_health = false` deliberately: with one load balancer there is nowhere to fail
  over to, and a health evaluation that removed the record would take the domain out of DNS for as
  long as caches held the absence — considerably longer than the outage it was reacting to.
*/
locals {
  # The apex, the API, and every tenant hostname. `*` is one label, which is why a preview host is
  # `pr-42--myapp` and not `pr-42.myapp`.
  alb_names = toset([var.control_plane_domain, "api.${var.control_plane_domain}", "*.${var.control_plane_domain}"])
}

resource "aws_route53_record" "alb_ipv4" {
  for_each = local.alb_names

  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = false
  }
}

# The ALB is dual-stack, and a client on an IPv6-only network resolves AAAA or nothing at all.
resource "aws_route53_record" "alb_ipv6" {
  for_each = local.alb_names

  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value
  type    = "AAAA"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = false
  }
}

# ---------------------------------------------------------------------------
# What points at the OVH host
# ---------------------------------------------------------------------------

/*
  The forum, which is not on AWS.

  `*.sproutos.me` above resolves every tenant hostname to the load balancer, and `forum` would have
  been swept up with them. It is not a tenant application — it is a dedicated site on the OVH box —
  so it needs its own records.

  **A more specific name beats a wildcard**, which is DNS and not a Route 53 behaviour: a query for
  `forum.sproutos.me` matches the exact record and the wildcard is never consulted. So these two
  records are the whole change; nothing has to be excluded from `local.alb_names`.

  Plain A and AAAA records rather than aliases: an alias points at an AWS resource, and this is a
  machine in a Canadian OVH datacentre. The address is therefore literal and hard-coded, and the
  cost of that is stated in `variables.tf` — if the box is rebuilt on new addresses, this is what
  has to change with it.

  300s, not the 60s the validation records use. The forum's address changes when the box does,
  which is rarely, and a five-minute TTL is the ordinary trade for a record that is looked up on
  every page load and almost never edited.
*/
resource "aws_route53_record" "forum_ipv4" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${var.forum_subdomain}.${var.control_plane_domain}"
  type    = "A"
  ttl     = 300
  records = [var.ovh_host_ipv4]
}

resource "aws_route53_record" "forum_ipv6" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${var.forum_subdomain}.${var.control_plane_domain}"
  type    = "AAAA"
  ttl     = 300
  records = [var.ovh_host_ipv6]
}

/*
  The name the log extension connects to, and the name on the certificate it checks.

  This could have been the bare address — the extension is given `KAFKA_BROKERS` and would take
  `135.148.122.203:9094` quite happily. It is a name for two reasons that are really one: a TLS
  certificate is issued for a name, and a client that cannot verify a name is a client that cannot
  verify anything. The extension runs inside customers' Lambda execution environments and crosses
  the public internet to get here (ADR 0026), so the connection is authenticated in both directions
  — the certificate proves the broker, SASL/SCRAM proves the producer.

  The second reason is the ordinary one: when the box is replaced, one record changes rather than
  an environment variable on every customer function.
*/
resource "aws_route53_record" "kafka_ipv4" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${var.kafka_subdomain}.${var.control_plane_domain}"
  type    = "A"
  ttl     = 300
  records = [var.ovh_host_ipv4]
}

resource "aws_route53_record" "kafka_ipv6" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${var.kafka_subdomain}.${var.control_plane_domain}"
  type    = "AAAA"
  ttl     = 300
  records = [var.ovh_host_ipv6]
}

/*
  ClickHouse, which the API reads customers' runtime logs from.

  `GET /:orgSlug/projects/:projectId/logs` is the log viewer, it runs in AWS, and ClickHouse is on
  the OVH box — so this hostname is not a convenience, it is the only way that endpoint works. It
  bound to `127.0.0.1` until now, which meant the viewer could not have worked in production at all.

  Behind the box's Traefik rather than exposed directly: Traefik already owns 443 there and already
  holds an ACME resolver, so this needs no second certificate story and no second thing to renew.
  ClickHouse's own user and password still apply, and a Traefik middleware restricts the source to
  the platform's egress address — see `ovh/docker-compose.yaml`.
*/
resource "aws_route53_record" "clickhouse_ipv4" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${var.clickhouse_subdomain}.${var.control_plane_domain}"
  type    = "A"
  ttl     = 300
  records = [var.ovh_host_ipv4]
}

/*
  Deliberately no AAAA record, unlike `forum` and `kafka`.

  Access to ClickHouse is restricted by source address — it holds every tenant's logs, so "who may
  reach the door" is a real control and not decoration. That control only works if the proxy in
  front can *see* the source, and over IPv6 on this host it cannot: Docker IPv6 is disabled on the
  network Traefik runs in, so an IPv6 connection is forwarded by the userland proxy and arrives with
  the bridge gateway's address (`172.19.0.1`) in place of the client's.

  The failure is the dangerous shape rather than the loud one. Measured from one instance in one
  second: `curl` defaulted to IPv6 and got **403**; `curl -4` got **200**. Every request the platform
  actually makes was refused, while the configuration read as correct — and the only fix available
  without the address would have been to allowlist the gateway, which is to say allowlist the entire
  internet arriving over IPv6.

  So this name is IPv4-only. Our AWS egress has IPv4 through the NAT, which is the path that
  preserves the source. If Docker IPv6 is ever enabled on that host, this record can come back.
*/

/*
  The two tenant datastores on the same box, published for the same reason and with the same
  restriction.

  `opensearch` is what `search-proxy` connects onward to; `valkey` is what the Valkey split connects
  onward to. Neither is a customer-facing address — a customer is given the *router*, and these are
  the backends behind it. That distinction is the whole tenancy model: `docs/findings/0015` records
  a `SERVICE_POSTGRES_PUBLIC_HOST` observed handing a real caller the backend's own address, which
  is a URI that works and bypasses every check the platform makes.

  IPv4 only, for the reason written out above. Both are allowlisted by source address, and on this
  host an IPv6 connection arrives wearing the bridge gateway's address instead of the client's — so
  an AAAA record here would turn a working control into one that refuses the platform and admits
  anyone who reaches it over IPv6.

  There is no wildcard problem to worry about even though `*.sproutos.me` exists and points at the
  ALB: an exact record beats a wildcard in Route 53, which is why these have to be written down
  rather than left to resolve.
*/
/*
  `valkey.<domain>`, the customer-facing address of the Valkey split.

  It briefly pointed at the OVH host, for a Traefik TCP route that was removed — see the queue
  service in `ovh/docker-compose.yaml` for why. It is an alias to the tenant load balancer now, and
  the backend it eventually reaches is `queue.<domain>`, which is a different name on purpose: one
  is the proxy a customer is given, the other is the queue behind it.
*/
resource "aws_route53_record" "tenant_valkey" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${var.tenant_valkey_subdomain}.${var.control_plane_domain}"
  type    = "A"

  alias {
    name                   = aws_lb.tenant.dns_name
    zone_id                = aws_lb.tenant.zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "opensearch_ipv4" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${var.opensearch_subdomain}.${var.control_plane_domain}"
  type    = "A"
  ttl     = 300
  records = [var.ovh_host_ipv4]
}

/*
  The tenant queue on the OVH box, which the router's Valkey split connects onward to.

  A backend name, not a customer-facing one — the customer is given the *proxy*, at
  `${var.tenant_valkey_subdomain}.${var.control_plane_domain}`, which resolves to the tenant load
  balancer. Same split as `opensearch` and `search`.

  Unlike ClickHouse and OpenSearch this is not behind Traefik and has no IP allowlist, so it takes
  an IPv6 record as happily as an IPv4 one — the reason those two are IPv4-only is that Traefik
  cannot see a client's real address over IPv6 on this host, and nothing here is deciding anything
  from the source address. What stands in front of it is Valkey's own TLS and `requirepass`.
*/
resource "aws_route53_record" "tenant_queue_ipv4" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${var.tenant_queue_subdomain}.${var.control_plane_domain}"
  type    = "A"
  ttl     = 300
  records = [var.ovh_host_ipv4]
}

/*
  The certificate renewal on the OVH box, which could not renew.

  Kafka's `EXTERNAL` listener is TLS on 9094 and its certificate comes from certbot on that host,
  configured with `authenticator = standalone`. Standalone binds port 80, and Traefik holds port 80
  on that machine, so every renewal since the certificate was first obtained has failed:

      $ sudo certbot renew --dry-run --cert-name kafka.sproutos.me
      Could not bind TCP port 80 because it is already in use by another process on this system

  The timer runs twice a day and fails silently. The certificate expires on 2026-11-23, and on that
  day the log extension in every customer's Lambda stops being able to complete a handshake — so the
  runtime log pipeline stops, with nothing in the platform having changed.

  `tls-alpn-01` through Traefik is not available either, for the reason `ovh/docker-compose.yaml`
  writes out on the Valkey service: it works for a name Traefik itself serves, and Kafka is not
  behind Traefik.

  DNS-01 needs no port at all, which is why it is the answer here rather than the tidier one. This
  user is what certbot on that host authenticates as. **No access key is created by OpenTofu** — the
  state file is local and a key in it is a credential in a file nobody treats as one, which is the
  same reasoning `app-secrets.tf` gives for creating no parameter.
*/
resource "aws_iam_user" "certbot" {
  name = "${var.name_prefix}-certbot-dns"
  path = "/service/"
  tags = { Purpose = "certbot dns-01 on the OVH host" }
}

resource "aws_iam_user_policy" "certbot" {
  name = "certbot-dns01"
  user = aws_iam_user.certbot.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # certbot polls this after submitting a change, to know the record has propagated.
        Sid      = "WatchTheChange"
        Effect   = "Allow"
        Action   = ["route53:GetChange"]
        Resource = ["arn:aws:route53:::change/*"]
      },
      {
        # The plugin looks the zone up by name rather than being told its id.
        Sid      = "FindTheZone"
        Effect   = "Allow"
        Action   = ["route53:ListHostedZones"]
        Resource = ["*"]
      },
      {
        /*
          One zone, and only this one.

          The plugin writes and then deletes a `_acme-challenge` TXT record. Scoped to the zone
          rather than to that record name because `ChangeResourceRecordSets` authorizes against the
          hosted zone and carries no condition key for the record it is changing — so "only the
          challenge record" is not expressible here, and pretending otherwise in a comment would be
          worse than saying so.
        */
        Sid    = "WriteTheChallengeRecord"
        Effect = "Allow"
        Action = [
          "route53:ChangeResourceRecordSets",
          "route53:ListResourceRecordSets",
        ]
        Resource = ["arn:aws:route53:::hostedzone/${data.aws_route53_zone.main.zone_id}"]
      },
    ]
  })
}


# ---------------------------------------------------------------------------
# The tenant domain
# ---------------------------------------------------------------------------

/*
  Validation for the tenant certificate, in the tenant zone.

  Same de-duplication as the control plane's above: ACM returns one option per name, and for
  `sproutos.run` plus `*.sproutos.run` both are frequently the same record.
*/
resource "aws_route53_record" "tenant_apps_certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.tenant_apps.domain_validation_options :
    option.domain_name => {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }...
  }

  zone_id = aws_route53_zone.tenant.zone_id
  name    = each.value[0].name
  type    = each.value[0].type
  records = [each.value[0].value]
  ttl     = 60

  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "tenant_apps" {
  certificate_arn         = aws_acm_certificate.tenant_apps.arn
  validation_record_fqdns = [for record in aws_route53_record.tenant_apps_certificate_validation : record.fqdn]
}

/*
  Every tenant hostname, and the apex.

  The apex is here so the domain resolves to something rather than NXDOMAIN — it lands on the
  router, which answers 404 for a host with no route, which is the honest answer for a bare tenant
  domain nobody has claimed.
*/
locals {
  tenant_alb_names = toset([var.tenant_domain, "*.${var.tenant_domain}"])
}

resource "aws_route53_record" "tenant_alb_ipv4" {
  for_each = local.tenant_alb_names

  zone_id = aws_route53_zone.tenant.zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = var.tenant_edge_enabled ? aws_lb.tenant_edge[0].dns_name : aws_lb.main.dns_name
    zone_id                = var.tenant_edge_enabled ? aws_lb.tenant_edge[0].zone_id : aws_lb.main.zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "tenant_alb_ipv6" {
  for_each = local.tenant_alb_names

  zone_id = aws_route53_zone.tenant.zone_id
  name    = each.value
  type    = "AAAA"

  alias {
    name                   = var.tenant_edge_enabled ? aws_lb.tenant_edge[0].dns_name : aws_lb.main.dns_name
    zone_id                = var.tenant_edge_enabled ? aws_lb.tenant_edge[0].zone_id : aws_lb.main.zone_id
    evaluate_target_health = false
  }
}
