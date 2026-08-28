# The on-premises APK signer

SproutOS is developer of record for every Android app it publishes, so one signing key is the
identity of all of them at once. That key is not on the platform. It is on a dedicated machine
somebody else operates, and this document is the contract between the two.

The machine is behind a firewall: it can reach out, nothing can reach in. So SproutOS cannot push
work to it. It polls, which also means it can be offline for a day without anything being lost — a
build queued while it was down is simply signed late.

## The three calls

All three are `POST`, all three carry `Authorization: Bearer $APK_SIGNER_TOKEN`, and all three are
on the public API host (`api.sproutos.me`), not the `/internal` prefix — that prefix means "inside
the VPC", and this caller is not.

### `POST /v1/apk-signing/claim`

```json
{ "signer_id": "signer-01" }
```

`204` means nothing to sign — the common answer. `200` is a job:

```json
{
  "job_id": "01a0…",
  "project_id": "01a0…",
  "deployment_id": "01a0…",
  "download_url": "https://…",
  "unsigned_digest": "<sha256 of the raw APK>",
  "upload_url": "https://…",
  "signed_key": "signed/<project>/<deployment>.apk"
}
```

Both URLs are pre-signed and valid for an hour. For the `android` preset, `download_url` is exactly
one raw unsigned APK with `application/vnd.android.package-archive`; a ZIP, directory, or multiple
APK output is rejected before a signing job exists. **Verify `unsigned_digest` against the raw APK
before signing anything** — that digest is the only thing tying the bytes to the release they claim
to be.

### `POST /v1/apk-signing/complete`

```json
{
  "job_id": "01a0…",
  "signer_id": "signer-01",
  "signed_key": "signed/…/….apk",
  "signed_digest": "<sha256 of what you uploaded>"
}
```

Send it after the upload succeeds, never before. A `409` means the claim expired and somebody else
holds the job now: **discard your artifact and poll again**, do not retry. Retrying a completion
that has been refused once will be refused forever.

### `POST /v1/apk-signing/fail`

```json
{ "job_id": "01a0…", "signer_id": "signer-01", "error": "apksigner exited 1" }
```

The job goes back into the queue. After three failures it is marked `failed` and stops being
offered — three signers in a row failing is a broken artifact, not bad luck.

## The claim, and why it expires

A claim, not a lock. Two signers must not both produce an artifact for one release: not because two
signatures are dangerous, but because the second upload would race the first and the store could
serve either.

`claim` takes it with a conditional `UPDATE`, so two signers polling in the same instant cannot both
win — Postgres decides. The claim goes stale after **ten minutes**, which is two orders of magnitude
longer than signing an APK takes and short enough that a crashed signer costs one poll interval
rather than an afternoon.

If your claim goes stale while you are still working, you have lost the job. `complete` checks that
the claim is still yours and refuses otherwise, which is the case that stops a slow signer from
overwriting the artifact its successor already produced.

## `signer_id`

A label on a claim, not an authorization principal. One token covers the whole signing fleet, so any
holder could assert any id — that is fine, because the token _is_ the trust boundary: a machine
holding it is already permitted to sign. What the id buys is correctness among cooperating signers,
not defence against a hostile one.

Give each machine a stable id. A signer that restarts under a new id every boot cannot reclaim its
own in-flight job and will wait out the ten-minute timeout instead.

## Android developer verification is a separate durable wait

Signing proves which key produced an APK. It does not prove that Google has registered the package
name and that exact certificate to a verified developer. After key provisioning, the control plane
keeps the canonical `android_app` row in `pending_registration` and checks the pair with Google's
Android Developer ID Status API. Only the exact `REGISTERED` response advances the row to
`registered`; `REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT` fails closed. A successful row is
checked again after seven days so revocation or a certificate mismatch cannot remain trusted
forever.

The ten-minute signer claim is unrelated to review time. A status check holds a short claim, records
`last_checked_at`, `next_check_at`, the provider state, and any bounded failure, then releases the
claim. Google's review can therefore take hours or days without a worker holding a job lease. The
singleton reconciler row records worker `last_seen_at`, last completion, and last failure even when
the registration queue is empty. It also atomically reserves the Status API's project-wide 1,000
checks per provider day before making a call. The provider day resets at midnight in
`America/Los_Angeles`, matching Google Cloud quota accounting; this assumes the worker fleet uses
one GCP project and one API key.

HTTP 400, 401, and 403 responses indicate a request or credential problem and stop the current
batch and open a durable terminal circuit. Later minute-scheduled jobs observe that circuit before
reserving quota and make no provider calls. After correcting the credential, request, or provider
contract, rotate the restricted API key or deliberately increment
`ANDROID_REGISTRATION_CIRCUIT_VERSION` in the worker code and deploy the correction. Either changes
the stored configuration fingerprint and reopens the circuit. HTTP 429 also stops the batch so the
fleet does not continue sending after provider quota is exhausted, but remains retryable. HTTP 5xx
and network failures are retried with bounded backoff. Untouched rows are unclaimed on a batch
stop, while already reserved quota remains consumed conservatively.

The project Android status API exposes provider state, last failure, and next-check timestamps for
CLI and future dashboard consumers. This backend change does not add an Android setup/status screen
to the dashboard; that management surface remains separately scoped.

A signed deployment remains queued, and its APK remains absent from both public and personal
catalogues, until both conditions are durable:

- the status API returned `REGISTERED` for the package name and exact SHA-256 certificate;
- the connected repository's setup commit was independently verified and recorded.

Whichever condition arrives second promotes the signed deployment in the same database transaction
that records it. This avoids a crash window where all prerequisites are true but the release stays
queued forever.

The status API uses an API key restricted to the Android Developer ID Status API. Registration and
key management use the separate Android Developer Console API, which requires a user OAuth Web
Server flow and does not support service accounts, workload identity, or API-key authentication.
The signer integration must not guess unpublished mutation schemas; until its OAuth-backed provider
adapter is contract-tested, registration is completed through the existing verified Play Console
account and this reconciler supplies the authoritative readiness transition.

Official references: [Android Developer Console API](https://developer.android.com/developer-verification/guides/developer-console-api),
[Android Developer ID Status API](https://developer.android.com/developer-verification/guides/check-registration-status),
and [Play Console package-name registration](https://support.google.com/googleplay/android-developer/answer/16761053).

## The loop

```bash
while true; do
  job=$(curl -sf -X POST "$API/v1/apk-signing/claim" \
    -H "Authorization: Bearer $APK_SIGNER_TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"signer_id\":\"$SIGNER_ID\"}")

  [ -z "$job" ] && { sleep 30; continue; }   # 204: nothing to do

  # download the raw APK, verify unsigned_digest and structure, zipalign, apksigner sign,
  # upload to upload_url, then complete with the digest of what you uploaded.
  # On any failure: POST /fail with the error and go round again.
done
```

Poll every 30 seconds or so. Nothing here is latency-sensitive — a customer waiting an extra half
minute for a signed build will not notice, and the queue costs one index lookup per poll.

## Configuration

`APK_SIGNER_TOKEN` on the API side. **Unset means every signer is refused**, which is the correct
default for a deployment that has no signer — the empty string is never compared as a value, so a
forgotten environment variable fails closed rather than opening the queue to anyone who sends
`Bearer `.

`ANDROID_DEVELOPER_ID_STATUS_API_KEY` belongs only on the background worker. When it is absent, the
recurring provider check is not scheduled and no registration can advance to `registered`.
