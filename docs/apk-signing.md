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
  "unsigned_digest": "<sha256 of the archive>",
  "upload_url": "https://…",
  "signed_key": "signed/<project>/<deployment>.apk"
}
```

Both URLs are pre-signed and valid for an hour. `download_url` is the build archive the customer's
GitHub Action uploaded — a **zip** of the release output directory, which for the `android` preset
contains the unsigned APK. (Zip, not tar.gz: Lambda reads only zip, and one archive format across
every preset is simpler than two.) **Verify `unsigned_digest` against what you downloaded before you sign
anything** — that digest is the only thing tying the bytes to the release they claim to be.

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

## The loop

```bash
while true; do
  job=$(curl -sf -X POST "$API/v1/apk-signing/claim" \
    -H "Authorization: Bearer $APK_SIGNER_TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"signer_id\":\"$SIGNER_ID\"}")

  [ -z "$job" ] && { sleep 30; continue; }   # 204: nothing to do

  # download, verify unsigned_digest, unzip the APK, zipalign, apksigner sign,
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
