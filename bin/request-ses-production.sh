#!/usr/bin/env bash
# Submit SproutOS's SES v2 production-access request after the domain and DKIM are verified.
set -euo pipefail

region="${AWS_REGION:-us-east-1}"
domain="${SES_DOMAIN:-sproutos.me}"

identity_status=$(aws sesv2 get-email-identity \
  --region "$region" \
  --email-identity "$domain" \
  --query 'VerifiedForSendingStatus' \
  --output text)

if [[ "$identity_status" != "True" ]]; then
  echo "SES identity $domain is not verified; refusing to request production access" >&2
  exit 1
fi

aws sesv2 put-account-details \
  --region "$region" \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url "https://sproutos.me" \
  --contact-language EN \
  --additional-contact-email-addresses acwangpython@gmail.com \
  --use-case-description "Primarily low-volume account, security, deployment/build, billing, and service notices to registered users. Occasional product announcements are sent only to users who explicitly enable a default-off preference. We never use purchased, rented, or scraped lists. Hard bounces and complaints are automatically suppressed."

aws sesv2 get-account \
  --region "$region" \
  --query '{Status:Details.ReviewDetails.Status,CaseId:Details.ReviewDetails.CaseId,ProductionAccessEnabled:ProductionAccessEnabled,Suppression:SuppressionAttributes.SuppressedReasons}'
