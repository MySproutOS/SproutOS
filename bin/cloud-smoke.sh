#!/usr/bin/env bash
#
# Does SproutOS work on this cluster?
#
# One script, run against every cloud, so "it works on AWS" and "it works on GCP" mean the same
# thing. Written after doing this by hand on GKE and AKS and finding that the differences between
# clouds are not where anyone expects: a Pod Security Standard on one, a ResourceQuota on another, a
# CNI that ignores NetworkPolicy on a third. None of those are visible in a manifest.
#
# It asserts both directions of tenant isolation. A test that only checks the app answers passes
# just as happily on a cluster where nothing is isolated at all — which is exactly how a broken
# ingress rule survived review once already.
#
# Usage:  bin/cloud-smoke.sh <kube-context> [tenant-namespace]
set -euo pipefail

CONTEXT="${1:?usage: cloud-smoke.sh <kube-context> [tenant-namespace]}"
TENANT_NS="${2:-tenant-smoke}"
KNATIVE_VERSION="${KNATIVE_VERSION:-knative-v1.23.0}"
K="kubectl --context=$CONTEXT"

step() { printf '\n=== %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

step "cluster"
$K get nodes --no-headers | awk '{print "  " $1, $2, $5}'

step "Knative Serving and Kourier"
for manifest in serving-crds serving-core; do
  $K apply -f "https://github.com/knative/serving/releases/download/$KNATIVE_VERSION/$manifest.yaml" >/dev/null
done
$K apply -f "https://github.com/knative/net-kourier/releases/download/$KNATIVE_VERSION/kourier.yaml" >/dev/null
$K apply -f deploy/knative/config-network.yaml >/dev/null
$K apply -f deploy/knative/config-features.yaml >/dev/null
$K patch configmap/config-domain -n knative-serving --type merge -p '{"data":{"sprout.run":""}}' >/dev/null

# Test clusters are small. These are requests, not limits, and nothing here is under load — but the
# gateway is created last and is the first thing that fails to schedule when they are not trimmed.
for ns in knative-serving kourier-system; do
  $K set resources deploy --all -n "$ns" --requests=cpu=25m,memory=64Mi >/dev/null || true
done

# `net-kourier-controller` before the gateway: it is what programs the gateway's bootstrap config,
# and until it has, the gateway's own readiness probe fails.
for d in controller webhook activator autoscaler net-kourier-controller; do
  $K -n knative-serving rollout status "deploy/$d" --timeout=300s >/dev/null || fail "$d never became available"
done
$K -n kourier-system rollout status deploy/3scale-kourier-gateway --timeout=420s >/dev/null \
  || fail "the Kourier gateway never became available"
echo "  ready"

step "SproutOS manifests"
TAG="${TAG:-smoke}" TENANT_NAMESPACE="$TENANT_NS" \
TENANT_POSTGRES_HOST="${TENANT_POSTGRES_HOST:-pg.invalid}" \
TENANT_VALKEY_HOST="${TENANT_VALKEY_HOST:-valkey.invalid}" \
TENANT_OPENSEARCH_HOST="${TENANT_OPENSEARCH_HOST:-os.invalid}" \
BUILD_REGISTRY_CIDR="${BUILD_REGISTRY_CIDR:-0.0.0.0/0}" \
  pnpm exec tsx bin/render-manifests.mjs "${TOFU_OUTPUTS:?set TOFU_OUTPUTS to a rendered outputs.json}" \
  > /tmp/smoke-rendered.yaml

# External Secrets resources need the operator; everything else must apply cleanly. Counted rather
# than ignored, so a *new* kind of failure is not swallowed with the expected one.
errors=$($K apply -f /tmp/smoke-rendered.yaml 2>&1 | grep -icE '^error|no matches' || true)
unexpected=$($K apply -f /tmp/smoke-rendered.yaml 2>&1 | grep -iE '^error|no matches' | grep -vciE 'external-secrets' || true)
echo "  apply: $errors expected (External Secrets), $unexpected unexpected"
[ "$unexpected" = "0" ] || fail "manifests did not apply cleanly"

step "every controller created its pods"
sleep 20
desired=$($K get ds -n sproutos-metering metering-agent -o jsonpath='{.status.desiredNumberScheduled}')
scheduled=$($K get ds -n sproutos-metering metering-agent -o jsonpath='{.status.currentNumberScheduled}')
echo "  metering-agent: desired=$desired scheduled=$scheduled"
# A DaemonSet forbidden by a Pod Security Standard reports desired > 0 and scheduled 0, and raises
# nothing anywhere else. That is how it went unnoticed for weeks.
[ "$desired" = "$scheduled" ] || fail "the metering DaemonSet could not create a pod on every node"

for dep in internal-api website worker pg-proxy valkey-proxy search-proxy; do
  want=$($K get deploy -n sproutos-system "$dep" -o jsonpath='{.spec.replicas}')
  got=$($K get deploy -n sproutos-system "$dep" -o jsonpath='{.status.replicas}' 2>/dev/null || echo 0)
  printf '  %-14s spec=%s created=%s\n' "$dep" "$want" "${got:-0}"
  # `-ge`, not `=`. `status.replicas` counts pods across the old *and* new ReplicaSets during a
  # rollout, so it exceeds `spec.replicas` transiently — an equality check here fails intermittently
  # for a reason that has nothing to do with what is being tested. What matters is that the
  # controller was *able* to create pods: a Pod Security Standard rejection gives zero.
  [ "${got:-0}" -ge "$want" ] || fail "$dep could not create its pods"
done

# The images are registry references this cluster cannot pull, so the pods will not start — which is
# fine and not what is being tested. They still hold CPU requests the tenant revision needs.
$K scale deploy --all -n sproutos-system --replicas=0 >/dev/null

step "a tenant application serves a request, and only that way"
$K apply -f - >/dev/null <<YAML
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: smoke
  namespace: $TENANT_NS
spec:
  template:
    spec:
      containers:
        - image: ghcr.io/knative/helloworld-go:latest
          ports: [{ containerPort: 8080 }]
          env: [{ name: TARGET, value: "$CONTEXT" }]
          # No runAsNonRoot: tenant namespaces enforce baseline, not restricted, because customer
          # images routinely run as root — and this sample is one of them.
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: ["ALL"] }
            seccompProfile: { type: RuntimeDefault }
