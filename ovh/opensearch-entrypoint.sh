#!/usr/bin/env bash
# Render secrets before OpenSearch starts. The plugin consumes these files only when its security
# index does not exist, so a restart cannot erase tenant roles created later through the REST API.
set -euo pipefail

: "${SEARCH_ADMIN_USER:?set SEARCH_ADMIN_USER}"
: "${SEARCH_ADMIN_PASSWORD:?set SEARCH_ADMIN_PASSWORD}"
: "${SEARCH_PROXY_SECURITY_ROOT_KEY:?set SEARCH_PROXY_SECURITY_ROOT_KEY}"

TOOLS=/usr/share/opensearch/plugins/opensearch-security/tools
DEST=/usr/share/opensearch/config/opensearch-security
ADMIN_HASH=$($TOOLS/hash.sh -p "$SEARCH_ADMIN_PASSWORD" | tail -1)
MANAGER_HASH=$($TOOLS/hash.sh -p "$SEARCH_PROXY_SECURITY_ROOT_KEY" | tail -1)
OPENSEARCH_CONFIG=/usr/share/opensearch/config/opensearch.yml

cp /security-bootstrap/config.yml "$DEST/config.yml"
cp /security-bootstrap/roles.yml "$DEST/roles.yml"
cp /security-bootstrap/roles_mapping.yml "$DEST/roles_mapping.yml"
sed -e "s|__ADMIN_USER__|$SEARCH_ADMIN_USER|g" \
  -e "s|__ADMIN_HASH__|$ADMIN_HASH|g" \
  -e "s|__MANAGER_HASH__|$MANAGER_HASH|g" \
  /security-bootstrap/internal_users.yml > "$DEST/internal_users.yml"

# The Docker entrypoint translates environment entries into `-E` command-line settings. OpenSearch
# 3.3 accepts these two settings as YAML lists, but not as the indexed command-line keys
# `plugins.security.*_dn[0]`; using those makes the node fail before the Security plugin starts.
# A container restart reuses its writable layer, so mark the block and append it only once.
if ! grep -Fq '# SproutOS security certificate identities' "$OPENSEARCH_CONFIG"; then
  printf '\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    '# SproutOS security certificate identities' \
    'plugins.security.authcz.admin_dn:' \
    '  - CN=sproutos-opensearch-admin' \
    'plugins.security.nodes_dn:' \
    '  - CN=sproutos-opensearch-node' \
    'plugins.security.restapi.roles_enabled:' \
    '  - sproutos_search_admin' \
    '  - sproutos_search_proxy_manager' >> "$OPENSEARCH_CONFIG"

  # A role listed above can reach every Security REST endpoint by default. The manager needs only
  # roles, internal users, and role mappings; explicitly close every other 3.3 management family.
  # Security-config mutation is separately disabled by default, but reads still expose internals.
  for endpoint in ACTIONGROUPS CACHE CONFIG LICENSE NODESDN PERMISSIONSINFO SSL SYSTEMINFO TENANTS; do
    printf '%s\n' \
      "plugins.security.restapi.endpoints_disabled.sproutos_search_proxy_manager.$endpoint: [\"GET\",\"PUT\",\"POST\",\"DELETE\",\"PATCH\"]" \
      >> "$OPENSEARCH_CONFIG"
  done
fi

exec /usr/share/opensearch/opensearch-docker-entrypoint.sh "$@"
