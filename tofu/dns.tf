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
