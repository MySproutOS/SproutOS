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
