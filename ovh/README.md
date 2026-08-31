# The OVH host

One bare-metal machine holding the stateful services that are not Postgres: tenant search, tenant
queues, and the log pipeline. Postgres is Neon's, in AWS.

```
ssh -i ~/.ssh/id_ovhcloud_ns1009531.ip-135-148-122.us ubuntu@135.148.122.203
```

The Daytona egress proxy is a standalone Rust service, not part of the AWS router. Its binary and
systemd unit live under `/opt/sproutos/daytona-proxy`; its root-only environment file is
`/etc/sproutos/daytona-proxy.env`, and its durable metering spool is
`/var/lib/sproutos-daytona-proxy`. Install a built binary with
`sudo ovh/install-daytona-proxy.sh PATH_TO_BINARY`.

## What runs here, and on which disk

The machine has two NVMe drives on separate mounts, and the split is deliberate: Kafka's own
hardware guide asks not to share its data drive with other filesystem activity, and ClickHouse
merges are the noisiest neighbour available.

| Service        | Mount   | Why                                     |
| -------------- | ------- | --------------------------------------- |
| OpenSearch     | `/`     | tenant search indexes                   |
| Valkey (queue) | `/`     | tenant workflow queues — BullMQ, Celery |
| Valkey (cache) | `/`     | tenant cache                            |
| ClickHouse     | `/data` | runtime logs, 3-day retention           |
| Kafka          | `/data` | log ingest buffer ahead of ClickHouse   |

## Memory, which is the part most easily got wrong

125 GB total.

**OpenSearch heap is 30 GB and must not go higher.** Above roughly 32 GB the JVM loses compressed
ordinary object pointers, and you then need 40–50 GB of heap to hold what fits in just under 32 GB.
The rest of the machine's RAM is not wasted: Lucene wants it as page cache, which is where the
actual speed comes from.

**No container memory limit on OpenSearch.** cgroup v2 counts page cache against a memory limit, so
capping the container caps Lucene's cache and silently undoes the paragraph above.

**Two Valkey processes, not one with two databases.** `maxmemory-policy` is per-process and
`SELECT n` gives no memory isolation. The queue instance must be `noeviction` — evicting a pending
job is losing a customer's work — and the cache instance must be `allkeys-lru`. One process cannot
be both.

## Host settings `bootstrap.sh` changes

- **Swap off.** A swapped JVM heap is pathological. Valkey would prefer swap to exist for fork
  safety, so `vm.overcommit_memory=1` is set instead, which is the thing Valkey actually needs.
- `vm.max_map_count` — already 1048576 on this host, well above OpenSearch's 262144.
- Transparent huge pages to `madvise`, which is what this kernel already defaults to.

## Running it

```sh
./bootstrap.sh              # host preparation: docker, sysctls, swap, directories
docker compose up -d        # on the host, from /opt/sproutos
./bootstrap-kafka.sh        # topics, SCRAM verifier, and producer-only ACLs
./install-clickhouse-durability.sh  # schema, initial backup, health check, systemd timers
```

Nothing here is an undocumented command: host preparation and broker provisioning live in these
scripts. If a step is missing from them, that is the bug.

ClickHouse consumes Kafka over the private Compose listener by default, so
`CLICKHOUSE_USAGE_KAFKA_SECURITY_PROTOCOL=plaintext` carries no credential. If ClickHouse moves
off-host, set it to `sasl_ssl` and set `CLICKHOUSE_USAGE_KAFKA_SASL_USERNAME` and
`CLICKHOUSE_USAGE_KAFKA_SASL_PASSWORD` in the protected host `.env`, then rerun
`bootstrap-kafka.sh`. The script creates a consumer-only SCRAM-SHA-512 identity and topic/group
ACLs. ClickHouse reads those values from `clickhouse-config/usage-kafka.xml`; they never appear in
the Kafka table DDL or ClickHouse query log.

## Financial ClickHouse backups

`usage_event_raw` is financial history, unlike the three-day runtime-log table. Every day a
systemd timer runs ClickHouse's native `BACKUP` to a private S3 bucket. The backup also includes the
non-expiring poison-message DLQ and an embedded cutoff/count/checksum manifest used by the restore
drill. The S3 lifecycle retains 35 daily backups; bucket versioning protects an accidental
overwrite or delete for another seven days.

OpenTofu creates the bucket, encryption, lifecycle, and a prefix-only IAM user restricted to this
host's public IP. It intentionally creates **no access key**: `aws_iam_access_key` would persist the
secret in tofu state. After applying `tofu/clickhouse-backup.tf`, create the one runtime key out of
band:

```sh
cd tofu
BACKUP_USER=$(tofu output -raw clickhouse_backup_iam_user)
tofu output -raw clickhouse_backup_s3_endpoint
aws iam create-access-key --user-name "$BACKUP_USER" \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text
```

Put the endpoint and the two returned values only in `/opt/sproutos/.env` (mode `0600`):

```dotenv
CLICKHOUSE_BACKUP_S3_ENDPOINT=https://BUCKET.s3.us-east-1.amazonaws.com/clickhouse/
CLICKHOUSE_BACKUP_S3_ACCESS_KEY_ID=...
CLICKHOUSE_BACKUP_S3_SECRET_ACCESS_KEY=...
# Optional generic JSON webhook; failures POST {"text":"..."} as well as failing systemd.
OPERATIONS_ALERT_WEBHOOK_URL=...
```

Copy the whole `ovh/` directory, not a hand-selected subset—the ClickHouse config and init SQL are
part of the deployment—then install the schedules:

```sh
rsync -av ovh/ ubuntu@135.148.122.203:/opt/sproutos/
ssh ubuntu@135.148.122.203 \
  'cd /opt/sproutos && chmod 600 .env && docker compose up -d && ./bootstrap-kafka.sh && ./install-clickhouse-durability.sh'
```

The installer applies the idempotent schema to existing volumes (entrypoint init scripts do not),
runs an initial remote backup, runs the health assertion, and only then enables the timers. A
failed backup leaves the service failed plus
`/var/lib/sproutos/clickhouse-backup/last-failure`. The five-minute health timer fails if that
marker exists, the last success is older than 30 hours, the Kafka table is not in stream error
mode, or even one DLQ row exists. Inspect with:

```sh
systemctl status sproutos-clickhouse-backup.service sproutos-clickhouse-metering-health.service
journalctl -u sproutos-clickhouse-backup -u sproutos-clickhouse-metering-health --since yesterday
```

### Restore drill

Run this after installation and at least quarterly:

```sh
sudo /opt/sproutos/clickhouse-restore-drill.sh
# Or name an older retained backup:
sudo /opt/sproutos/clickhouse-restore-drill.sh usage-20260826T033000Z
```

It restores only the three metering durability tables into `sproutos_restore_drill`; it never
overwrites production and does not instantiate a second Kafka consumer. It verifies the raw FINAL
row count and checksum at the embedded cutoff plus the DLQ count, then drops the drill database.
Set `KEEP_RESTORE_DRILL=1` only when investigating a failed comparison.

### Poison usage messages

`kafka_handle_error_mode='stream'` means malformed JSON no longer stops every later bill. Valid
rows go to `usage_event_raw`; malformed bytes, parse error, topic, partition, and offset go to
`usage_event_dead_letter`. The health timer immediately becomes red and stays red. Fix the producer,
republish a corrected event with its original stable identity, verify it exists in
`usage_event_raw FINAL`, and only then delete the corresponding DLQ row. Clearing the alert without
replaying the bill is explicitly not the recovery procedure.
