# Android signing infrastructure

This is the custody and operations boundary for the Android pipeline described in
`private_notes/app_store_upload.md`. The application schema, API, and signer protocol live with
their implementations; this document covers what must exist around them.

## Integration order

This change is deliberately based on current `main` after PRs #189 and #190, without PR #192's
application code. PR #192 intentionally refuses production API startup until two distinct signer
credentials are present, so deploying #192 before credential delivery would stop the API. The safe
order is therefore infrastructure source first, credential delivery second, and #192 last. Merging
this source does not run OpenTofu; every production infrastructure mutation still requires a
separately saved, reviewed, explicit plan and apply.

The infrastructure and signer-credential delivery are deliberately separate applies. The default first
apply creates the custody bucket, KMS key, lifecycle, and IAM without placing any new Android SSM
reference in the ECS task definition. This keeps an unrelated application or CLI rollout deployable
while the parameters are absent. Only the explicit, metadata-preflighted second plan may inject the
two signer credentials into the current pre-#192 API image. A focused current-image test proves it
continues to authorize only `APK_SIGNER_TOKEN` while tolerating the unused, distinct operator name.
Once that live task is healthy, #192 may deploy its fail-closed startup contract. PR #151 is
superseded by this rebuild and must never be stacked or merged afterward.

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

The ordinary ECS control-plane task role receives a dedicated custody policy that may presign exact
`GetObject`, `GetObjectVersion`, and `PutObject`
operations below those three prefixes. It cannot list the bucket or delete an object. The signer
has no IAM identity or AWS credential; it can use only the short-lived exact-object URLs returned
by the authenticated API. The KMS grant works only through S3 and only with this bucket's encryption
context. This is the narrowest AWS authority possible while the website, API, and worker remain
containers in one ECS task: ECS has one task role, not a per-container role. Splitting those
containers later would allow the website to lose this inherited authority entirely.

The shared application policy remains attached to the legacy EC2 host, Rust router, ordinary ECS
task, and ACME task, so it deliberately contains no Android S3 or KMS custody grant. Only the
ordinary control-plane task receives that dedicated policy; legacy, router, and ACME principals do
not. The website still inherits the grant because website, API, and worker share one ECS task role.

The legacy application policy also grants its boot script broad reads below
`/sproutos/application`. Signer credentials therefore live under the separate
`/sproutos/android-custody` path, and the Google worker credential lives under
`/sproutos/android-worker`. Neither the legacy host, router, nor ACME role can read those paths.
The ordinary web task and isolated ACME task also have distinct ECS execution roles. The former may
resolve only exact secrets rendered into its task definition; the latter's exact allowlist excludes
both signer tokens and the independently gated Google credential. An explicit deny on the ordinary
task role blocks `GetParameter`, `GetParameters`, and `GetParametersByPath` across both parameter
paths. This makes API-only injection an actual boundary: sibling website and worker containers
cannot use their shared task credentials to retrieve the operator token themselves.

SSE-KMS is a bucket default, not a caller header contract. A presigned signer PUT must not require
`x-amz-server-side-encryption` or a KMS-key-id header unless the API also returns an explicit,
allowlisted signed-header map. The signer currently sends only `Content-Type` and `Content-Length`;
S3 applies the bucket's KMS key after accepting those bytes. The bucket policy rejects explicit
encryption overrides, SSE-C, server-side copies, and plaintext transport so a bearer of an unexpired
PUT URL cannot replace the storage key or move an existing object across custody prefixes.

## Secrets and host prerequisites

After the infrastructure-only apply, generate two independent high-entropy values in the local
secret source and run `ANDROID_CUSTODY_ONLY=1 bin/put-app-secrets.sh`. This all-or-nothing mode
rejects a missing value or equal signer tokens, then writes the two values directly to the isolated
`/sproutos/android-custody` Parameter Store path.
OpenTofu creates no parameter value, so none enters state:

- `APK_SIGNER_TOKEN` authenticates runtime poll, claim, completion, and failure calls;
- `APK_SIGNER_OPERATOR_TOKEN` authenticates human-operated catalogue-client identity and release
  queueing.

The API container loads both and must refuse startup when they are equal. The website and worker
load neither. Install only `APK_SIGNER_TOKEN` in the signer service environment. Supply only
`APK_SIGNER_OPERATOR_TOKEN` to a bounded human operator command; do not persist it in the service
unit, shell history, CI, or the signer's runtime environment.

`ANDROID_DEVELOPER_ID_STATUS_API_KEY` is independent. Upload only it from the out-of-state
secret source with `ANDROID_WORKER_ONLY=1 bin/put-app-secrets.sh`; the strict mode refuses a missing
value and does not refresh unrelated application or custody parameters. It is stored under
`/sproutos/android-worker` only when that Google integration is ready, and reaches only the worker when
`android_developer_registration_delivery_enabled=true` is explicitly planned. Its default is
`false`; neither its absence nor its rollout can block delivery of the two credentials #192 needs.

