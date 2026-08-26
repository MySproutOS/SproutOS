#!/usr/bin/env bash
#
# Load the application's secrets into SSM Parameter Store from a local `.env`.
#
# Run by a person, not by CI and not by OpenTofu. A secret written through OpenTofu is a secret in
# `terraform.tfstate` — which is a secret on whatever machine last ran a plan, and in whatever bucket
# the state is kept in. `app-secrets.tf` therefore declares only the path and the permission to read
# it, and creates no parameter at all; this is what creates them.
#
# One `SecureString` parameter per variable, under one path. Parameter Store standard parameters are
# free where a Secrets Manager secret is $0.40 a month, and nothing here uses managed rotation —
# see `app-secrets.tf`.
#
# Usage:  bin/put-app-secrets.sh [path-to-env]
set -euo pipefail

ENV_FILE="${1:-.env}"
PARAMETER_PATH="${APPLICATION_PARAMETER_PATH:-/sproutos/application}"
KMS_KEY_ALIAS="${APPLICATION_KMS_KEY_ALIAS:-alias/sproutos-secrets}"

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
  # Runtime logs. Only the password is a secret; the URL, user and database are plain text in the
  # launch template, because a hostname is not a credential.
  CLICKHOUSE_PASSWORD
  # Signs metering batches. Unset, the ingest route answers 401 by design and no usage is recorded.
  METERING_INGEST_HMAC_KEY
  # Not derived from OpenTofu because nothing in this repository publishes the layer — the three
  # versions in the account were published by hand. Pinning it in the launch template would make it
  # silently stale on the next publish; here a person updates it in the same motion.
  LOG_EXTENSION_LAYER_ARN
  # The basic-auth credential in front of OpenSearch on the OVH box, which authenticates nobody
  # itself. `SEARCH_PROXY_UPSTREAM_AUTHORIZATION` is what the router's search split presents;
  # `SEARCH_ADMIN_USER` / `SEARCH_ADMIN_PASSWORD` are the same credential for the reaper, which
  # goes straight to the cluster because an internal caller has no tenant to be separated from.
  SEARCH_PROXY_UPSTREAM_AUTHORIZATION
  SEARCH_ADMIN_USER
  SEARCH_ADMIN_PASSWORD
  # Managed Neon's API key, which creates a project per customer database. Nothing in this
  # repository can obtain it; without it `kind: postgres` answers 503 naming this.
  NEON_API_KEY
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

# One parameter at a time, because there is no batch write.
#
# `--overwrite` on every key rather than create-then-update: this script is meant to be safe to
# re-run, and the failure it replaces — a `ParameterAlreadyExists` on the second run — would stop
# the loop partway and leave the set half-updated.
#
# The request is written to a mode-600 file and passed by path rather than given to `--value` as an
# argument. An argument is visible in the process list, so `ps` would show every other user on this
# machine the secret being written.
WORK_DIR=$(mktemp -d)
chmod 700 "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

count=0
while IFS= read -r key; do
  ENV_PAYLOAD="$payload" PARAM_KEY="$key" PARAM_PATH="$PARAMETER_PATH" KEY_ID="$KMS_KEY_ALIAS" \
    OUT="$WORK_DIR/request.json" python3 <<'PYTHON'
import json, os

with open(os.environ["OUT"], "w", encoding="utf-8", opener=lambda p, f: os.open(p, f, 0o600)) as out:
    json.dump({
        "Name": os.environ["PARAM_PATH"].rstrip("/") + "/" + os.environ["PARAM_KEY"],
        "Value": json.loads(os.environ["ENV_PAYLOAD"])[os.environ["PARAM_KEY"]],
        "Type": "SecureString",
        "KeyId": os.environ["KEY_ID"],
        "Overwrite": True,
        "Description": "Read at boot by the website, API and worker. Written by bin/put-app-secrets.sh.",
    }, out)
PYTHON

  aws ssm put-parameter --cli-input-json "file://$WORK_DIR/request.json" \
    --query 'Version' --output text >/dev/null
  rm -f "$WORK_DIR/request.json"
  count=$((count + 1))
done < <(python3 -c 'import json,sys; [print(k) for k in sorted(json.loads(sys.stdin.read()))]' <<<"$payload")

echo "wrote $count parameter(s) under $PARAMETER_PATH"
echo "instances read these at boot; existing ones need replacing to pick them up."
