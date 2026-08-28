# Android signing infrastructure

This is the custody and operations boundary for the Android pipeline described in
`private_notes/app_store_upload.md`. The application schema, API, and signer protocol live with
their implementations; this document covers what must exist around them.

## Integration order

This change is deliberately based on current `main`, but it must be forward-integrated after the
ordered application stack: PR #189 owns migration `11_06`, PR #190 owns `11_07`, and PR #192 owns
the signer and migration `11_08`. Rebase this infrastructure after all three; do not copy their
application commits here. Automatic deployment means merging this PR is an infrastructure apply,
not merely a source-code staging step.

The infrastructure and credential delivery are deliberately separate applies. The default first
apply creates the custody bucket, KMS key, lifecycle, and IAM without placing any new Android SSM
reference in the ECS task definition. This keeps an unrelated application or CLI rollout deployable
while the parameters are absent. Only the explicit, metadata-preflighted second plan may inject the
credentials into the exact post-#192 image. PR #151 is superseded by this rebuild and must never be
stacked or merged afterward.

## AWS holds ciphertext and release artifacts, not the signing identity

OpenTofu creates one private, versioned `sproutos-android-artifacts-<account>` bucket and one
dedicated rotating KMS key. The prefixes have different retention contracts:

- `raw/` holds an unsigned APK for 30 days by default, long enough for retries and diagnosis.
- `signed/` holds verified distributable APKs without a current-version expiry.
- `keys/` holds signer-encrypted per-app keystores, including the independent
  `com.sproutos.store` client identity, without any current or noncurrent version expiry.

SSE-KMS is a second storage-layer control. It does not replace the signer's client-side envelope:
only the on-prem master identity can open `keys/` ciphertext, and that identity never enters AWS.
The bucket and KMS key both resist an accidental OpenTofu destroy.

The shared ECS task role may presign exact `GetObject`, `GetObjectVersion`, and `PutObject`
operations below those three prefixes. It cannot list the bucket or delete an object. The signer
has no IAM identity or AWS credential; it can use only the short-lived exact-object URLs returned
by the authenticated API. The KMS grant works only through S3 and only with this bucket's encryption
context. This is the narrowest AWS authority possible while the website, API, and worker remain
containers in one ECS task: ECS has one task role, not a per-container role. Splitting those
containers later would allow the website to lose this inherited authority entirely.

SSE-KMS is a bucket default, not a caller header contract. A presigned signer PUT must not require
`x-amz-server-side-encryption` or a KMS-key-id header unless the API also returns an explicit,
allowlisted signed-header map. The signer currently sends only `Content-Type` and `Content-Length`;
S3 applies the bucket's KMS key after accepting those bytes. The bucket policy rejects explicit
encryption overrides, SSE-C, server-side copies, and plaintext transport so a bearer of an unexpired
PUT URL cannot replace the storage key or move an existing object across custody prefixes.

## Secrets and host prerequisites

After the infrastructure-only apply, generate two independent high-entropy values in the local
secret source and provide the existing Android Developer Console credential. Run
`ANDROID_CUSTODY_ONLY=1 bin/put-app-secrets.sh`. This all-or-nothing mode rejects a missing value or
equal signer tokens, then writes the three values directly to the application Parameter Store path.
OpenTofu creates no parameter value, so none enters state:

- `APK_SIGNER_TOKEN` authenticates runtime poll, claim, completion, and failure calls;
- `APK_SIGNER_OPERATOR_TOKEN` authenticates human-operated catalogue-client identity and release
  queueing; and
- `ANDROID_DEVELOPER_ID_STATUS_API_KEY` authenticates the worker's Android Developer Console status
  calls.

The API container loads both and must refuse startup when they are equal. The website and worker
load neither. Install only `APK_SIGNER_TOKEN` in the signer service environment. Supply only
`APK_SIGNER_OPERATOR_TOKEN` to a bounded human operator command; do not persist it in the service
unit, shell history, CI, or the signer's runtime environment.

On the dedicated signing host, provision these outside OpenTofu and outside AWS:

- the same `APK_SIGNER_TOKEN`, mode `0600`;
- a stable `APK_SIGNER_ID`;
- an RSA PKCS#8 master identity at a durable `APK_SIGNER_MASTER_IDENTITY_PATH`;
- a durable, backed-up `APK_SIGNER_STATE_DIR` for the recovery journal;
- Android SDK Build Tools (`aapt2`, `apksigner`, and `zipalign`) and a Java `keytool`;
- an HTTPS `APK_SIGNER_API_URL`.

The host is outbound-only. Do not open an inbound port, install an AWS credential, or place the
master identity in SSM, Secrets Manager, S3, an image, or this repository. Google exposes the
Android Developer Console API, but this repository does not yet implement its OAuth consent,
refresh-token custody, package registration, or ownership-proof flow. Those operations belong on
the on-prem signer; do not invent or upload a refresh token to AWS or CI while that gap remains.

