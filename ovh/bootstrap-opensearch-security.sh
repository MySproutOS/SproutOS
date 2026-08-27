#!/usr/bin/env bash
# Post-start assertion. The Security plugin initializes its index from the seed files rendered by
# opensearch-entrypoint.sh when the index does not exist; later restarts preserve runtime changes.
set -euo pipefail
cd /opt/sproutos
set -a; . ./.env; set +a

status=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:9200/)
[ "$status" = 401 ] || { echo "unauthenticated OpenSearch returned $status, expected 401" >&2; exit 1; }
curl -fsS -u "$SEARCH_ADMIN_USER:$SEARCH_ADMIN_PASSWORD" http://127.0.0.1:9200/ >/dev/null

# The router needs only these Security REST APIs. Prove that its seeded manager role can actually
# use them on this exact plugin version, then remove the disposable role.
manager_status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -u "sproutos_search_proxy_manager:$SEARCH_PROXY_SECURITY_ROOT_KEY" \
  -H 'content-type: application/json' -X PUT \
  http://127.0.0.1:9200/_plugins/_security/api/roles/sproutos_bootstrap_probe \
  -d '{"cluster_permissions":[],"index_permissions":[],"tenant_permissions":[]}')
case "$manager_status" in 200|201) ;; *)
  echo "OpenSearch proxy manager role PUT returned $manager_status" >&2; exit 1;;
esac
delete_status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -u "sproutos_search_proxy_manager:$SEARCH_PROXY_SECURITY_ROOT_KEY" -X DELETE \
  http://127.0.0.1:9200/_plugins/_security/api/roles/sproutos_bootstrap_probe)
case "$delete_status" in 200|204) ;; *)
  echo "OpenSearch proxy manager role DELETE returned $delete_status" >&2; exit 1;;
esac
config_status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -u "sproutos_search_proxy_manager:$SEARCH_PROXY_SECURITY_ROOT_KEY" \
  http://127.0.0.1:9200/_plugins/_security/api/securityconfig)
[ "$config_status" = 403 ] || {
  echo "OpenSearch proxy manager read securityconfig with HTTP $config_status, expected 403" >&2
  exit 1
}
echo "OpenSearch Security initialized; anonymous denied, admin authenticated, proxy manager scoped"
