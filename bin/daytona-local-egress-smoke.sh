#!/usr/bin/env bash
set -euo pipefail

# Exercise Daytona against the real Rust egress boundary without deploying the control plane.
# ngrok's free HTTP endpoint cannot carry CONNECT, so this uses a raw TCP endpoint and an
# explicitly test-only HTTP upstream. A fresh root key makes the short-lived Basic credential
# useless after this process removes the control-plane fixture.

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${1:-"$repo_root/.env"}
ngrok_api=http://127.0.0.1:4040
proxy_port=3128
router_port=18080
postgres_test_port=25432
metering_test_port=25433
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/sproutos-daytona-smoke.XXXXXX")
router_pid=
postgres_test_pid=
metering_test_pid=
ngrok_pid=
tunnel_name=
tunnel_created=0

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ "$status" != 0 && -f "$tmp_dir/router.log" ]]; then
    echo "Rust proxy log:" >&2
    tail -n 80 "$tmp_dir/router.log" >&2
  fi
  if [[ -n "$router_pid" ]]; then
    kill "$router_pid" 2>/dev/null || true
    wait "$router_pid" 2>/dev/null || true
  fi
  if [[ -n "$postgres_test_pid" ]]; then
    kill "$postgres_test_pid" 2>/dev/null || true
    wait "$postgres_test_pid" 2>/dev/null || true
  fi
  if [[ -n "$metering_test_pid" ]]; then
    kill "$metering_test_pid" 2>/dev/null || true
    wait "$metering_test_pid" 2>/dev/null || true
  fi
  if [[ "$tunnel_created" == 1 && -n "$tunnel_name" ]]; then
    curl --silent --request DELETE "$ngrok_api/api/tunnels/$tunnel_name" >/dev/null || true
  fi
  if [[ -n "$ngrok_pid" ]]; then
    kill "$ngrok_pid" 2>/dev/null || true
    wait "$ngrok_pid" 2>/dev/null || true
  fi
  rm -f "$tmp_dir/router.log" "$tmp_dir/ngrok.log"
  rmdir "$tmp_dir/metering-spool" 2>/dev/null || true
  rmdir "$tmp_dir" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM

if [[ ! -f "$env_file" ]]; then
  echo "environment file not found: $env_file" >&2
  exit 1
fi
for command in cargo curl jq ngrok openssl pnpm; do
  if ! command -v "$command" >/dev/null; then
    echo "required command not found: $command" >&2
    exit 1
  fi
done
if lsof -nP -iTCP:"$proxy_port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "local proxy port $proxy_port is already in use" >&2
  exit 1
fi
if lsof -nP -iTCP:"$postgres_test_port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "local Postgres transport-test port $postgres_test_port is already in use" >&2
  exit 1
fi
if lsof -nP -iTCP:"$metering_test_port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "local metering-test port $metering_test_port is already in use" >&2
  exit 1
fi

