#!/usr/bin/env bash
#
# Prepare the OVH host. Idempotent — safe to re-run, and re-running is how you fix drift.
#
# Run on the host, not from a laptop:
#   ssh -i ~/.ssh/id_ovhcloud_... ubuntu@135.148.122.203 'bash -s' < ovh/bootstrap.sh
set -euo pipefail

DATA_MOUNT=/data
ROOT_DATA=/srv/sproutos

echo "==> checking mounts"
for mount in / "$DATA_MOUNT"; do
  findmnt -no TARGET "$mount" >/dev/null || { echo "missing mount: $mount" >&2; exit 1; }
done

echo "==> installing docker"
if ! command -v docker >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
fi
docker --version || sudo docker --version

echo "==> kernel settings"
# `vm.max_map_count` is what OpenSearch refuses to start without; this host already exceeds it, and
# it is set anyway so a rebuilt host does not depend on a default.
#
# `vm.overcommit_memory=1` is Valkey's requirement: a background save forks, and with heuristic
# overcommit the fork can be refused for memory that will never actually be touched.
sudo tee /etc/sysctl.d/99-sproutos.conf >/dev/null <<'CONF'
vm.max_map_count = 262144
vm.overcommit_memory = 1
vm.swappiness = 1
CONF
sudo sysctl -q --system

echo "==> disabling swap"
# A swapped JVM heap is pathological: the garbage collector touches the whole heap and every page it
# reads back is a disk seek. OpenSearch's own guidance is to turn swap off outright. Valkey's
# preference for swap is answered by the overcommit setting above, which is the thing it needs.
if swapon --show | grep -q .; then
  sudo swapoff -a
  # And out of fstab, or the next reboot brings it back and nobody looks.
  sudo sed -i.bak '/\bswap\b/s/^/#/' /etc/fstab
fi

echo "==> data directories"
# OpenSearch and Valkey on the root NVMe; ClickHouse and Kafka on the second, because Kafka's own
# hardware guide asks not to share its drive with other filesystem activity and ClickHouse merges
# are the noisiest neighbour on offer.
sudo mkdir -p "$ROOT_DATA"/{opensearch,valkey-queue,valkey-cache}
sudo mkdir -p "$ROOT_DATA/opensearch-security/certs"
sudo mkdir -p "$DATA_MOUNT"/sproutos/{clickhouse,clickhouse-logs,kafka}
# OpenSearch runs as uid 1000 inside its image and will not start if it cannot write its data dir.
sudo chown -R 1000:1000 "$ROOT_DATA/opensearch"

echo "==> OpenSearch transport certificates"
CERT_DIR="$ROOT_DATA/opensearch-security/certs"
if [ ! -e "$CERT_DIR/root-ca.pem" ]; then
  # Generated on the host and never checked in. The admin key is retained only for an emergency
  # on-host securityadmin repair over transport TLS; the router receives neither it nor the CA key.
  sudo openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$CERT_DIR/root-ca-key.pem"
  sudo openssl req -x509 -new -sha256 -days 3650 -key "$CERT_DIR/root-ca-key.pem" \
    -subj '/CN=sproutos-opensearch-ca' -out "$CERT_DIR/root-ca.pem"
  for kind in node admin; do
    if [ "$kind" = node ]; then
      cn=sproutos-opensearch-node
      extensions='subjectAltName=DNS:sproutos-1,DNS:opensearch,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth'
    else
      cn=sproutos-opensearch-admin
      extensions='extendedKeyUsage=clientAuth'
    fi
    sudo openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$CERT_DIR/$kind-key.pem"
    sudo openssl req -new -key "$CERT_DIR/$kind-key.pem" -subj "/CN=$cn" -out "$CERT_DIR/$kind.csr"
    printf '%b\n' "$extensions" | sudo openssl x509 -req -sha256 -days 1825 \
      -in "$CERT_DIR/$kind.csr" -CA "$CERT_DIR/root-ca.pem" -CAkey "$CERT_DIR/root-ca-key.pem" \
      -CAcreateserial -extfile /dev/stdin -out "$CERT_DIR/$kind.pem"
    sudo rm "$CERT_DIR/$kind.csr"
  done
  sudo rm -f "$CERT_DIR/root-ca.srl"
fi
for required in root-ca.pem node.pem node-key.pem admin.pem admin-key.pem; do
  [ -s "$CERT_DIR/$required" ] || { echo "incomplete OpenSearch certificate set: $required" >&2; exit 1; }