On the dedicated signing host, provision these outside OpenTofu and outside AWS:

- the same `APK_SIGNER_TOKEN`, mode `0600`;
- a stable `APK_SIGNER_ID`;
- an RSA PKCS#8 master identity at a durable `APK_SIGNER_MASTER_IDENTITY_PATH`;
- a durable, backed-up `APK_SIGNER_STATE_DIR` for the recovery journal;
- Android SDK Build Tools (`aapt2`, `apksigner`, and `zipalign`) and a Java `keytool`;
- an HTTPS `APK_SIGNER_API_URL`.

The host is outbound-only. Do not open an inbound port, install an AWS or Google credential, or
place the master identity in SSM, Secrets Manager, S3, an image, or this repository. After key
provisioning, an operator copies only the public package name and certificate fingerprint from the
signer/control-plane status into Play Console's manual Add key flow. Package registration does not
run on the signing host.

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

Every authenticated claim poll upserts the signer's durable `android_signer_instance.last_seen_at`.
The platform worker samples that record and both normalized signing queues once per minute, then
publishes `SignerHeartbeatAgeSeconds`, `OldestQueuedJobAgeSeconds`, and the number of newly terminal
`FailedJobs` to `SproutOS/AndroidSigner`. CloudWatch is not called from the claim or completion
request path. The task role can call `PutMetricData` only for that namespace.

The producer ships enabled in the reviewed worker task contract, while the alarm resources remain
disabled until the operational destination and live signer are ready. When alarms are enabled, a
conditional customer-managed KMS key authorizes only matching CloudWatch alarms to encrypt the SNS
notifications; `alias/aws/sns` cannot be amended for that service-publisher use.

1. deploy the migration, API heartbeat writer, worker sampler, task-role policy, and worker rollout
   gate;
2. start the signer and confirm a fresh heartbeat plus queue/failure metrics in CloudWatch;
3. subscribe and confirm an operations destination on `android_signing_alarm_topic_arn`;
4. enable and apply the alarms, then prove their OK state and a controlled test notification.

Missing heartbeat data is deliberately treated as a breach. Enabling the alarms before those four
steps creates noise rather than monitoring.

## Two-stage apply boundary

Keep both `android_custody_delivery_enabled = false` and
`android_developer_registration_delivery_enabled = false` for the first reviewed plan and apply.
That plan may
create the dedicated KMS key and alias, bucket controls, lifecycle and transport policy, dedicated
control-plane custody policy, and a new task-definition revision carrying `ANDROID_ARTIFACT_BUCKET`. It must
not contain `APK_SIGNER_TOKEN`, `APK_SIGNER_OPERATOR_TOKEN`, or
`ANDROID_DEVELOPER_ID_STATUS_API_KEY` in any ECS task definition or execution-role parameter ARN.
With alarms disabled, it must not create the alert KMS key, SNS topic, or alarms.

After that exact plan is applied, write the two signer parameters using the custody-only command above.
Then run:

```bash
bin/plan-android-custody-delivery.sh android-custody-delivery.tfplan \
  -var-file=terraform.tfvars
```

The wrapper uses SSM `DescribeParameters`, which returns metadata and never secret values, to prove
that each exact signer name is a `SecureString`. It forces Google credential delivery off, passes
the explicit signer enable variable to OpenTofu, saves the plan, and inspects both the versioned
release task contract and the planned execution-role policy. Application task definitions are
release artifacts rather than OpenTofu resources, so the saved plan is expected to change IAM but
not register an ECS task revision. Each token must occur once in only the API; the execution role must
contain only their two exact `/sproutos/android-custody` ARNs; and the Google credential must occur
nowhere. An ARN with a suffix such as `_extra` is not accepted. The wrapper never applies.

Before applying the reviewed stage-two plan, capture the exact immutable image already serving the
healthy pre-#192 API. Do not substitute `latest`, a branch tag, or a locally remembered SHA:

```bash
NAME_PREFIX=sproutos
CLUSTER=$NAME_PREFIX
SERVICE=$NAME_PREFIX-web
CURRENT_TASK_DEFINITION=$(aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].taskDefinition' --output text)
CURRENT_IMAGE=$(aws ecs describe-task-definition \
  --task-definition "$CURRENT_TASK_DEFINITION" \
  --query 'taskDefinition.containerDefinitions[?name==`api`].image | [0]' --output text)
[[ "$CURRENT_IMAGE" =~ :[0-9a-f]{12}$ ]]
aws ecs describe-task-definition --task-definition "$CURRENT_TASK_DEFINITION" --output json |
  jq -e --arg image "$CURRENT_IMAGE" \
    '[.taskDefinition.containerDefinitions[] | select(.name == "website" or .name == "api" or .name == "worker") | .image] | length == 3 and all(. == $image)'
```

