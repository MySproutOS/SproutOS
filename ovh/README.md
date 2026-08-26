# The OVH host

One bare-metal machine holding the stateful services that are not Postgres: tenant search, tenant
queues, and the log pipeline. Postgres is Neon's, in AWS.

```
ssh -i ~/.ssh/id_ovhcloud_ns1009531.ip-135-148-122.us ubuntu@135.148.122.203
```

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
```

Nothing here is an undocumented command: host preparation and broker provisioning live in these
scripts. If a step is missing from them, that is the bug.
