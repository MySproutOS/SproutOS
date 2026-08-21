#!/usr/bin/env bash
#
# Build an image, push it, and prove the registry now has *that* image.
#
# `docker push` exits 0 and prints the reference when it has not uploaded the image.
#
# Observed, not theorised. A worker image was built with a fix, pushed with `--quiet`, reported
# success, and tagged in Artifact Registry — `gcloud artifacts docker tags list` showed the tag. The
# rolled-out pod ran code from hours earlier. Pulling the tag back and grepping the bundle showed
# the registry's copy did not contain the change at all.
#
# Two things were wrong and each alone is enough:
#
#   1. **A tag existing is not evidence about its content.** The check that was here
#      (`bin/check-images.sh`) asks whether a tag resolves, which is the right question for "did we
#      forget to build this one" and no question at all about "is this the image we just built".
#
#   2. **buildx writes a manifest list with a provenance attestation, and a partial upload leaves
#      the tag pointing somewhere else.** The same session's small test push said so out loud:
#      `Not all multiplatform-content is present and only the available single-platform image was
#      pushed`. For a single-platform deployment image the attestation buys nothing and costs this.
#
# So: `--provenance=false` for one manifest, and afterwards compare the digest the *registry* now
# serves for the tag against the digest of what was built. Not the tag, not the exit code — the
# digest.
#
#   bin/push-image.sh <dockerfile> <image-ref> [--build-arg K=V ...]
#
set -euo pipefail

DOCKERFILE="${1:-}"
IMAGE="${2:-}"
shift 2 || true

[ -n "$DOCKERFILE" ] && [ -n "$IMAGE" ] || {
  echo "usage: push-image.sh <dockerfile> <image-ref> [docker build args...]" >&2
  exit 2
}

# The platform the cluster runs, not the platform this laptop is. An arm64 image on amd64 nodes is
# an `exec format error` in a CrashLoopBackOff, which reads as an application bug.
PLATFORM="${TARGET_PLATFORM:-linux/amd64}"

echo "building $IMAGE for $PLATFORM"
docker build --provenance=false --platform "$PLATFORM" -f "$DOCKERFILE" -t "$IMAGE" "$@" .

# The digest of what was just built, read from the local daemon before anything is pushed.
built=$(docker image inspect "$IMAGE" --format '{{.Id}}')
[ -n "$built" ] || { echo "could not read the built image's id" >&2; exit 1; }

echo "pushing $IMAGE"
docker push --quiet "$IMAGE"

# Force a fetch rather than trusting the local copy: the question is what the *registry* holds.
docker image rm "$IMAGE" >/dev/null 2>&1 || true
docker pull --quiet --platform "$PLATFORM" "$IMAGE" >/dev/null

pushed=$(docker image inspect "$IMAGE" --format '{{.Id}}')

if [ "$built" != "$pushed" ]; then
  echo >&2
  echo "the registry does not have the image that was just built:" >&2
  echo "  built:  $built" >&2
  echo "  pulled: $pushed" >&2
  echo >&2
  echo "The push reported success. It did not upload. Retry, and do not deploy this tag." >&2
  exit 1
fi

echo "ok: $IMAGE is in the registry, digest $pushed"
