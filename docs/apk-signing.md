# The on-premises Android signer

`services/android-signer` is the outbound-only signer for direct Android distribution. It polls the
public API, downloads one raw unsigned APK, signs it with that app's own key, and returns only
verified release metadata. It never accepts an inbound connection and it has no AWS credential.

The old queue treated the upload as a ZIP and one signing identity as the identity of every app.
Neither is true now. Android uploads use `application/vnd.android.package-archive`, and every
`android_app` gets an independently generated signing key.

## Trust and storage

The machine has one RSA master identity in a durable local file. `init-master` creates it with mode
`0600` and refuses to overwrite an existing file. Back it up offline: losing it makes every stored
app key unusable, so no installed app can be upgraded.

For each app, the signer:

1. generates a 3072-bit RSA signing key in a restricted temporary directory with `keytool`;
2. creates a random per-app AES-256 data key;
3. encrypts the PKCS#12 keystore and its independent password with AES-GCM;
4. wraps the data key to the on-prem master identity with RSA-OAEP-SHA256; and
5. uploads only that authenticated envelope through a versioned, SSE-KMS presigned S3 URL.

AWS receives neither the master identity nor a plaintext app key. The signer uses a durable local
checkpoint before upload, so restarting a `provision_key` job reuses the same identity instead of
silently changing an app's certificate.

For stronger physical protection, mount `APK_SIGNER_MASTER_IDENTITY_PATH` from an offline-backed,
encrypted volume. A PKCS#11/HSM adapter is not implemented; do not describe a normal file as HSM
backed.

## Runtime configuration

| Variable                          | Meaning                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `APK_SIGNER_API_URL`              | Public control-plane origin; HTTPS required except loopback |
| `APK_SIGNER_TOKEN`                | Bearer credential; required and never accepted on argv      |
| `APK_SIGNER_OPERATOR_TOKEN`       | Separate credential for client identity/release commands    |
| `APK_SIGNER_ID`                   | Stable machine label used for queue ownership               |
| `APK_SIGNER_MASTER_IDENTITY_PATH` | Durable RSA PKCS#8 master identity                          |
| `APK_SIGNER_STATE_DIR`            | Durable mode-`0700` crash-recovery journal                  |
| `APK_SIGNER_ANDROID_SDK_ROOT`     | SDK root containing `build-tools/<version>`                 |
| `APK_SIGNER_KEYTOOL`              | Optional explicit `keytool` path                            |
| `APK_SIGNER_AAPT2`                | Optional explicit `aapt2` path                              |
| `APK_SIGNER_ZIPALIGN`             | Optional explicit `zipalign` path                           |
| `APK_SIGNER_APKSIGNER`            | Optional explicit `apksigner` path                          |
| `APK_SIGNER_POLL_SECONDS`         | Idle poll interval, default 30                              |
| `APK_SIGNER_MAX_APK_BYTES`        | Hard download ceiling, default 512 MiB                      |

Initialize once, back up the result, then run under a service manager:

```bash
cargo run -p android-signer -- init-master \
  --output /var/lib/sproutos-android-signer/master.pem

cargo run --release -p android-signer -- run \
  --master-identity /var/lib/sproutos-android-signer/master.pem \
  --state-dir /var/lib/sproutos-android-signer/jobs
```

Use a dedicated unprivileged user, `Restart=on-failure`, `UMask=0077`, filesystem protection, and a
writable allowlist containing only the state directory. Health is the process state plus its
structured poll/completion logs. There is deliberately no inbound health port on this firewall
boundary; the API should report the signer's last successful poll as fleet health.

The long-running service receives only `APK_SIGNER_TOKEN`. Keep `APK_SIGNER_OPERATOR_TOKEN` in a
separate operator-only credential file and expose it only while running `client-identity` or
`queue-client-release`. The API records a fixed audit principal belonging to that credential rather
than trusting the command's caller-supplied machine label. Production startup fails if either token
is absent or the two values are equal. A compromised fleet poll token therefore cannot enqueue a
catalogue-client APK for signing.

## Normalized job protocol

Fleet claim, completion, and failure calls carry `Authorization: Bearer $APK_SIGNER_TOKEN`.
Operator-only catalogue identity, prepare, and finalize calls use `APK_SIGNER_OPERATOR_TOKEN`.
Completion and failure requests also carry a stable `Idempotency-Key`. The signer retries callback
transport failures, timeouts, rate limits, and server errors four times with bounded exponential
backoff; the control plane durably deduplicates the callback per claim, including when its first
response disappears after commit. A `204` claim is an idle queue.

`POST /v1/apk-signing/claim` with `{ "signer_id": "signer-01" }` returns one of four discriminated
jobs: the two per-project jobs below and the two fixed-client counterparts documented later. Claims
expire after 30 minutes, longer than the combined bounded transfer and Android-tool timeouts.

`provision_key` supplies `job_id`, `android_app_id`, immutable `package_name`,
`encrypted_key_upload_url`, and `encrypted_key_object_key`. The signer PUTs an octet-stream, requires
the versioned bucket's `x-amz-version-id`, then completes with the object key/version and certificate
SHA-256. A retry reuses its checkpoint.

`sign_release` supplies the IDs, package name, version and previous version, expected certificate,
raw-APK MIME and digest, a version-pinned encrypted-key download URL, and a signed-APK upload URL.
The signed object key is immutable per job: `signed/<android_app_id>/<job_id>.apk`. Completion
includes the actual package name, version code/name, certificate, SHA-256, byte size, and signed
object key and object version. The catalogue pins that exact version, so a still-valid PUT URL
cannot replace the bytes after completion. A retry reuploads the identical durable signed
checkpoint.

