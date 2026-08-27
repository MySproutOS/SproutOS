#!/usr/bin/env bash
set -euo pipefail

template="tofu/user-data.sh.tftpl"
env_block="$(sed -n '/cat > \/etc\/sproutos\/env <<ENVFILE/,/^ENVFILE$/p' "$template")"

if sed 's/\\`//g' <<<"$env_block" | grep -q '`'; then
  echo "unescaped command substitution in /etc/sproutos/env heredoc" >&2
  exit 1
fi

website_secrets="$(sed -n '/if \[ "\$SERVICE" = "website" \]/,/^fi$/p' "$template")"
grep -q 'SEARCH_PROXY_SECURITY_ROOT_KEY' <<<"$website_secrets"

echo "user-data heredoc and website reconciliation configuration are safe"