## Retention and recovery

The master identity and S3 ciphertext are both required. Either one without the other is useless.
Before provisioning the first app key:

1. place the master identity on an encrypted, offline-backed volume owned by the dedicated signer
   user with mode `0600`;
2. make two independently encrypted offline backups under separate physical custody; never upload
   either backup to AWS, GitHub, CI, a password-manager attachment, or the signer image;
3. record only the public-key fingerprint in the operations record, then restore one backup onto an
   isolated spare and prove its public fingerprint matches before returning the backup offline;
4. back up the mode-`0700` signer state directory for crash recovery, without treating it as a
   substitute for the master identity; and
5. record the restore-drill date and custodians without recording private-key bytes or bearer
   tokens.

After the first per-app and catalogue-client identities are provisioned, verify that Postgres pins
an exact `keys/` object VersionId and certificate SHA-256, and that S3 reports that exact version as
SSE-KMS under this bucket's key. A delete marker does not destroy a pinned version; recovery reads
the recorded VersionId directly. Never "restore" by copying ciphertext to a new current version or
editing the database by hand. First restore the control-plane database, then use the recorded object
version and an offline-restored master identity to verify the certificate on an isolated signer. A
documented restore drill must succeed before live customer signing.

`prevent_destroy`, `force_destroy = false`, versioning, and the non-expiring `keys/` lifecycle stop
routine code and OpenTofu from erasing upgrade identities. They do not protect against losing every
offline master backup, scheduling KMS deletion outside OpenTofu, or an account administrator
permanently deleting S3 versions. Those remain explicit custody and break-glass risks.

## Alarm rollout

`android_signing_alarms_enabled` defaults to `false`. Enabling it creates heartbeat, oldest queued
job, and terminal-failure alarms plus an encrypted SNS topic. Before changing the variable:

**Current prerequisite status:** the repository does not yet contain a durable signer last-seen
record or a scheduled oldest-queued-job metric producer. The alarm resources are therefore defined
but deliberately disabled; a successful OpenTofu validation is not evidence that those signals
exist. The application role intentionally receives no `cloudwatch:PutMetricData` permission until
the producer lands. When enabled, a conditional customer-managed KMS key authorizes only matching
CloudWatch alarms to encrypt the SNS notifications; `alias/aws/sns` cannot be amended for that
service-publisher use.

1. land a durable signer registry/last-seen record and a scheduled queue-health sampler;
2. emit `SignerHeartbeatAgeSeconds`, `OldestQueuedJobAgeSeconds`, and `FailedJobs` into the
   `SproutOS/AndroidSigner` namespace without putting CloudWatch calls on the claim/complete
   request's failure path;
3. subscribe and confirm an operations destination on `android_signing_alarm_topic_arn`;
4. start the signer and confirm fresh metrics, then enable and apply the alarms.

Missing heartbeat data is deliberately treated as a breach. Enabling the alarms before those four
steps creates noise rather than monitoring.

## Two-stage apply boundary

Keep `android_custody_delivery_enabled = false` for the first reviewed plan and apply. That plan may
create the dedicated KMS key and alias, bucket controls, lifecycle and transport policy, scoped
application policy, and a new task-definition revision carrying `ANDROID_ARTIFACT_BUCKET`. It must
not contain `APK_SIGNER_TOKEN`, `APK_SIGNER_OPERATOR_TOKEN`, or
`ANDROID_DEVELOPER_ID_STATUS_API_KEY` in any ECS task definition or execution-role parameter ARN.
With alarms disabled, it must not create the alert KMS key, SNS topic, or alarms.

After that exact plan is applied, write all three parameters using the custody-only command above.
Then run:

```bash
bin/plan-android-custody-delivery.sh android-custody-delivery.tfplan \
  -var-file=terraform.tfvars
```

The wrapper uses SSM `DescribeParameters`, which returns metadata and never secret values, to prove
that each exact name is a `SecureString`. It then passes the explicit enable variable to OpenTofu,
saves the plan, and inspects the planned ECS JSON to prove the runtime and operator tokens occur
only in the API and the Developer Console credential occurs only in the worker. It never applies.
Review and apply that exact saved plan only after #192's API rejects equal tokens and the matching
worker uses the dedicated bucket. A normal `tofu plan` keeps delivery disabled, so it cannot
silently introduce a missing SSM reference.

After applying both exact saved production plans, verify the live bucket's versioning, public-access
block, SSE-KMS key ARN, bucket-key setting, lifecycle, and deny policy; verify the KMS key rotation
state; verify only the API container receives both token names; and exercise one disposable raw PUT,
version-pinned GET, encrypted-key PUT/GET, and signed PUT/GET through the real presigned API. Delete
only the disposable raw and signed test versions with an administrator after recording the result;
never use a `keys/` path for a destructive smoke test.