The signer checks all of the following before completion:

- the HTTP response and claim both say raw APK MIME;
- the streamed body stays under the limit and matches its SHA-256;
- the APK ZIP has a manifest, no traversal/symlink/nested APK, and no JAR signing metadata;
- `apksigner` agrees the input is unsigned;
- `aapt2` reports the generated package name and exact declared, monotonic `versionCode`;
- the protected keystore certificate equals the app record;
- `zipalign` and `apksigner` succeed under bounded output and time limits; and
- the output re-parses, verifies, and has the expected signing certificate.

Temporary plaintext key material is mode `0600` inside a mode `0700` directory and is removed by
RAII on every return path. A failed job reports a bounded, scrubbed error and never replaces the
latest good release.

## SproutOS catalogue-client identity

The platform catalogue client is a separate, fixed application: `com.sproutos.store`. It is not a
customer Android project and must never be squeezed into the generated
`me.sproutos.app.p<project-id>` namespace. Its one signing identity uses the same on-prem master
identity, client-side envelope encryption, private versioned bucket, and presigned URL boundary as
customer keys. Only its certificate SHA-256 is returned to an operator.

After the 11_08 control-plane migration and signer are deployed, request or inspect the singleton
identity with:

```bash
cargo run -p android-signer -- client-identity
```

The first call idempotently creates one `provision_client_key` job. Run the normal signer service;
then repeat the command. `certificate_sha256=<64 lowercase hex characters>` is the public
fingerprint to add to Play Console. The command never reads, decrypts, or prints the PKCS#12
keystore. Do not create a temporary key with `keytool`, upload a debug certificate, or add a Play
key before this durable provisioning job succeeds. The control plane rejects a different key or
object after success; rotation requires a separate migration and installed-client upgrade design.

To publish a release, obtain the reviewed **unsigned** release APK on the signer host and run:

```bash
cargo run -p android-signer -- queue-client-release \
  --apk /secure/operator-input/sproutos-store-release-unsigned.apk
```

This locally rejects a signed APK, wrong package name, malformed archive, missing version metadata,
or oversized file before requesting storage. It uploads the raw APK through an immutable,
versioned presigned URL and durably queues `sign_client_release`. The normal poll loop downloads
that exact version, decrypts the singleton key, signs and verifies the APK, uploads an immutable
signed object, and completes the audit job. Only then does the control plane atomically add the
immutable `client_release` row consumed by `/download` and catalogue self-update. Retries reuse the
same job and object identities.

## Android Developer Console dependency

Ur LLC's existing verified Google Play Console identity is used for Play and off-Play distribution;
do not create or pay for a second developer account. Google's current Android Developer Console API
explicitly supports app distributors and automated CI/CD package-name registration. The integration
must call `ListDeveloperAccounts` after consent and persist the selected verified account rather than
inventing an account identifier.

The Google Play Android Developer API (`androidpublisher.googleapis.com`) is the publishing API; its
public REST surface is not this package-name verification flow. SproutOS currently performs no Play
publication operation, so it must not request the
`https://www.googleapis.com/auth/androidpublisher` scope. Android developer verification uses only
`https://www.googleapis.com/auth/androiddeveloperconsole`.

The official Android Developer Console API requires OAuth 2.0 Web Server authorization with scope
`https://www.googleapis.com/auth/androiddeveloperconsole`; service accounts, workload identity,
and API keys are unsupported. Its documented automated path uses one-time consent with
`access_type=offline`, a securely stored refresh token, `CreateAndroidPackage`,
`GetAndroidPackageRegistrationPolicy`, `CreateAndroidPackageKey`, and—when required—
`VerifyAndroidPackageKeyOwnership` or `JustifyAndroidPackageKeyRegistration`.

That registration client and ownership-proof APK flow are not implemented by this signer PR. The
signer therefore truthfully reports `pending_registration` after tenant key provisioning and must
not report `registered` until a separate **on-prem signer-side** command or reconciler durably
completes the documented API state machine. The Google refresh token stays on that on-prem host;
AWS may persist only non-secret registration status. This is a known implementation dependency,
not API uncertainty and not a reason to fabricate successful registration.

The merged control plane separately reconciles this certificate and package through Google's
Android Developer ID Status API, but it neither registers packages nor holds the OAuth refresh
token. Until the on-prem registration flow above is implemented, this signer has no Google
credential and never fabricates `registered`.

The registration reconciler keeps `android_app` in `pending_registration` until the exact package
and certificate return `REGISTERED`. A different certificate fails closed, successful identities
are revalidated weekly, and provider 400/401/403 or contract failures open a durable terminal
circuit instead of burning the daily quota. Signed tenant deployments remain queued and absent
from catalogues until registration and the independently verified setup commit are both durable.

`ANDROID_DEVELOPER_ID_STATUS_API_KEY` belongs only on the background worker. It is not installed on
the signer. When it is absent, no registration can advance to `registered`.

Official references: [Android Developer Console API](https://developer.android.com/developer-verification/guides/developer-console-api),
[Android Developer ID Status API](https://developer.android.com/developer-verification/guides/check-registration-status),
and [Play Console package-name registration](https://support.google.com/googleplay/android-developer/answer/16761053).
