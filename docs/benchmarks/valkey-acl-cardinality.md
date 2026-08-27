# Valkey ACL cardinality

This is the reproducible measurement record required by
`~/.claude/plans/double-sorted-meteor.md` Part A6. It also closes the missing Valkey half noted in
ADR 0029. The original sandbox context and its production-parity limits are recorded in
`private_notes/sandbox-handoff.md`; this benchmark must not be represented as Daytona, ElastiCache,
or production evidence.

Run against a disposable Valkey because the harness creates and then deletes up to 100,000 global
ACL users:

```bash
pnpm exec tsx bin/measure-valkey-acl-cardinality.ts \
  --url redis://127.0.0.1:42024 \
  --confirm-disposable \
  --tiers 1000,10000,100000
```

For each tier it records creation time, `ACL LIST` latency and response size, `INFO memory`'s
`used_memory` and `used_memory_rss`, and p50/p95 authentication latency over 20 new connections.
Users carry the exact production ACL command policy. Benchmark usernames have a distinct prefix so
they can never be mistaken for tenant identities, and cleanup runs in `finally`.

## Results

Measured 2026-08-27 on local Docker Desktop (`arm64`) with
`valkey/valkey:9-alpine@sha256:de31910896150d5e754a07d57d227cfdde4e258ddd0d1aa4607f2d2f95843715`.
These are reproducible development measurements, **not ElastiCache or production evidence**.
Creation is the incremental time from the previous tier; memory is `used_memory`.

|   Users | Incremental create |  ACL LIST | ACL LIST bytes |        Memory |   Auth p50/p95 |
| ------: | -----------------: | --------: | -------------: | ------------: | -------------: |
|   1,000 |             271 ms |    200 ms |      1,520,941 |   6,504,392 B | 2.45 / 2.93 ms |
|  10,000 |           2,272 ms |  1,844 ms |     15,218,941 |  55,052,040 B | 2.28 / 3.08 ms |
| 100,000 |          31,746 ms | 19,864 ms |    152,288,941 | 540,509,792 B | 2.19 / 2.71 ms |

The operational soft warning remains 1,000 until a representative secured production-shaped
engine is measured and this record is updated. It is a warning, not a provisioning or traffic cap.
