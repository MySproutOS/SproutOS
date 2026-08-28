# Android signing infrastructure

This is the custody and operations boundary for the Android pipeline described in
`private_notes/app_store_upload.md`. The application schema, API, and signer protocol live with
their implementations; this document covers what must exist around them.

## AWS holds ciphertext and release artifacts, not the signing identity

OpenTofu creates one private, versioned `sproutos-android-artifacts-<account>` bucket and one
dedicated rotating KMS key. The prefixes have different retention contracts:

- `raw/` holds an unsigned APK for 30 days by default, long enough for retries and diagnosis.
- `signed/` holds verified distributable APKs without a current-version expiry.
- `keys/` holds signer-encrypted per-app keystores without any version expiry.

SSE-KMS is a second storage-layer control. It does not replace the signer's client-side envelope:
only the on-prem master identity can open `keys/` ciphertext, and that identity never enters AWS.
The bucket and KMS key both resist an accidental OpenTofu destroy.

The shared ECS API task role may presign exact `GetObject`, `GetObjectVersion`, and `PutObject`
operations below those three prefixes. It cannot list the bucket or delete an object. The signer
has no IAM identity or AWS credential; it can use only the short-lived exact-object URLs returned
by the authenticated API.

SSE-KMS is a bucket default, not a caller header contract. A presigned signer PUT must not require
`x-amz-server-side-encryption` or a KMS-key-id header unless the API also returns an explicit,
allowlisted signed-header map. The signer currently sends only `Content-Type` and `Content-Length`;
S3 applies the bucket's KMS key after accepting those bytes.

## Secrets and host prerequisites

Generate a high-entropy `APK_SIGNER_TOKEN`, put it in the local `.env`, and run
`bin/put-app-secrets.sh`. The script writes it directly to the application Parameter Store path;
OpenTofu creates no parameter value, so the token never enters state. The API container loads it;
the website and worker do not.

On the dedicated signing host, provision these outside OpenTofu and outside AWS:

- the same `APK_SIGNER_TOKEN`, mode `0600`;
- a stable `APK_SIGNER_ID`;
- an RSA PKCS#8 master identity at a durable `APK_SIGNER_MASTER_IDENTITY_PATH`;
- a durable, backed-up `APK_SIGNER_STATE_DIR` for the recovery journal;
- Android SDK Build Tools (`aapt2`, `apksigner`, and `zipalign`) and a Java `keytool`;
- an HTTPS `APK_SIGNER_API_URL`.

The host is outbound-only. Do not open an inbound port, install an AWS credential, or place the
master identity in SSM, Secrets Manager, S3, an image, or this repository. The Android Developer
Console automation contract is not yet confirmed, so do not invent or upload an OAuth refresh
token until that flow is implemented and consented.

## Alarm rollout

`android_signing_alarms_enabled` defaults to `false`. Enabling it creates heartbeat, oldest queued
job, and terminal-failure alarms plus an encrypted SNS topic. Before changing the variable:

**Current prerequisite status:** the repository does not yet contain a durable signer last-seen
record or a scheduled oldest-queued-job metric producer. The alarm resources are therefore defined
but deliberately disabled; a successful OpenTofu validation is not evidence that those signals
exist.

1. land a durable signer registry/last-seen record and a scheduled queue-health sampler;
2. emit `SignerHeartbeatAgeSeconds`, `OldestQueuedJobAgeSeconds`, and `FailedJobs` into the
   `SproutOS/AndroidSigner` namespace without putting CloudWatch calls on the claim/complete
   request's failure path;
3. subscribe and confirm an operations destination on `android_signing_alarm_topic_arn`;
4. start the signer and confirm fresh metrics, then enable and apply the alarms.

Missing heartbeat data is deliberately treated as a breach. Enabling the alarms before those four
steps creates noise rather than monitoring.

## Apply boundary

The reviewed plan for this change should contain the dedicated KMS key and alias, bucket controls,
lifecycle and transport policy, an application-policy update, an ECS execution-policy update for
`APK_SIGNER_TOKEN`, and a new ECS task-definition revision carrying `ANDROID_ARTIFACT_BUCKET`.
Do not apply it independently of the matching backend release: the new task definition requires
the SSM token to exist, and the API must use the dedicated bucket before live uploads begin.