Apply only the reviewed saved plan. It grants the execution role access to the two exact parameter
ARNs but intentionally does **not** register or launch an application task. The stage-two handoff
is therefore mandatory and must use the exact pre-#192 image captured above; it derives the service
revision from the reviewed release contract. OpenTofu's ECS service has
`ignore_changes = [task_definition]`, so applying the saved IAM plan cannot update the live service:

```bash
tofu -chdir=tofu apply android-custody-delivery.tfplan
HANDOFF_DIR=$(mktemp -d)
trap 'rm -rf "$HANDOFF_DIR"' EXIT
jq --arg image "$CURRENT_IMAGE" '.containerDefinitions |= map(.image = $image)' \
  deploy/ecs/web-task-definition.json >"$HANDOFF_DIR/service.json"
jq --arg image "$CURRENT_IMAGE" '.containerDefinitions |= map(.image = $image)' \
  deploy/ecs/web-migrate-task-definition.json >"$HANDOFF_DIR/migrate.json"
IMAGE="$CURRENT_IMAGE" NAME_PREFIX=sproutos \
  SERVICE_TASK_DEFINITION_FILE="$HANDOFF_DIR/service.json" \
  MIGRATION_TASK_DEFINITION_FILE="$HANDOFF_DIR/migrate.json" \
  bin/deploy-ecs-web.sh
```

The handoff registers new service and migration revisions from the versioned release contracts,
runs the migration, waits for the two-replica web service to stabilize, and does not cut traffic
between target-group colours. It does not touch the independent ACME service. After it succeeds,
inspect the live service revision—not
only the OpenTofu output—and require all of the following before merging #192:

- all website, API, and worker containers still use `CURRENT_IMAGE`;
- only the API secret list contains the two exact custody-path signer ARNs;
- website and ordinary worker contain neither signer name;
- the ACME task contains neither signer name nor `ANDROID_DEVELOPER_ID_STATUS_API_KEY`, and uses its
  dedicated execution role;
- both service replicas and load-balancer targets are healthy.

Finally, prove the current image's runtime boundary without claiming a queued job. Send a
well-formed `/v1/apk-signing/fail` body with no `Idempotency-Key`: the operator token must return
`401`, while the runtime token must pass authentication and return `400` before any database write.
Keep shell tracing disabled and feed the authorization header to curl over stdin so neither token
appears in the process list:

```bash
set +x
probe_signer_auth() {
  local token=$1
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl --silent --output /dev/null --write-out '%{http_code}' --config - \
      --header 'Content-Type: application/json' \
      --request POST 'https://api.sproutos.me/v1/apk-signing/fail' \
      --data '{"job_id":"00000000-0000-7000-8000-000000000000","signer_id":"custody-preflight","claim_token":"0000000000000000000000000000000000000000000000000000000000000000","error":"preflight"}'
}
[[ "$(probe_signer_auth "$APK_SIGNER_OPERATOR_TOKEN")" == 401 ]]
[[ "$(probe_signer_auth "$APK_SIGNER_TOKEN")" == 400 ]]
```

Only after recording that live proof should #192 merge and deploy its missing/equal-token startup
failure. A normal `tofu plan` keeps both delivery switches disabled, so it cannot silently introduce
a missing SSM reference.

The independent Google credential may be staged later. Upload only it with
`ANDROID_WORKER_ONLY=1 bin/put-app-secrets.sh`, then use a metadata-only SSM check to prove its exact
`/sproutos/android-worker` name is a `SecureString`. Save the narrow execution-role plan with both
`android_custody_delivery_enabled=true` and
`android_developer_registration_delivery_enabled=true`: the first switch must remain enabled or a
new plan would remove the already-live signer-token permissions. Verify the plan retains the two
exact custody ARNs and adds exactly one worker-key ARN with no path wildcard, then apply that exact
saved plan.

Only after the parameter and execution-role permission are live may the versioned
`deploy/ecs/web-task-definition.json` contract include the worker key. It must occur exactly once in
the ordinary `worker`, never in `website`, `api`, or the separate ACME task. Persist that contract
before calling the rollout complete; a one-off registered task revision would be silently replaced
by the next normal deployment. Do not combine this later worker-key rollout with the signer-token
prerequisite for #192.

After applying both exact saved production plans, verify the live bucket's versioning, public-access
block, SSE-KMS key ARN, bucket-key setting, lifecycle, and deny policy; verify the KMS key rotation
state; verify only the API container receives both token names; and exercise one disposable raw PUT,
version-pinned GET, encrypted-key PUT/GET, and signed PUT/GET through the real presigned API. Delete
only the disposable raw and signed test versions with an administrator after recording the result;
never use a `keys/` path for a destructive smoke test.
