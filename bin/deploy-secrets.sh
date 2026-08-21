#!/usr/bin/env bash
#
# Put the deployed platform's credentials into the cluster.
#
# `deploy/secrets/external-secrets.yaml` is how this works in production: the External Secrets
# operator reads AWS Secrets Manager and the cluster never holds a long-lived credential to fetch
# credentials with. That operator is not installed on a trial cluster, and the Secrets it would
# create are the difference between a fleet that runs and a fleet sitting in
# `CreateContainerConfigError` — so this fills the same Secrets from `.env` instead.
#
# **Not a production path.** It copies plaintext from a developer's machine into a cluster, which is
# precisely what External Secrets exists to avoid. It is here so a trial cluster is reproducible
# rather than hand-typed, and so the names and keys it creates are checked against one list that the
# manifests also read.
set -euo pipefail

NAMESPACE="${NAMESPACE:-sproutos-system}"
ENV_FILE="${ENV_FILE:-.env}"

[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found" >&2; exit 1; }

# Sourced rather than parsed. The file is shell-compatible by construction and the alternative is a
# hand-rolled parser that gets quoting subtly wrong.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# The deployed OAuth App, not the localhost one.
#
# These are deliberately different apps: a GitHub OAuth App has exactly one callback URL, and the
# deployed platform and `pnpm dev` are served from different origins. Reading the undecorated
# `GITHUB_OAUTH_CLIENT_ID` here would put the localhost app's id into the cluster, and every
# production sign-in would fail with "Invalid Redirect URI" — which is exactly what happened before
# this script existed.
: "${GITHUB_OAUTH_CLIENT_ID_DEPLOYED:?set GITHUB_OAUTH_CLIENT_ID_DEPLOYED in $ENV_FILE}"
: "${GITHUB_OAUTH_CLIENT_SECRET_DEPLOYED:?set GITHUB_OAUTH_CLIENT_SECRET_DEPLOYED in $ENV_FILE}"

# `create --dry-run=client | apply` rather than `create`: this has to be safe to re-run, and
# `kubectl create secret` on an existing Secret is an error rather than an update.
apply() {
  kubectl -n "$NAMESPACE" create secret generic "$@" --dry-run=client -o yaml | kubectl apply -f -
}

apply github-oauth \
  --from-literal=client-id="$GITHUB_OAUTH_CLIENT_ID_DEPLOYED" \
  --from-literal=client-secret="$GITHUB_OAUTH_CLIENT_SECRET_DEPLOYED"

apply github-app \
  --from-literal=app-id="${GITHUB_APP_ID:-}" \
  --from-literal=private-key="${GITHUB_APP_PRIVATE_KEY:-}" \
  --from-literal=webhook-secret="${GITHUB_WEBHOOK_SECRET:-}"

apply stripe \
  --from-literal=secret-key="${STRIPE_SECRET_KEY:-}" \
  --from-literal=webhook-secret="${STRIPE_WEBHOOK_SECRET:-}"

echo "Secrets applied to $NAMESPACE. Restart the pods that read them:"
echo "  kubectl -n $NAMESPACE rollout restart deploy/website deploy/internal-api deploy/worker"
