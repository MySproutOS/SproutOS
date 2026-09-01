/*
  Transactional mail identity.

  The application uses SES v2 in production and MailHog locally. Easy DKIM returns exactly three
  tokens; for_each makes those three DNS records explicit while keeping rotation provider-owned.
*/
resource "aws_sesv2_email_identity" "sproutos" {
  email_identity = var.control_plane_domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_route53_record" "ses_dkim" {
  count = 3

  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${aws_sesv2_email_identity.sproutos.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.control_plane_domain}"
  type    = "CNAME"
  ttl     = 300
  records = ["${aws_sesv2_email_identity.sproutos.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}
