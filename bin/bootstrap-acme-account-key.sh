#!/usr/bin/env bash
# Seed the ACME account key without ever placing its PEM in OpenTofu state or command output.
set -euo pipefail

secret_id="${1:-}"
acme_region="${AWS_REGION:-us-east-1}"

if [ -z "$secret_id" ]; then
  echo "usage: $0 <secrets-manager-secret-id>" >&2
  exit 2
fi

version_count=$(aws secretsmanager list-secret-version-ids \
  --secret-id "$secret_id" \
  --region "$acme_region" \
  --query 'length(Versions)' \
  --output text)

if ! [[ "$version_count" =~ ^[0-9]+$ ]]; then
  echo "could not determine whether $secret_id already has a value" >&2
  exit 1
fi
if [ "$version_count" -ne 0 ]; then
  echo "$secret_id already has a version; refusing to replace the ACME account identity" >&2
  exit 1
fi

acme_temp_dir=$(mktemp -d)
acme_key_file="$acme_temp_dir/account-key.pem"
cleanup() {
  [ ! -f "$acme_key_file" ] || unlink "$acme_key_file"
  rmdir "$acme_temp_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$acme_key_file" 2>/dev/null
aws secretsmanager put-secret-value \
  --secret-id "$secret_id" \
  --secret-string "file://$acme_key_file" \
  --region "$acme_region" \
  --query 'ARN' \
  --output text >/dev/null

echo "Seeded the ACME account key in $secret_id"
