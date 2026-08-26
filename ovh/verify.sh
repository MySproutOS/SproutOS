#!/usr/bin/env bash
#
# Check the properties of the OVH host that are easy to get wrong and silent when wrong.
#
# Every assertion here corresponds to a specific way this host can look healthy and be
# misconfigured. Run it after `bootstrap.sh` and after any change to `docker-compose.yaml`.
set -uo pipefail

FAILED=0
check() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    printf '  ok    %-44s %s\n' "$label" "$actual"
  else
    printf '  FAIL  %-44s got %s, want %s\n' "$label" "$actual" "$expected"
    FAILED=1
  fi
}

set -a; . /opt/sproutos/.env; set +a
CH="sudo docker exec sproutos_clickhouse clickhouse-client --user $CLICKHOUSE_USER --password $CLICKHOUSE_PASSWORD -q"

echo "services"
for service in opensearch valkey-queue valkey-cache kafka clickhouse; do
  state=$(sudo docker compose -f /opt/sproutos/docker-compose.yaml ps --format '{{.Service}} {{.State}}' \
    | awk -v s="$service" '$1==s {print $2}')
  check "$service" "${state:-missing}" "running"
done

echo
echo "memory"
# Above ~32 GB the JVM drops compressed ordinary object pointers and a 40-50 GB heap is then needed
# to hold what fit in 31. Reading the flag is the only way to know it did not happen.
heap=$(curl -s --max-time 10 "localhost:9200/_nodes/jvm?filter_path=nodes.*.jvm.mem.heap_max_in_bytes" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(round(list(d["nodes"].values())[0]["jvm"]["mem"]["heap_max_in_bytes"]/2**30))')
check "opensearch heap GiB" "$heap" "30"
oops=$(curl -s --max-time 10 "localhost:9200/_nodes/jvm?filter_path=nodes.*.jvm.using_compressed_ordinary_object_pointers" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(str(list(d["nodes"].values())[0]["jvm"]["using_compressed_ordinary_object_pointers"]).lower())')
check "opensearch compressed oops" "$oops" "true"

# cgroup v2 counts page cache against a container memory limit, so a limit here would cap Lucene's
# cache and silently undo the heap sizing above. 0 means unlimited.
limit=$(sudo docker inspect sproutos_opensearch --format '{{.HostConfig.Memory}}')
check "opensearch container mem limit" "$limit" "0"

# A swapped JVM heap is pathological; the collector touches the whole heap.
swap=$(swapon --show --noheadings | wc -l | tr -d ' ')
check "swap devices" "$swap" "0"

echo
echo "valkey"
# One process cannot be both "never lose a job" and "evict the coldest key". Two policies, two
# processes — this is the assertion that catches someone merging them.
for pair in "queue:noeviction" "cache:allkeys-lru"; do
  name=${pair%%:*}; want=${pair##*:}
  got=$(sudo docker exec "sproutos_valkey_${name}" valkey-cli config get maxmemory-policy | tail -1)
  check "valkey-$name maxmemory-policy" "$got" "$want"
done

echo
echo "clickhouse"
# Matched against what ClickHouse *stores*, not against the DDL that was written: it normalises
# `INTERVAL 3 DAY` to `toIntervalDay(3)`, so grepping for the literal you typed reports a missing
# TTL on a table that has one.
ttl=$($CH "select if(position(create_table_query, 'toIntervalDay(3)') > 0, 'yes', 'no') from system.tables where database='sproutos' and name='runtime_log'" 2>/dev/null)
check "runtime_log 3-day TTL" "${ttl:-error}" "yes"
idx=$($CH "select count() from system.data_skipping_indices where database='sproutos' and table='runtime_log'" 2>/dev/null)
check "runtime_log skip index" "${idx:-error}" "1"

echo
echo "kafka"
for topic in "${KAFKA_RUNTIME_LOG_TOPIC:-runtime-logs}" "${KAFKA_USAGE_EVENT_TOPIC:-usage-events}"; do
  partitions=$(sudo docker exec sproutos_kafka /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server kafka:9092 --describe --topic "$topic" 2>/dev/null \
    | sed -n 's/.*PartitionCount: \([0-9][0-9]*\).*/\1/p' | head -1)
  check "$topic partitions" "${partitions:-missing}" "3"
done

echo
if [ "$FAILED" -eq 0 ]; then echo "all checks passed"; else echo "checks FAILED"; fi
exit "$FAILED"