env_value() {
  if [[ ${!1+x} == x ]]; then
    printf '%s' "${!1}"
    return
  fi
  value=$(sed -n "s/^$1=//p" "$env_file" | tail -n 1)
  value=${value#\"}
  value=${value%\"}
  printf '%s' "$value"
}

database_url=$(env_value DATABASE_URL)
valkey_url=$(env_value VALKEY_URL)
daytona_api_key=$(env_value DAYTONA_API_KEY)
daytona_organization_id=$(env_value DAYTONA_ORGANIZATION_ID)
daytona_snapshot=$(env_value SANDBOX_DAYTONA_SNAPSHOT)
daytona_api_url=$(env_value SANDBOX_DAYTONA_API_URL)
daytona_target=$(env_value SANDBOX_DAYTONA_TARGET)
proxy_root_key=$(openssl rand -base64 32 | tr -d '\n')

if [[ -z "$database_url" || -z "$valkey_url" || -z "$daytona_api_key" || \
  -z "$daytona_organization_id" || -z "$daytona_snapshot" ]]; then
  echo "DATABASE_URL, VALKEY_URL, Daytona credentials, and the Daytona snapshot are required" >&2
  exit 1
fi

if ! curl --fail --silent "$ngrok_api/api/tunnels" >/dev/null 2>&1; then
  ngrok tcp "$proxy_port" --log stdout --log-format json >"$tmp_dir/ngrok.log" 2>&1 &
  ngrok_pid=$!
  for _ in {1..30}; do
    curl --fail --silent "$ngrok_api/api/tunnels" >/dev/null 2>&1 && break
    sleep 0.2
  done
fi

if [[ -n "$ngrok_pid" ]]; then
  public_url=$(curl --fail --silent "$ngrok_api/api/tunnels" | jq -r \
    '.tunnels[] | select(.proto == "tcp") | .public_url' | head -n 1)
else
  tunnel_name="sproutos-daytona-egress-$$"
  response=$(curl --fail-with-body --silent --show-error --request POST \
    "$ngrok_api/api/tunnels" \
    --header 'content-type: application/json' \
    --data "$(jq -cn --arg name "$tunnel_name" --arg addr "127.0.0.1:$proxy_port" \
      '{name: $name, addr: $addr, proto: "tcp", inspect: false}')")
  public_url=$(jq -r '.public_url' <<<"$response")
  tunnel_created=1
fi
if [[ "$public_url" != tcp://* ]]; then
  echo "ngrok did not provide a TCP endpoint" >&2
  exit 1
fi
live_proxy_url="http://${public_url#tcp://}"
resolver_proxy_url="https://${public_url#tcp://}"

# The transport assertion needs a real byte after CONNECT, not merely the proxy's 200 response.
# This tiny listener speaks exactly the first Postgres TLS-negotiation byte; the pg-proxy's own TLS
# and startup behavior has separate integration coverage.
node -e 'const net=require("node:net");const port=Number(process.argv[1]);net.createServer(s=>s.once("data",()=>s.end("S"))).listen(port,"127.0.0.1")' "$postgres_test_port" &
postgres_test_pid=$!
# The forward proxy deliberately refuses to boot without durable metering. This local receiver
# exercises that fail-closed configuration without posting test usage into a real ingest service.
node -e 'const http=require("node:http");const port=Number(process.argv[1]);http.createServer((req,res)=>{req.resume();req.on("end",()=>{res.writeHead(202);res.end()})}).listen(port,"127.0.0.1")' "$metering_test_port" &
metering_test_pid=$!
for _ in {1..30}; do
  if lsof -nP -iTCP:"$postgres_test_port" -sTCP:LISTEN >/dev/null 2>&1 && \
    lsof -nP -iTCP:"$metering_test_port" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if ! lsof -nP -iTCP:"$postgres_test_port" -sTCP:LISTEN >/dev/null 2>&1 || \
  ! lsof -nP -iTCP:"$metering_test_port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "local transport fixtures did not start" >&2
  exit 1
fi

env \
  DATABASE_URL="$database_url" \
  VALKEY_URL="$valkey_url" \
  FORWARD_PROXY_LISTEN="127.0.0.1:$proxy_port" \
  SANDBOX_FORWARD_PROXY_URL="$resolver_proxy_url" \
  SANDBOX_FORWARD_PROXY_ROOT_KEY="$proxy_root_key" \
  SERVICE_POSTGRES_PUBLIC_HOST=postgres.sproutos.me \
  SERVICE_POSTGRES_PUBLIC_PORT=5432 \
  PG_PROXY_LISTEN="127.0.0.1:$postgres_test_port" \
  ROUTER_PORT="$router_port" \
  AWS_REGION=us-east-1 \
  AWS_ACCOUNT_ID=000000000000 \
  AWS_ACCESS_KEY_ID=test \
  AWS_SECRET_ACCESS_KEY=test \
  AWS_ENDPOINT_URL=http://127.0.0.1:4566 \
  METERING_INGEST_URL="http://127.0.0.1:$metering_test_port/v1/metering/events" \
  METERING_INGEST_HMAC_KEY=test-only-daytona-smoke \
  FORWARD_PROXY_METERING_SPOOL_DIR="$tmp_dir/metering-spool" \
  cargo run -p router --bin router >"$tmp_dir/router.log" 2>&1 &
router_pid=$!

for _ in {1..300}; do
  if ! kill -0 "$router_pid" 2>/dev/null; then
    tail -n 80 "$tmp_dir/router.log" >&2
    exit 1
  fi
  if lsof -nP -iTCP:"$proxy_port" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
if ! lsof -nP -iTCP:"$proxy_port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "the Rust forward proxy did not start" >&2
  tail -n 80 "$tmp_dir/router.log" >&2
  exit 1
fi

# The local API returns a TCP address before every ngrok edge has begun accepting it. Do not rent a
# Daytona sandbox until a CONNECT has crossed ngrok and the Rust proxy has answered its expected
# unauthenticated 407.
for _ in {1..60}; do
  status=$(curl --proxy "$live_proxy_url" --connect-timeout 2 --max-time 3 --silent \
    --output /dev/null --write-out '%{http_code}' http://example.com || true)
  [[ "$status" == 407 ]] && break
  sleep 0.5
done
if [[ "$status" != 407 ]]; then
  echo "the ngrok TCP endpoint did not reach the local Rust proxy" >&2
  exit 1
fi

echo "Running the real Daytona egress smoke test through $live_proxy_url"
env \
  DATABASE_URL="$database_url" \
  DAYTONA_API_KEY="$daytona_api_key" \
  DAYTONA_ORGANIZATION_ID="$daytona_organization_id" \
  SANDBOX_DAYTONA_SNAPSHOT="$daytona_snapshot" \
  SANDBOX_DAYTONA_API_URL="$daytona_api_url" \
  SANDBOX_DAYTONA_TARGET="$daytona_target" \
  SANDBOX_FORWARD_PROXY_URL="$resolver_proxy_url" \
  SANDBOX_LIVE_FORWARD_PROXY_URL="$live_proxy_url" \
  SANDBOX_FORWARD_PROXY_ROOT_KEY="$proxy_root_key" \
  SANDBOX_LIVE_EGRESS_CONTROL_PLANE=1 \
  pnpm exec vitest run lib/typescript/jobs/src/sandbox-stop.live.test.ts \
    -t 'routes arbitrary HTTPS through the proxy while blocking bypass and metadata'

echo "Daytona egress smoke passed; the test destroyed its sandbox and removed its database fixture."
