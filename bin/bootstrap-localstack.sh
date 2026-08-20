#!/usr/bin/env bash
# Create the local AWS resources the app expects.
#
# LocalStack's free (Hobby) plan does not persist state, so every `docker compose up`
# starts empty. This script is idempotent and cheap — re-run it after any restart.
set -euo pipefail

ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"
REGION="${AWS_REGION:-us-east-1}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="$REGION"

aws_local() { aws --endpoint-url "$ENDPOINT" "$@"; }

command -v aws >/dev/null || { echo "aws CLI not found (brew install awscli)" >&2; exit 1; }

until curl -sf "$ENDPOINT/_localstack/health" >/dev/null 2>&1; do
  echo "waiting for LocalStack at $ENDPOINT ..."
  sleep 2
done

# Envelope-encryption CMK. Every secret in the database is wrapped by a data key
# from this CMK; see lib/typescript/envelope.
if ! aws_local kms describe-key --key-id alias/sproutos-dev >/dev/null 2>&1; then
  KEY_ID=$(aws_local kms create-key --description "SproutOS dev envelope key" \
    --query 'KeyMetadata.KeyId' --output text)
  aws_local kms create-alias --alias-name alias/sproutos-dev --target-key-id "$KEY_ID"
  echo "created KMS key $KEY_ID (alias/sproutos-dev)"
else
  echo "KMS alias/sproutos-dev already present"
fi

for bucket in sproutos-dev-artifacts sproutos-dev-uploads; do
  aws_local s3api head-bucket --bucket "$bucket" >/dev/null 2>&1 \
    || { aws_local s3api create-bucket --bucket "$bucket" >/dev/null; echo "created bucket $bucket"; }
done

# SES v1 — v2 is not on the free plan, which is why the mailer targets client-ses.
aws_local ses verify-email-identity --email-address no-reply@sproutos.dev >/dev/null 2>&1 || true
aws_local ses verify-domain-identity --domain sproutos.dev >/dev/null 2>&1 || true
echo "verified SES identities"

# Metering ingest stream.
aws_local kinesis describe-stream --stream-name sproutos-dev-usage >/dev/null 2>&1 \
  || { aws_local kinesis create-stream --stream-name sproutos-dev-usage --shard-count 1 >/dev/null; \
       echo "created kinesis stream sproutos-dev-usage"; }

echo "LocalStack bootstrap complete."
