# Template sandbox readiness was only a shape check

**Found:** 2026-09-02, during the first blocked-catalogue production acceptance run for Memos.

## What looked true

The worker started with `native templates available for linux/arm64`. The ECS host installed the
reviewed Docker seccomp profile, the image contained the pinned Bubblewrap build, and CI asserted
that the profile carried an argument-scoped `clone` exception. A template failure was reported as
invalid protocol JSON, which made the signed plugin artifact look malformed.

## What was actually true

The profile's exact `clone` value still included `CLONE_NEWNET`, but the native launcher had since
added `--share-net`. Bubblewrap therefore requested every reviewed namespace except the network
namespace, Docker denied the unmatched syscall, and the plugin never started. The readiness probe
only detected executables; it did not cross the sandbox boundary. The runner then treated every exit
code 1 as a plugin response and discarded Bubblewrap's stderr when stdout was empty.

The same acceptance run also showed that snapshot-copy fetched the current upstream branch head
instead of the signed catalogue commit. That broke the catalogue's immutable-source claim before
the plugin ran.

## What stops this instance recurring

The Docker profile now admits the exact non-network Bubblewrap clone flags and its check is tied to
the launcher's `--share-net` choice. The ASG references the concrete launch-template version instead
of the literal `$Latest`; that makes every new host-boundary revision an ASG configuration change
and triggers its rolling refresh, so a host-policy repair reaches running instances. Empty exit-1
responses with stderr are surfaced as launcher failures. Signed template installs pass their exact
manifest commit to snapshot-copy, and a regression advances the upstream branch before asserting
that the target still contains the pinned tree.
