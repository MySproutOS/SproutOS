#!/usr/bin/env bash
# Bootstrap development/CI after the image's explicitly test-only demo installer has created the
# Security index. Production renders the same seed files before OpenSearch starts.
set -euo pipefail

ADMIN_USER=${SEARCH_ADMIN_USER:-admin}
ADMIN_PASSWORD=${SEARCH_ADMIN_PASSWORD:-L0cal!Windmill-Quartz-83}
ROOT_KEY=${SEARCH_PROXY_SECURITY_ROOT_KEY:-local-search-security-root-key-32-bytes}
BASE=${SEARCH_ADMIN_URL:-http://127.0.0.1:29200}

put() {
  local path=$1 body=$2 status
  status=$(curl -sS -o /dev/null -w '%{http_code}' -u "$ADMIN_USER:$ADMIN_PASSWORD" \
    -H 'content-type: application/json' -X PUT "$BASE/_plugins/_security/api/$path" -d "$body")
  case "$status" in 200|201) ;; *) echo "OpenSearch Security PUT $path returned $status" >&2; exit 1;; esac
}

# The demo image reserves Security REST permissions and will not let its admin create a narrower
# REST role dynamically. Test-only local/CI therefore map the manager to the demo's built-in role;
# production seeds the three-permission role in roles.yml before the Security index exists.
put internalusers/sproutos_search_proxy_manager "{\"password\":\"$ROOT_KEY\",\"backend_roles\":[\"admin\"],\"attributes\":{}}"

status=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/")
[ "$status" = 401 ] || { echo "unauthenticated OpenSearch returned $status, expected 401" >&2; exit 1; }
echo "OpenSearch Security initialized; unauthenticated requests are refused"
