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
| `APK_SIGNER_OPERATOR_ID`          | API-configured audit principal for those operator commands  |
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
signed object, and completes the audit job. The control plane records that immutable signed job but
does not add the `client_release` consumed by `/download` and catalogue self-update until its
independent status check returns `REGISTERED` for the exact `com.sproutos.store` certificate.
Retries reuse the same job and object identities.

## Google Play Console registration

Ur LLC's existing Google Play Console organization is the authority for Play and off-Play package
identity; do not create or pay for a second developer account. The signer deliberately has no
Google credential and makes no Google API call. It provisions each private signing identity,
returns the public SHA-256 certificate fingerprint, and signs APKs. An operator uses that exact
package name and fingerprint with Play Console's manual **Add key** flow.

For the fixed catalogue client, run `client-identity` after its provisioning job completes and add
the reported `com.sproutos.store` fingerprint. For a customer app, use the package name and
certificate fingerprint reported by the Android app status API. A fingerprint is public identity
material, not a private signing key; the PKCS#12 envelope and master identity never leave signer
custody.

Any future Google Play track or publication automation through the Google Play Android Developer
API belongs in the control plane, not on the signing host. That publishing API does not automate
this verification registration. Registration remains a manual Play Console operation unless a
separately reviewed provider contract is adopted. Do not restore OAuth client secrets, refresh
tokens, account discovery, or package-key registration to `android-signer`.

A new package normally needs only its public fingerprint. If Play instead requests an ownership APK
containing `assets/adi-registration.properties` for an existing package or additional key, stop.
The current signer has no operator command that can create that proof without weakening custody.
Use a future, explicitly reviewed custody-safe operator workflow; never export or regenerate the
managed key, never substitute a debug key, and never hand-edit and upload an unverified APK.

The control plane independently reconciles the exact certificate and package through Google's
Android Developer ID Status API. It stores only provider state, timestamps, and bounded errors.
Neither a signer callback nor successful APK signing can publish a tenant or catalogue-client
release: publication remains gated until that independent status API returns `REGISTERED`.

The registration reconciler keeps `android_app` in `pending_registration` until the exact package
and certificate return `REGISTERED`. A different certificate fails closed, successful identities
are revalidated weekly, and provider 400/401/403 or contract failures open a durable terminal
circuit instead of burning the daily quota. Signed tenant deployments remain queued and absent
from catalogues until registration and the independently verified setup commit are both durable.

`ANDROID_DEVELOPER_ID_STATUS_API_KEY` belongs only on the background worker. It is not installed on
the signer. When it is absent, no registration can advance to `registered`.

### Callback and checkpoint cutover

The callback contract is not rolling-compatible with a running old signer: old provision callbacks
send `developer_console_state`, old sign callbacks send `developer_console_account`, and old failure
callbacks may send the removed registration field. Their idempotency hashes cover those exact old
JSON bodies, so a new API cannot merely clean the fields and accept the hash.

Pause all APK submissions, fully drain every old provision, sign, and failure callback, and then
stop the old signer. Only after the queue and old signer checkpoints prove no old callback remains
may operators deploy the expand migration plus new API/worker, deploy the new signer, and resume
submissions. The expand migration deliberately retains nullable deprecated account columns for old
API/worker binary compatibility. A later contract migration may drop them only after deployment
inventory proves every old task is gone.

Do not delete the signer state directory during cutover. Existing durable key and signed-APK
checkpoints remain readable: the new signer ignores the obsolete account member, rebinds every
immutable claim field, and rereads the signed APK digest before reuse. Never regenerate a key or
discard a verified-good checkpoint merely to simplify the cutover.

Official references: [Android Developer ID Status API](https://developer.android.com/developer-verification/guides/check-registration-status),
and [Play Console package-name registration](https://support.google.com/googleplay/android-developer/answer/16761053).