YAML
$K wait --for=condition=Ready "ksvc/smoke" -n "$TENANT_NS" --timeout=420s >/dev/null \
  || fail "the tenant Service never became ready"

url=$($K get ksvc smoke -n "$TENANT_NS" -o jsonpath='{.status.url}')
host=${url#http://}
label=${host%.sprout.run}
[ "$label" != "$host" ] || fail "$host is not under sprout.run"
case "$label" in
  # `*.*` and not a glob over the whole host: shell `*` matches dots, so globbing the host flags a
  # correct single-label name as loudly as a wrong one.
  *.*) fail "'$label' is more than one label; one wildcard certificate cannot cover it" ;;
esac
echo "  url: $url (one label)"

stored=$($K get ksvc smoke -n "$TENANT_NS" -o jsonpath='{.spec.template.spec.runtimeClassName}' || true)
echo "  runtimeClassName stored: ${stored:-<unset>}"

probe() {
  $K delete pod "$1" -n default --ignore-not-found >/dev/null
  $K run "$1" -n default --image=curlimages/curl:latest --restart=Never -- \
    sh -c "curl -sS -m 30 --fail-with-body $2" >/dev/null
  for _ in $(seq 1 25); do
    phase=$($K get pod "$1" -n default -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$phase" in Succeeded|Failed) break ;; esac
    sleep 4
  done
  echo "${phase:-Unknown}"
}

got=$(probe smoke-allowed "-H 'Host: $host' http://kourier-internal.kourier-system.svc.cluster.local/")
echo "  via gateway: $got — $($K logs -n default smoke-allowed 2>/dev/null | head -1)"
[ "$got" = "Succeeded" ] || fail "the tenant application could not be reached through the gateway"

ip=$($K get pods -n "$TENANT_NS" -l serving.knative.dev/service=smoke \
       -o jsonpath='{.items[0].status.podIP}')
got=$(probe smoke-denied "http://$ip:8012/")
echo "  direct to pod $ip: $got"
# Without this half the whole test passes on a cluster whose CNI ignores NetworkPolicy entirely.
[ "$got" = "Failed" ] || fail "a pod outside the tenant namespace reached a tenant pod directly"

$K delete pod smoke-allowed smoke-denied -n default --ignore-not-found >/dev/null

printf '\nPASS: %s\n' "$CONTEXT"
