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
grep -q 'SERVICE_OBJECT_STORAGE_ROOT_KEY' <<<"$website_secrets"

router_secrets="$(sed -n '/if \[ "\$SERVICE" = "router" \]/,/^fi$/p' "$template")"
grep -q 'SERVICE_OBJECT_STORAGE_ROOT_KEY' <<<"$router_secrets"
grep -q '^VALKEY_PROXY_MASTER_QUEUE=1$' <<<"$env_block"
grep -q '^STORAGE_METERING_REQUIRED=1$' <<<"$env_block"
grep -q '^STORAGE_METERING_SPOOL_DIR=/var/lib/sproutos/storage-metering$' <<<"$env_block"

# Extract the router release's literal start script from the workflow. YAML removes the common ten
# spaces from the block before the shell sees it; do the same here, then ask bash to parse the exact
# artifact that will become `/opt/sproutos/start`.
start_test_dir="$(mktemp -d)"
start_script="$start_test_dir/start"
trap 'rm -rf "$start_test_dir"' EXIT
awk '
  /cat > "\$staging\/start" <<'\''START'\''/ { inside = 1; next }
  inside && /^          START$/ { exit }
  inside { sub(/^          /, ""); print }
' .github/workflows/deploy.yml > "$start_script"
bash -n "$start_script"
grep -q 'wait "\$router_pid"' "$start_script"
grep -q 'storage-proxy exited with .* restarting without stopping router' "$start_script"
if grep -q 'wait -n "\$router_pid" "\$storage_pid"' "$start_script"; then
  echo "storage child failure still terminates the router supervisor" >&2
  exit 1
fi

# Execute the extracted supervisor with a storage child that fails immediately. The router lives
# long enough to write its marker and its exit status is the unit's exit status; the old `wait -n`
# supervisor killed it before either could happen.
cat > "$start_test_dir/router" <<'ROUTER'
#!/bin/bash
sleep 0.2
echo survived > "$SURVIVED"
exit 7
ROUTER
cat > "$start_test_dir/storage-proxy" <<'STORAGE'
#!/bin/bash
echo attempted >> "$ATTEMPTS"
exit 9
STORAGE
chmod +x "$start_test_dir/router" "$start_test_dir/storage-proxy"
sed -i.bak \
  -e "s#/opt/sproutos/router#$start_test_dir/router#g" \
  -e "s#/opt/sproutos/storage-proxy#$start_test_dir/storage-proxy#g" \
  "$start_script"
set +e
SURVIVED="$start_test_dir/survived" ATTEMPTS="$start_test_dir/attempts" bash "$start_script" \
  >/dev/null 2>&1
supervisor_status=$?
set -e
[ "$supervisor_status" -eq 7 ]
grep -q survived "$start_test_dir/survived"
grep -q attempted "$start_test_dir/attempts"

echo "user-data heredoc, router supervisor, and website reconciliation configuration are safe"
