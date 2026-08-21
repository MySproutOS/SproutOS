#!/usr/bin/env bash
#
# Every image a rendered manifest names must exist in the registry.
#
# `render-manifests.mjs` substitutes one `${TAG}` into every image reference, so a release where one
# image was not rebuilt produces a manifest pointing at a tag that does not exist. Kubernetes accepts
# it — the Deployment is valid, the pod is scheduled — and the failure is `ImagePullBackOff` on one
# workload while everything else rolls out green.
#
# That happened three times to `metering-agent` during one session, each time discovered by noticing
# a pod was not Running. The manifests were correct, the apply succeeded, and the billing agent was
# down. This is the check that turns it into a refusal before anything is applied.
#
#   bin/check-images.sh rendered.yaml
#
set -euo pipefail

RENDERED="${1:-}"
[ -n "$RENDERED" ] && [ -f "$RENDERED" ] || { echo "usage: check-images.sh <rendered.yaml>" >&2; exit 2; }

# Every `image:` value, deduplicated. `sed` rather than a YAML parser: the field is one token on one
# line in every manifest here, and a parser would be a dependency for a five-character extraction.
images=$(grep -hoE '^\s+image:\s*\S+' "$RENDERED" | awk '{print $2}' | sort -u)

[ -n "$images" ] || { echo "no images found in $RENDERED — is it rendered?" >&2; exit 1; }

missing=0
for image in $images; do
  # `docker manifest inspect` asks the registry without pulling, so this is a HEAD-shaped check
  # rather than a download of every image on every deploy.
  if docker manifest inspect "$image" >/dev/null 2>&1; then
    echo "  ok      $image"
  else
    echo "  MISSING $image" >&2
    missing=$((missing + 1))
  fi
done

if [ "$missing" -gt 0 ]; then
  echo >&2
  echo "$missing image(s) named by the manifests are not in the registry." >&2
  echo "Build and push them, or render with a tag that exists." >&2
  exit 1
fi

echo "all $(echo "$images" | wc -l | tr -d ' ') images present"