done
# The OpenSearch Security plugin warns on group/world-readable certificate files as well as keys.
# The container runs as uid 1000, which owns the directory below, so no broader mode is needed.
sudo chmod 0600 "$CERT_DIR"/*.pem
sudo chown -R 1000:1000 "$ROOT_DATA/opensearch-security"
# ClickHouse runs as 101; Kafka as 1000.
sudo chown -R 101:101 "$DATA_MOUNT"/sproutos/clickhouse "$DATA_MOUNT"/sproutos/clickhouse-logs
sudo chown -R 1000:1000 "$DATA_MOUNT"/sproutos/kafka
sudo mkdir -p /opt/sproutos
sudo chown "$USER":"$USER" /opt/sproutos

echo "==> Kafka's certificate, and the renewal that has to reach it"
#
# Two separate things were missing and each one alone is enough to take the log pipeline down on the
# day the certificate expires.
#
# **It could not renew.** The certificate was obtained with `--standalone`, which binds port 80 —
# and Traefik holds port 80 on this host, so every renewal since has failed:
#
#     Could not bind TCP port 80 because it is already in use by another process on this system
#
# The timer runs twice a day and fails quietly, so the first visible symptom would have been the
# expiry itself. `dns-route53` needs no port; the credential is a scoped IAM user created in
# `tofu/dns.tf`, and it is the only thing about this host that lives in AWS.
#
# **Nothing carried a renewed certificate to Kafka.** Kafka reads one PEM — the private key followed
# by the chain — from a path certbot does not write, and it reads it at startup. So even a renewal
# that succeeded would have left the broker serving the old certificate until somebody noticed. The
# deploy hook below is that missing step, and it belongs here rather than in anybody's head.
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/kafka-keystore.sh >/dev/null <<'HOOK'
#!/usr/bin/env bash
# Rebuild the PEM Kafka reads, then restart it so the new one is loaded.
#
# `RENEWED_LINEAGE` is set by certbot to the `live/` directory of whichever certificate it just
# renewed, so this fires for the Kafka one and no-ops for any other.
set -euo pipefail

[ "${RENEWED_LINEAGE:-}" = "/etc/letsencrypt/live/kafka.sproutos.me" ] || exit 0

DEST=/data/sproutos/kafka-tls/keystore.pem
install -d -m 0755 "$(dirname "$DEST")"

# Written to a temporary file and moved into place, because Kafka may read this at any moment and a
# half-written PEM is a broker that will not start.
TMP=$(mktemp)
cat "$RENEWED_LINEAGE/privkey.pem" "$RENEWED_LINEAGE/fullchain.pem" > "$TMP"
chmod 0644 "$TMP"
mv "$TMP" "$DEST"

# Restart rather than reload: Kafka reads the keystore at startup and has no signal for this.
docker restart sproutos_kafka >/dev/null
HOOK
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/kafka-keystore.sh

# The same problem for the tenant queue, and the same shape of answer.
#
# Valkey terminates its own TLS rather than sitting behind Traefik. That is not a preference: a
# Traefik **TCP** router with TLS on the shared `websecure` entrypoint stops Traefik answering the
# `acme-tls/1` ALPN, which breaks Let's Encrypt's `tls-alpn-01` challenge for *every* domain on 443
# — the forum included. Measured, both ways, on this host. So the queue gets a certificate of its
# own on a port of its own, and Traefik never sees it.
sudo tee /etc/letsencrypt/renewal-hooks/deploy/valkey-tls.sh >/dev/null <<'HOOK'
#!/usr/bin/env bash
# Put the renewed certificate where the queue's container can read it, then restart it.
set -euo pipefail

[ "${RENEWED_LINEAGE:-}" = "/etc/letsencrypt/live/queue.sproutos.me" ] || exit 0

DEST=/srv/sproutos/valkey-tls
install -d -m 0755 "$DEST"

# Copied rather than symlinked: `live/` is a symlink into `archive/`, and a container that mounts
# `live/` sees a dangling link because `archive/` is outside the bind mount. That failure is a
# Valkey which starts, cannot read its key, and exits — on a renewal, months from now.
install -m 0644 "$RENEWED_LINEAGE/fullchain.pem" "$DEST/fullchain.pem"

# Owned by the uid Valkey actually runs as, not by root.
#
# `docker exec` lands as root, so a root-owned `0600` key looks readable when you check it by hand.
# The server does not run as root — the image's entrypoint drops to `valkey`, uid 999 — so it reads
# the key as 999 and gets `error:8000000D:system library::Permission denied`, then exits, then
# restarts, forever. Which is what happened.
install -m 0600 "$RENEWED_LINEAGE/privkey.pem" "$DEST/privkey.pem"
# `chown` and not `install -o 999`: this host has no user with that id, and GNU install resolves the
# argument against the *host's* passwd file — "invalid user: '999'" — while the id only means
# anything inside the container. `chown` takes the number as a number.
chown 999:1000 "$DEST/privkey.pem"

# Valkey reads its certificate at startup and has no signal to reload one.
docker restart sproutos_valkey_queue >/dev/null
HOOK
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/valkey-tls.sh

echo
echo "host prepared. Copy the compose file and start:"
echo "  scp ovh/docker-compose.yaml ovh/.env ovh/bootstrap-kafka.sh ovh/bootstrap-opensearch-security.sh ovh/opensearch-entrypoint.sh ubuntu@<host>:/opt/sproutos/"
echo "  scp -r ovh/opensearch-security ubuntu@<host>:/opt/sproutos/"
echo "  ssh ubuntu@<host> 'cd /opt/sproutos && docker compose up -d && ./bootstrap-opensearch-security.sh && ./bootstrap-kafka.sh'"
