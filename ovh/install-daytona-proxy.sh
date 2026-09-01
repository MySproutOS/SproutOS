#!/usr/bin/env bash
set -euo pipefail

binary=${1:?usage: install-daytona-proxy.sh PATH_TO_BINARY}
test -f "$binary"
test -f /etc/sproutos/daytona-proxy.env

if ! id sproutos-daytona-proxy >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/sproutos-daytona-proxy --shell /usr/sbin/nologin sproutos-daytona-proxy
fi
install -d -o sproutos-daytona-proxy -g sproutos-daytona-proxy -m 0700 /var/lib/sproutos-daytona-proxy
install -d -o root -g root -m 0755 /opt/sproutos/daytona-proxy/bin
install -o root -g root -m 0755 "$binary" /opt/sproutos/daytona-proxy/bin/daytona-proxy
install -o root -g root -m 0644 "$(dirname "$0")/daytona-proxy.service" /etc/systemd/system/daytona-proxy.service
systemctl daemon-reload
systemctl enable --now daytona-proxy.service
systemctl is-active --quiet daytona-proxy.service
