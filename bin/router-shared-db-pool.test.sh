#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MAIN="$ROOT/services/router/src/main.rs"
LISTENERS="$ROOT/services/router/src/listeners.rs"
USER_DATA="$ROOT/tofu/user-data.sh.tftpl"

require() {
  local needle=$1 file=$2
  if ! grep -Fq "$needle" "$file"; then
    echo "missing shared router database-pool contract: $needle" >&2
    exit 1
  fi
}

require 'control_plane_pool(' "$MAIN"
require 'ROUTER_DB_POOL' "$MAIN"
require 'ROUTER_DB_POOL=4' "$USER_DATA"
require 'STORAGE_PROXY_DB_POOL=1' "$USER_DATA"

if [ "$(grep -c 'control_plane_pool(' "$MAIN")" -ne 1 ]; then
  echo "the router process must construct exactly one control-plane pool" >&2
  exit 1
fi

for listener in valkey search postgres llm forward_proxy_service; do
  require "listeners::$listener" "$MAIN"
done

if [ "$(grep -c '&database_pool' "$MAIN")" -lt 5 ]; then
  echo "not every database-backed router component receives the shared pool" >&2
  exit 1
fi

if grep -Eq 'CredentialStore::connect|SessionStore::connect|SandboxAuthorizer::connect' "$LISTENERS"; then
  echo "a combined-router listener still constructs its own PostgreSQL pool" >&2
  exit 1
fi

for legacy in \
  ROUTER_ROUTE_DB_POOL \
  VALKEY_PROXY_DB_POOL \
  SEARCH_PROXY_DB_POOL \
  PG_PROXY_DB_POOL \
  LLM_PROXY_DB_POOL \
  FORWARD_PROXY_DB_POOL
do
  if grep -Fq "$legacy" "$USER_DATA"; then
    echo "legacy per-listener pool remains in production user data: $legacy" >&2
    exit 1
  fi
done

echo "router listeners share one PostgreSQL pool; storage-proxy retains one bounded process pool"
