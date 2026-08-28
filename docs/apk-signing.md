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

| Variable | Meaning |
| --- | --- |
| `APK_SIGNER_API_URL` | Public control-plane origin; HTTPS required except loopback |
| `APK_SIGNER_TOKEN` | Bearer credential; required and never accepted on argv |
| `APK_SIGNER_ID` | Stable machine label used for queue ownership |
| `APK_SIGNER_MASTER_IDENTITY_PATH` | Durable RSA PKCS#8 master identity |
| `APK_SIGNER_STATE_DIR` | Durable mode-`0700` crash-recovery journal |
| `APK_SIGNER_ANDROID_SDK_ROOT` | SDK root containing `build-tools/<version>` |
| `APK_SIGNER_KEYTOOL` | Optional explicit `keytool` path |
| `APK_SIGNER_AAPT2` | Optional explicit `aapt2` path |
| `APK_SIGNER_ZIPALIGN` | Optional explicit `zipalign` path |
| `APK_SIGNER_APKSIGNER` | Optional explicit `apksigner` path |
| `APK_SIGNER_POLL_SECONDS` | Idle poll interval, default 30 |
| `APK_SIGNER_MAX_APK_BYTES` | Hard download ceiling, default 512 MiB |

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

## Normalized job protocol

All calls carry `Authorization: Bearer $APK_SIGNER_TOKEN`. Completion and failure requests also
carry a stable `Idempotency-Key`. The signer retries callback transport failures, timeouts, rate
limits, and server errors four times with bounded exponential backoff; the control plane durably
deduplicates the callback per claim, including when its first response disappears after commit. A
`204` claim is an idle queue.

`POST /v1/apk-signing/claim` with `{ "signer_id": "signer-01" }` returns one of two discriminated
jobs.

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

## Android Developer Console dependency

The official Android Developer Console API requires OAuth 2.0 Web Server authorization with scope
`https://www.googleapis.com/auth/androiddeveloperconsole`; service accounts, workload identity,
and API keys are unsupported. The signer intentionally reports `pending_registration` after key
provisioning today. It must not report `registered` until the control plane and signer implement the
official `CreateAndroidPackage`, registration-policy, key creation, ownership-proof, and state
transitions and a human has granted the refresh token. This is the remaining external contract, not
a reason to fabricate a successful registration.

The merged control plane separately reconciles this certificate and package through Google's
Android Developer ID Status API. Registration is completed through the verified Play Console
operator flow; this signer has no Google credential and never fabricates `registered`.
