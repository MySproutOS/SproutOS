# Android signer attempts were not fenced

## What was wrong

Signer identity was the only proof on completion and failure callbacks. A lease could expire, the
same stable signer could reclaim the job, and then a delayed failure callback from its first attempt
could fail or requeue the second attempt. The callback idempotency key did not help: it identified a
payload, not the claim that authorized the payload.

The APK preflight also trusted `zip::ZipArchive::len()` as the archive entry count. That parser
indexes entries by name and collapses duplicate names. A downstream ZIP or Android parser could
therefore choose different bytes for the same path, and a ZIP64 archive could force unbounded entry
work before any limit was applied.

## What stops it recurring

Every claim now receives a fresh random 256-bit token. The token is persisted with the running
attempt, returned to the signer, included in the payload-bound callback idempotency key, and
required by completion or failure. Callback history retains the token that authorized it, so a
retry is idempotent while a delayed earlier attempt cannot mutate a reclaimed job. A deterministic
database regression uses one signer identity across two claims and delivers the first failure late.

APK validation independently reads the EOCD or ZIP64 EOCD entry count before constructing the
high-level archive. It bounds that declared count and rejects a mismatch with the parser's visible
entries, including duplicate-name collapse. Unit tests demonstrate both the parser differential and
the pre-iteration entry-count rejection.

The SDK 36 diagnostic for a normal Gradle unsigned APK remains accepted, and the complete toolchain
test still signs and verifies a freshly built `com.sproutos.store` release APK.

## Planning context

This work continues the Android/app-store scope recorded in `private_notes/app_store_upload.md` and
the broader launch record in `private_notes/ADDITIONS_1.md`. The earlier
`read-the-readme-md-to-eventual-dusk.md`, `double-sorted-meteor.md`, and
`private_notes/groups.md` plans remain historical context rather than evidence that this provider
and toolchain path was exercised.
