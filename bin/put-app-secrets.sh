#!/usr/bin/env bash
#
# Load the application's secrets into Secrets Manager from a local `.env`.
#
# Run by a person, not by CI and not by OpenTofu. A secret written through OpenTofu is a secret in
# `terraform.tfstate` — which is a secret on whatever machine last ran a plan, and in whatever bucket
# the state is kept in. `app-secrets.tf` therefore creates an empty container and ignores its
# contents forever; this is what fills it.
#
# Usage:  bin/put-app-secrets.sh [path-to-env]
set -euo pipefail

ENV_FILE="${1:-.env}"
SECRET_ID="${APPLICATION_SECRET_ID:-sproutos/application}"

[ -f "$ENV_FILE" ] || { echo "no such file: $ENV_FILE" >&2; exit 1; }

# Exactly these, and nothing else.
#
# An allowlist rather than "everything in .env": that file holds a developer's local database URL,
# their LocalStack endpoint and their own tokens, and shipping the lot to production would both
# leak what does not belong there and override what the instance correctly worked out for itself.
KEYS=(
  GITHUB_OAUTH_CLIENT_ID
  GITHUB_OAUTH_CLIENT_SECRET
  GITHUB_APP_ID
  GITHUB_APP_CLIENT_ID
  GITHUB_APP_CLIENT_SECRET
  GITHUB_APP_PRIVATE_KEY
  GITHUB_WEBHOOK_SECRET
  SESSION_SECRET
  STRIPE_PUBLIC_KEY
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET
  APK_SIGNER_TOKEN
  DEPLOY_TOKEN_SECRET
  LOG_TOKEN_SECRET
  SPROUTOS_LOG_ENDPOINT
  KAFKA_BROKERS
  KAFKA_SASL_USERNAME
  KAFKA_SASL_PASSWORD
  OVH_CLICKHOUSE_PASSWORD
)

payload=$(
  ENV_FILE="$ENV_FILE" KEYS="${KEYS[*]}" python3 <<'PYTHON'
import json, os, re

wanted = set(os.environ["KEYS"].split())
found = {}

for line in open(os.environ["ENV_FILE"], encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, _, value = line.partition("=")
    key = key.strip()
    if key not in wanted:
        continue
    value = value.strip()
    # Strip one layer of surrounding quotes, which .env files use for values containing spaces.
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    if value:
        found[key] = value

missing = sorted(wanted - set(found))
if missing:
    # A warning and not an error: several of these are legitimately unset early on, and refusing to
    # write the ones that exist would mean nothing works until everything does.
    print("::warning:: not set locally, so not uploaded: " + ", ".join(missing), file=__import__("sys").stderr)

print(json.dumps(found))
PYTHON
)

count=$(python3 -c 'import json,sys; print(len(json.loads(sys.stdin.read())))' <<<"$payload")

aws secretsmanager put-secret-value \
  --secret-id "$SECRET_ID" \
  --secret-string "$payload" \
  --query 'VersionId' --output text >/dev/null

echo "wrote $count secret(s) to $SECRET_ID"
echo "instances read this at boot; existing ones need replacing to pick it up."
