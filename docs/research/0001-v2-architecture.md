# SproutOS v2 — research brief

Produced 2026-08-24 by a ten-agent research pass against vendor documentation and price files, then
synthesised. **Every figure carries a source URL**; anything the agents could not confirm is marked
unverified rather than smoothed over.

It exists because the v2 brief in `private_notes/TASKS.md` makes several assumptions that turn out to
be wrong or expensive, and finding that out after building would have been much worse. The
corrections in §3 are the point of the document.

# SproutOS Architecture Pivot — Decision Brief

*Basis: seven research packets (Neon pricing, AWS pricing, PG poolers, Lambda logging, ClickHouse/Kafka, OpenSearch+Valkey on OVH, F-Droid, GitHub Actions, Stripe, ALB blue/green). Dated 2026-08-24. Prices are list prices read from vendor offer files and docs within the last week.*

---

## 1. Decisions that are now settled

**Self-host Valkey. The margin is 8x, not a rounding error.**
ElastiCache Serverless for Valkey is $0.084/GB-hour = **$61.32 per GB-month** ([Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonElastiCache/current/us-east-1/index.json)). An `m7g.large` gives 8 GiB at $0.0816/hour = **$0.0102 per GiB-hour** ([EC2 offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.csv)) — 8.2x cheaper on memory before the $0.0023/M ECPU charge. For a platform whose whole job is multiplexing many small tenant queues onto shared capacity, per-tenant serverless pricing is the worst possible fit.

**Graviton everywhere, and the metering price book anchors on the m7g.large decomposition: $0.0408/vCPU-hour and $0.0102/GiB-hour.** Graviton is a flat 20% discount on Lambda duration at every tier ($0.0000133334 vs $0.0000166667/GB-s) and on provisioned concurrency ([Lambda offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json)). Decomposing the instance rate into per-vCPU and per-GiB components gives `metering-agent` a defensible cost basis matching what cgroup v2 already samples.

**One shared ALB, host-header split, weighted target groups, cutover by script.**
`host-header = api.<domain>` → Rust router at rule priority 100; default action → Next.js. Four target groups (`website-blue/green`, `router-blue/green`) permanently attached to weighted `forward` actions; the deploy tool moves weights via `ModifyRule`. Weights are 0–999, up to 5 target groups per action, quota not adjustable ([ALB limits](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-limits.html)). ALB fixed cost is $0.0225/hour ≈ $16.43/month plus $0.008/LCU-hour.

**Not CodeDeploy for the EC2 tier.** CodeDeploy's EC2/On-Premises blue/green registers replacement instances into the *same* target group and deregisters the originals ([docs](https://docs.aws.amazon.com/codedeploy/latest/userguide/deployment-steps-server.html)); canary and linear traffic-shifting configs **do not exist for EC2** — only Lambda and ECS ([deployment configs](https://docs.aws.amazon.com/codedeploy/latest/userguide/deployment-configurations.html)). You cannot express "5% to green." Scripting `ModifyRule` against `@aws-sdk/client-elastic-load-balancing-v2` is ~200–300 lines and strictly more capable.

**Lambda logs go through CloudWatch, not a Telemetry API extension.**
Setting `LoggingConfig.LogFormat=JSON` makes CloudWatch Logs carry the *same* `{time, type, record}` envelope the Telemetry API emits, including `platform.report` with `billedDurationMs`/`initDurationMs`/`maxMemoryUsedMB` ([docs](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-logformat.html)). That removes the only real argument for an extension. An extension is billed as tenant function duration, and **an extension init failure restarts the whole execution environment** ([Extensions API](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-extensions-api.html)) — a log shipper on every customer's availability path. v1: one account-level subscription filter per region → Kinesis Data Streams (on-demand, `Distribution: Random`) → Rust consumer → Kafka → ClickHouse. Latency contract is "usually less than three minutes."

**ClickHouse ingestion is the Kafka table engine.** ClickPipes is Cloud-only ([integration matrix](https://clickhouse.com/docs/integrations/kafka)); the Kafka engine is what ClickHouse recommends for self-hosted and does ~100k rows/sec/table. Kafka Connect's exactly-once costs a JVM plus a Keeper for KeeperMap state — not worth it for logs, where at-least-once duplicates are cosmetic and dedupe on CloudWatch `logEvents[].id` handles it.

**KRaft combined mode on the OVH box. There is no decision left.** ZooKeeper mode was fully removed in Kafka 4.0 (2025-03-18); 4.3.1 is current ([release notes](https://kafka.apache.org/blog/2025/03/18/apache-kafka-4.0.0-release-announcement/)). A single host forces `process.roles=broker,controller`, which Kafka's own docs call "not recommended in critical deployment environments" — accept it in the ADR, since a single-host Kafka is already a SPOF.

**Two NVMe mounts, split ClickHouse from Kafka.** Kafka's docs explicitly recommend not sharing its data drive with other filesystem activity, and measure XFS at 160ms Request Local Time vs 250ms+ for the best ext4 config ([hardware guide](https://kafka.apache.org/43/operations/hardware-and-os/)).

**OpenSearch heap ≤30 GiB, verified from the startup log; no container memory limit.** Elastic's reference: "26GB is safe on most systems and can be as large as 30GB on some" ([advanced-configuration](https://www.elastic.co/guide/en/elasticsearch/reference/current/advanced-configuration.html)). Above ~32 GB you lose compressed oops and need 40–50 GB to regain the effective memory of a heap just under 32 GB. Do **not** set a cgroup memory limit on the container: cgroup v2 counts page cache ([kernel docs](https://docs.kernel.org/admin-guide/cgroup-v2.html)), so a limit caps Lucene's `hybridfs` cache and silently undoes the whole memory plan.

**Swap off host-wide, `vm.overcommit_memory=1`, THP=never.** OpenSearch says `swapoff -a`; Valkey says keep swap sized to RAM. Take OpenSearch's side (a swapped JVM heap is pathological) and buy back Valkey's safety with explicit `maxmemory`, `maxmemory-clients` (default 0 = unbounded), and overcommit for fork.

**Two Valkey instances, not one with two databases.** `maxmemory-policy` is per-process; `SELECT n` gives no memory isolation. Queue instance = `noeviction` (the default); cache instance = `allkeys-lru`. Running one policy for both silently eats pending jobs or refuses cache writes.

**Postgres pooling: PgBouncer as a per-compute sidecar behind `pg-proxy`, copying Neon.** Neon's bundled config (`compute/etc/pgbouncer.ini`) points at localhost:5432 with `*` wildcard database and `auth_user`/`auth_dbname` passthrough — no per-tenant config entry, no RELOAD on tenant creation. PgBouncer is ISC, 109 commits/12mo, prepared-statement fixes landing 2026-08-19, and rated 5/5 on docs and stability in the only independent comparison ([pgconf.eu 2024](https://www.postgresql.eu/events/pgconfeu2024/sessions/session/5846/slides/547/comparing_poolers.pdf)). Its single-process nature is sidestepped entirely by one pooler per tenant pod.

**Do not adopt PgCat.** Zero commits in 12 months (last push 2025-02-27), latest release is a Helm chart from 2024-11-11, and **clients can authenticate with MD5 only** — `// TODO: Add SASL support.` at both auth sites ([README](https://github.com/postgresml/pgcat/blob/main/README.md)). MD5-only inbound auth disqualifies it for a multi-tenant PaaS regardless of anything else.

**Do not put a pooler at the tenant edge.** `services/pg-proxy` already terminates SCRAM, resolves the tenant, and drops privilege with `SET ROLE`. Adding a multi-tenant pooler in front means re-litigating a security boundary that is already built and tested.

**Metering schema mirrors Neon's v2 Consumption API metric names verbatim** — `compute_unit_seconds`, `root_branch_bytes_month`, `child_branch_bytes_month`, `instant_restore_bytes_month`, `snapshot_storage_bytes_month`, `public_network_transfer_bytes`, `private_network_transfer_bytes`, `extra_branches_month` ([usage-calculations](https://neon.com/docs/introduction/usage-calculations)). Store raw counters in raw units. Self-hosted Neon has no Consumption API — this is a schema to imitate, not an endpoint to call. Hard-code **744 hours** and **10^9 bytes/GB** as named constants with the doc URL in a comment.

**Billing ledger stays in SproutOS. Stripe is collection and tax documents only.** Stripe credit grants apply **only at invoice finalization**, only to subscription line items priced with a Meter, and Stripe states plainly that "customers can exceed their balance during the cycle" ([compare-metronome](https://docs.stripe.com/billing/subscriptions/usage-based/compare-metronome)). For a platform that must gate a running pg-proxy connection the moment a balance hits zero, that is the wrong primitive.

**Top-up flow: Checkout Session, `mode=payment`, `invoice_creation[enabled]=true`, `setup_future_usage=off_session`.** This gets a PDF invoice *and* PDF receipt at 0.4% **capped at $2** — materially cheaper than the uncapped 0.4% of standalone Invoicing — and saves the card with SCA done at save time, which is what later qualifies it for MIT treatment.

**GitHub Action is a JavaScript action, `runs.using: node24`, bundled to a committed `dist/index.js`.** Composite cannot read the `secrets` context and would push a multi-hundred-MB upload through curl; Docker actions are Linux-only, which would block customers on `macos-latest`/`windows-latest` ([about-custom-actions](https://docs.github.com/en/actions/sharing-automations/creating-actions/about-custom-actions)). Auth is GitHub OIDC trusted publishing — no long-lived secret.

**F-Droid: adopt the repo *format*, ship your own Kotlin/Compose client.** The format is static-file-only (perfect for S3+CloudFront) and F-Droid publishes `org.fdroid:index` and `org.fdroid:download` as KMP libraries you can consume. Your own client is the only way to get per-user authorization and control the install UX. Private APKs get CloudFront OAC + signed URLs on a separate cache behavior with **one platform key group** — key-group quotas are 5 keys/group, 10 groups/account ([CloudFront limits](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)), so per-tenant keys are structurally impossible.

---

## 2. Decisions still open

**Neon self-hosted vs Neon Agent plan.** The Agent plan is aimed precisely at platforms provisioning Postgres for end users: Launch-rate compute ($0.106/CU-hour), unlimited projects, up to $25,000 in credits, and **Neon sponsoring the free tier at no cost to the platform** ([agent-plan](https://neon.com/docs/introduction/agent-plan)). Self-hosting means funding that free tier out of pocket and reproducing `child_branch_bytes_month` (billed as min of delta or logical size) from your own pageserver — the single hardest metric to reproduce outside Neon Cloud.

**ClickHouse text index: on or off.** ClickHouse's own GitHub-dataset benchmark: the text index is 215.84 GiB compressed vs 7.04 GiB for a bloom filter, table compression drops ~9x→~6x, insert throughput drops ~50% — for 7–10x faster cold queries ([GA blog](https://clickhouse.com/blog/full-text-search-ga-release)). The deprecated bloom filters are not a fallback, so the real alternative is *no index* and brute-force scan of a 3-day partition-pruned window.

**Log partition granularity: `toDate(ts)` vs `toStartOfHour(ts)`.** Day partitions mean retention lands between 3 and 4 days; hour partitions narrow the overshoot to an hour at the cost of ~72–96 active partitions and more, smaller parts.

**Kafka engine vs hand-written Rust consumer.** The engine needs no extra process on an already-crowded box; a Rust consumer fits the repo's "Rust for the hot path" rule and buys per-tenant rate limiting at ingest and explicit backpressure control. Start with the engine; the consumer is the escape hatch.

**Valkey cluster mode for `CLUSTER SLOT-STATS`.** It is the only genuinely complete per-tenant meter in either system — `key-count`, `cpu-usec`, `network-bytes-in/out` per slot, O(slots) not O(keys). But cluster mode changes the client protocol, and **BullMQ and Celery both use cross-key Lua**; without enforced hash-tagging in `valkey-proxy`, jobs fail with CROSSSLOT. The fallback is `CLIENT LIST` `tot-net-in`/`tot-net-out`/`tot-cmds` per tenant connection (Valkey 8.0+), which is weaker on memory attribution.

**PgBouncer sidecar-per-tenant vs one Odyssey fronting many computes.** The sidecar shape stops paying when you have many small tenants and a pod-per-tenant pooler is wasteful. Odyssey is then the right answer — multi-threaded, BSD-3, 551 commits/12mo, best-in-field content-based statement dedup, and its `auth_module`/`external_auth_socket_path` hook lets you write the authenticator as a Rust daemon without forking Odyssey. Cost: thin docs (rated 1/5), some issues only in Russian, prepared statements opt-in, refcounter-based cleanup only landed in v1.5.2-rc2 (tagged 2026-08-24).

**Android developer verification: SproutOS as developer-of-record for every customer app, or each customer verifies their own.** From 2026-09-30 in BR/ID/SG/TH and globally in 2027, only apps registered by a verified developer install on certified devices ([Google support](https://support.google.com/android-developer-console/answer/16561738)). SproutOS-as-developer means accountability for all customer content; per-customer means much better isolation and much worse onboarding. **This must be resolved before writing the client.**

**Stripe fee passthrough: price component vs surcharge API.** The surcharge API is public preview only, requires pinning `Stripe-Version: 2026-03-25.preview`, is US/CA/AU/NZ only (no EU/UK), credit-cards-only in US/CA, and Australia support is being switched off 2026-10-01 ([surcharge docs](https://docs.stripe.com/payments/cards/surcharge)). Pricing the fee into the credit pack (sell "$50 of credit" for $52.50) avoids network surcharging rules and the CT/MA/ME/PR prohibitions entirely — but is less transparent to the customer.

**Card vs ACH for top-ups, and the minimum pack size.** At 2.9% + $0.30, a $10 top-up loses 5.9%; a $50 top-up loses 4.4% all-in ($1.75 processing + $0.20 invoice + $0.25 tax). ACH at 0.8% capped at $5 makes the same $50 cost ~1.7%, but settles T+4 with a $4 failure fee.

**Next.js packaging on Lambda: container image vs zip+LWA vs OpenNext.** Zip is capped at **250 MB unzipped including layers**; a standalone tree with React, the Next server and `sharp` will not reliably fit. Container gives 10 GB; OpenNext already does the asset/cache/server split you'd otherwise derive yourself.

**CloudFront: flat-rate Business plan vs pay-as-you-go.** $200/month for 50 TB + 125M requests versus roughly $4,175 PAYG for the same — but flat-rate allowances are soft, and sustained excess is answered with **degraded edge placement, not a bill**. That trades an unbounded cost risk for an unbounded latency risk. Plans are also per-distribution, so a per-tenant-distribution architecture would not compose.

---

## 3. Corrections — things a builder would get wrong

**Neon's CU is not 1 vCPU.** Neon's own docs define a CU as "approximately 4 GB of RAM ... along with associated CPU and local SSD resources" and the compute-size table has RAM/cache/max_connections columns but **no vCPU column** ([manage/computes](https://neon.com/docs/manage/computes)). The "1 CU = 1 vCPU + 4 GB" claim comes only from third-party pricing blogs and is **unverified**. Neon explicitly calls 0.25/0.5 CU "shared compute," which contradicts a dedicated-vCPU reading. Do not publish it as a contractual definition.

**The billing month is a fixed 744 hours, not the calendar month.** A 28-day February has 672 hours, so identical usage bills ~10% less if you divide by "hours in this month."

**v2 storage metrics are already divided by 744.** Dividing again under-bills storage by a factor of 744 — a plausible-looking small number, not an obvious failure. The legacy `data_storage_bytes_hour` field *is* raw byte-hours. Mixing the conventions is the classic bug.

**Neon bills in decimal GB (10^9), not GiB.** That is a 7.4% revenue difference, and Postgres, Linux tooling and cgroup v2 all report bytes that developers instinctively convert with 1024s.

**`extra_branches_month` reports ALL child branches, not billable ones.** Consuming it directly over-bills every customer. `billable = max(0, reported_branch_hours - (branches_per_project - 1) × hours_in_bucket)`.

**Egress and branch allowances apply per project before summing.** Summing org-wide then subtracting one allowance under-bills silently. It also creates a real gaming incentive: ten projects gets 5 TB of free egress instead of 500 GB.

**The "PgCat has prepared-statement memory issues" claim is mostly refuted as stated.** No public issue links PgCat memory growth to prepared statements, and the pgconf.eu 2024 comparison says the opposite about PgCat while aiming the memory-leak criticism at **Odyssey**. What is real about PgCat is worse: an unbounded per-client `HashMap<String,(Arc<Parse>,u64)>` that `prepared_statements_cache_size` does not cap (clients hold independent `Arc` strong refs, so pool LRU eviction frees nothing), and a pool cache that matches on a bare `DefaultHasher` u64 **with no query-text verification on hit**.

**The Odyssey claim is verified and understated.** `sources/pstmt.c` deduplicates by *content* — global map keyed on the full Parse descriptor, xxh64 + full `memcmp`, refcounted — so N clients running the same SQL share one server-side statement. Caveat: this was buggy until this year (issue #1345, April 2026: 32-bit murmur collision → `42P05 prepared statement "56703f72" already exists`).

**Neon's proxy is not a pooler.** It is SNI→project routing plus SCRAM/JWT auth plus WebSocket/HTTP protocol termination — the job `pg-proxy` already does. Neon's actual pooling is bundled PgBouncer. Also: the public `neondatabase/neon` repo has taken **11 commits in 12 months** post-Databricks-acquisition, last commit 2026-05-25. Do not treat it as a maintained upstream.

**Neon's bundled `pgbouncer.ini` sets `max_prepared_statements=0` while Neon's public docs claim protocol-level prepared statements work on pooled endpoints.** One of the two is wrong, and self-hosting means you inherit the config file, not the docs.

**The AWS Free Tier was restructured on 2025-07-15.** Accounts created on or after that date get **no** 12-month allowances (no 750h EC2, no 750h RDS, no 5 GB S3, no 750h ELB) — just up to $200 in credits over 6 months ([billing docs](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html)). A db.t4g.micro plus 20 GB gp3 is a real ~$14/month from day one. Lambda's 1M requests + 400,000 GB-seconds and CloudFront's 1 TB + 10M requests survive as Always Free.

**Lambda's free tier does not apply to Provisioned Concurrency.** Enabling PC on a function currently costing zero creates a bill from the first hour.

**The 100 GB/month free internet egress is aggregated across all AWS services and regions.** Granting it separately to S3, EC2 and ALB understates egress by up to 200 GB/month.

**ALB LCU billing takes the max across four dimensions, and connections — not bytes — will bind for a proxy architecture.** 3,000 active connections/minute per LCU, **halved to 1,500 with mutual TLS**. Long-lived Postgres and RESP sessions pin that dimension far above the 1 GB/hour processed-bytes dimension (0.4 GB/hour for Lambda targets).

**The ALB does not fail over out of an empty or all-unhealthy weighted target group, and it fails *open* into an all-unhealthy one.** Verbatim: "the load balancer does not automatically fail over to a target group with healthy targets" ([rule-action-types](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-action-types.html)) and "If a target group contains only unhealthy registered targets, the load balancer routes requests to all those targets, regardless of their health status." Every safety gate must be your deploy script polling `DescribeTargetHealth`.

**`HealthyThresholdCount` does not gate a newly registered target.** "The load balancer starts routing traffic to a newly registered target as soon as the registration process completes and the target passes the first initial health check, irrespective of the configured threshold." Bake by holding the weight at 0, not by tuning thresholds.

**Application-cookie stickiness silently does not work with weighted target groups.** Use `lb_cookie` or target-group stickiness.

**`tokenbf_v1` and `ngrambf_v1` are deprecated** in favour of the `text()` index, which went GA in ClickHouse 26.2 (26.3 is LTS). Text indexes use infinite granularity — an explicit `GRANULARITY` is ignored — and cannot be materialized on parts over 2^32 (~4.29B) rows, after which queries silently fall back to brute force.

**"Exactly 3 days" retention is not achievable on the efficient path.** `ttl_only_drop_parts=1` drops a part only when every row has expired; TTL only evaluates during merges with a minimum repeat delay of `merge_with_ttl_timeout` (default **14400s = 4h**); and freed bytes leave the filesystem only after `old_parts_lifetime` (default **480s**). Budget 3 days + partition granularity + merge lag, and enforce the customer-facing promise at read time with `WHERE ts >= now() - INTERVAL 3 DAY`.

**Kafka's default `log.retention.hours` is 168** — four times the intended 24h replay buffer. Set it per-topic or it quietly fills the NVMe.

**OpenSearch's own docker-compose sample comment is backwards.** It reads "Set min and max JVM heap sizes to **at least** 50% of system RAM"; Elastic's rule is **no more than** 50%. Copying it onto a 128 GB box yields a 64 GB+ heap with compressed oops lost and *less* usable memory than at 30 GB. Separately, percentage heap notation (`-XX:MaxRAMPercentage`) is silently overridden in OpenSearch — you must use `-Xms`/`-Xmx`.

**`vm.max_map_count` cannot be set from docker-compose `sysctls:`** — `vm.*` is not a namespaced sysctl. Set it on the host. OpenSearch documents ≥262144; Elastic now requires **1048576**, which is the number to use for a many-small-index multi-tenant node.

**Valkey's `used_cpu_*` metrics are useless as a utilization signal when I/O threads are on**, because Valkey busy-waits and CPU reads near 100% while idle. Use `used_active_time_main_thread` / `used_active_time_io_thread_N`, added in **Valkey 9.1** specifically for this.

**Stripe has no free invoices.** The 25/month allowance ended 2023-11-01. Receipts (including PDF) are free with Payments; anything labelled "Invoice" is a paid product.

**The $2 invoice cap applies only to post-payment invoices via Checkout and Payment Links** — not to standalone Stripe Invoicing, where Stripe's own pages state 0.4%/0.5% with no cap. Multiple third-party blogs claim a general $2 cap; that could not be corroborated on any Stripe-owned page.

**Voiding a Stripe invoice reinstates applied credit grants; issuing a credit note does not.** Any refund flow built on credit notes silently fails to return credit.

**GitHub's OIDC `sub` claim format forked on 2026-07-15.** New/renamed/transferred repos emit `repo:owner@123456/repo@456789:ref:refs/heads/main`; older ones emit `repo:owner/repo:ref:...` ([immutable subject claims](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/)). **Authorize on `repository_id` + `repository_owner_id`, never on the `sub` string.** A regex on `sub` breaks half your customers with a generic-looking auth failure.

**Audience is not an authorization boundary.** PyPI documents that "any workflow defined in a repository can request an OIDC token, with any audience, so long as it has the `id-token: write` permission" ([PyPI security model](https://docs.pypi.org/trusted-publishers/security-model/)). Accepting a token because `aud === "sproutos"` lets any GitHub repo on the planet deploy to any project.

**Node20 is being removed from runners in fall 2026** (runners defaulted to Node24 on 2026-06-16). Shipping `runs.using: node20` gives the action a hard expiry.

**Immutable releases conflict with the standard moving-`v1`-tag workflow.** Once a release is published, its tag is locked. Attach releases only to exact `v1.2.3` tags and keep `v1`/`v1.1` as plain tags — and verify this on a throwaway repo, because "tags tied to releases are locked" implying plain tags stay movable is *inference*, not documented.

**Next.js `output: 'standalone'` deliberately excludes `.next/static` and `public`.** An uploader that ships only `.next/standalone` produces a site that boots and serves unstyled HTML with 404s on every chunk — a failure that passes any "did the deploy succeed" check.

**Firehose cannot write to Kafka or MSK.** MSK is a Firehose *source*. The apparently cheaper direct-to-Firehose logging path ($0.25/GB vs $0.50/GB) reaches ClickHouse only via the generic HTTP endpoint, dropping the Kafka buffer. Firehose Direct PUT also bills in **5 KB increments** — a 400-byte log line bills as 5 KB, which can dominate the per-GB saving.

**CloudWatch Logs subscription non-retryable errors (AccessDenied, ResourceNotFound) disable the filter for up to 10 minutes and logs in that window are *skipped*, not buffered.** An IAM mistake during a deploy is silent, unrecoverable tenant log loss. There is exactly **one account-level subscription filter per account per Region** — a hard, unshareable limit.

**Switching Python Lambdas to JSON log format changes the default application log level from WARN to INFO.** Rolling `LogFormat=JSON` without pinning `ApplicationLogLevel` multiplies log volume and the bill overnight.

**Signed URLs cannot be expressed in a standard F-Droid index.** File entries are relative names resolved against the repo address, so the official F-Droid client can never receive per-request signatures. Its only private-repo mechanism is Basic Auth **embedded in the URL** (`https://user:pass@host/fdroid/repo/`) — the credential prompt was removed in the repo-UI overhaul.

**Android 14 refuses to install anything with `targetSdkVersion` below 23; Android 15 raises the floor to 24** (probable, from secondary source). And `setRequireUserAction(USER_ACTION_NOT_REQUIRED)`'s target-API bar rose every release from Android 12 through 16 — generated APKs need a scheduled targetSdk bump policy or silent updates degrade to prompting and then to failing.

---

## 4. Cost model inputs

### AWS compute

| Service | Unit | Price (us-east-1) | Source |
|---|---|---|---|
| Lambda requests | per request | $0.0000002 ($0.20/1M) | [Lambda offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json) |
| Lambda duration x86 | GB-second (first 6B) | $0.0000166667 | same |
| Lambda duration x86 | GB-second (6B–15B) | $0.0000150000 | same |
| Lambda duration x86 | GB-second (>15B) | $0.0000133334 | same |
| Lambda duration arm64 | GB-second (first 7.5B) | $0.0000133334 | same |
| Lambda duration arm64 | GB-second (7.5B–18.75B) | $0.0000120001 | same |
| Lambda duration arm64 | GB-second (>18.75B) | $0.0000106667 | same |
| Lambda provisioned concurrency x86 | GB-second | $0.0000041667 | same |
| Lambda provisioned concurrency arm64 | GB-second | $0.0000033334 | same |
| Lambda duration under PC, x86 | GB-second | $0.0000097222 | same |
| Lambda duration under PC, arm64 | GB-second | $0.0000077778 | same |
| Lambda ephemeral storage >512 MB | GB-second | $0.0000000309 | same |
| Lambda@Edge | GB-second / request | $0.0000500100 / $0.0000006 | same |
| Lambda free tier (Always Free, excl. PC) | month | 1M requests + 400,000 GB-s | [Lambda pricing](https://aws.amazon.com/lambda/pricing/) |
| EC2 t4g.small (2 vCPU, 2 GiB) | hour | $0.0168 (~$12.26/mo) | [EC2 offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.csv) |
| EC2 c7g.large (2 vCPU, 4 GiB) | hour | $0.0725 (~$52.93/mo) | same |
| EC2 m7g.large (2 vCPU, 8 GiB) | hour | $0.0816 (~$59.57/mo) | same |
| **Derived cost basis** | vCPU-hour / GiB-hour | **$0.0408 / $0.0102** | m7g.large decomposition |

### AWS networking and edge

| Service | Unit | Price | Source |
|---|---|---|---|
| ALB | ALB-hour (or partial) | $0.0225 (~$16.43/mo) | [ELB offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/us-east-1/index.json) |
| ALB | LCU-hour | $0.008 | same |
| NLB | LCU-hour | $0.006 | same |
| GWLB | LCU-hour | $0.004 | same |
| ALB mTLS trust store | unit-hour | $0.005 | same |
| Data transfer out to internet | first 100 GB/mo (all services, all regions) | $0 | [DataTransfer offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/index.json) |
| Data transfer out | GB, up to 10 TB | $0.09 | same |
| Data transfer out | GB, 10–50 TB | $0.085 | same |
| Data transfer out | GB, 50–150 TB | $0.07 | same |
| Data transfer out | GB, >150 TB | $0.05 | same |
| Inter-region transfer out | GB | $0.02 | same |
| CloudFront DTO (US/MX/CA) | GB, up to 10 TB | $0.085 | [CloudFront offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudFront/current/index.json) |
| CloudFront DTO | GB, next 40 TB | $0.080 | same |
| CloudFront DTO | GB, next 100 TB | $0.060 | same |
| CloudFront DTO | GB, next 350 TB | $0.040 | same |
| CloudFront DTO | GB, next 524 TB | $0.030 | same |
| CloudFront DTO | GB, next 4 PB | $0.025 | same |
| CloudFront DTO | GB, >5 PB | $0.020 | same |
| CloudFront requests (US) | HTTP / HTTPS | $0.00000075 / $0.0000010 | same |
| CloudFront Always Free | month | 1 TB DTO + 10M requests + 2M Functions invocations | [PAYG pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/) |
| CloudFront flat-rate Free | month | $0 (1M req, 100 GB) | [flat-rate docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html) |
| CloudFront flat-rate Pro | month | $15 (10M req, 50 TB) | same |
| CloudFront flat-rate Business | month | $200 (125M req, 50 TB) | same |
| CloudFront flat-rate Premium | month | $1,000 (500M req, 50 TB) | same |
| CloudFront Premium 75TB/750M | month | $1,450 | same |
| CloudFront Premium 125TB/1.25B | month | $2,250 | same |
| CloudFront Premium 200TB/2B | month | $3,500 | same |
| CloudFront Premium 350TB/3.5B | month | $6,000 | same |
| CloudFront Premium 600TB/6B | month | $10,000 | same |

### AWS storage, data and managed services

| Service | Unit | Price | Source |
|---|---|---|---|
| S3 Standard | GB-month, first 50 TB | $0.023 | [S3 offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json) |
| S3 Standard | GB-month, next 450 TB | $0.022 | same |
| S3 Standard | GB-month, >500 TB | $0.021 | same |
| S3 PUT/COPY/POST/LIST | request | $0.000005 ($0.005/1,000) | same |
| S3 GET/SELECT/other | request | $0.0000004 ($0.004/10,000) | same |
| ElastiCache Serverless Valkey | GB-hour | $0.084 (= $61.32/GB-mo) | [ElastiCache offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonElastiCache/current/us-east-1/index.json) |
| ElastiCache Serverless Valkey | ECPU | $0.0000000023 ($0.0023/M) | same |
| ElastiCache Serverless Redis OSS/Memcached | GB-hour / ECPU | $0.125 / $0.0000000034 | same |
| ElastiCache Serverless min billed storage | per cache | Valkey 100 MB; Redis/Memcached 1 GB | [ElastiCache pricing](https://aws.amazon.com/elasticache/pricing/) |
| ElastiCache cache.t4g.micro | hour | Valkey $0.0128; Redis/Memcached $0.016 | offer file |
| ElastiCache cache.m7g.large | hour | Valkey $0.1264; Redis/Memcached $0.158 | offer file |
| ElastiCache Valkey sync-durability (m7g.large) | hour | +$0.0228 | offer file |
| RDS PostgreSQL db.t4g.micro | hour | $0.016 single-AZ / $0.032 multi-AZ | [RDS offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.json) |
| RDS PostgreSQL db.t4g.small | hour | $0.032 single-AZ / $0.065 multi-AZ | same |
| RDS gp3/gp2 storage | GB-month | $0.115 single-AZ / $0.23 multi-AZ | same |
| RDS io1/io2 | GB-month + IOPS-month | $0.125 + $0.10 | same |
| RDS backup beyond allocated | GB-month | $0.095 | same |
| RDS gp3 provisioned IOPS above baseline | IOPS-month | $0.02 (multi-AZ 2x) | same |
| RDS gp3 provisioned throughput | MBps-month | $0.08 (multi-AZ 2x) | same |
| Kinesis Data Streams on-demand | GB ingested / GB retrieved / stream-hour | $0.08 / $0.040 / $0.040 | [Kinesis pricing](https://aws.amazon.com/kinesis/data-streams/pricing/) |
| Kinesis Data Streams provisioned | shard-hour / M PUT units (25 KB) | $0.015 / $0.014 | same |
| Firehose Direct PUT (5 KB billing increments) | GB, first 500 TB/mo | $0.029 | [Firehose pricing](https://aws.amazon.com/kinesis/data-firehose/pricing/) |
| Lambda→CloudWatch Logs ingestion | GB, first 10 TB | $0.50 | [Compute blog](https://aws.amazon.com/blogs/compute/aws-lambda-introduces-tiered-pricing-for-amazon-cloudwatch-logs-and-additional-logging-destinations/) |
| Lambda→CloudWatch Logs | GB, next 20 TB / next 20 TB / >50 TB | $0.25 / $0.10 / $0.05 | same |
| Lambda→CloudWatch Logs, Infrequent Access | GB, four tiers | $0.25 / $0.15 / $0.075 / $0.05 | same |
| Lambda→S3 or Firehose direct | GB, four tiers | $0.25 / $0.15 / $0.075 / $0.05 | same |
| CodeDeploy, EC2 | deployment | $0 | [CodeDeploy pricing (CN)](https://www.amazonaws.cn/en/codedeploy/pricing/) |

### Neon (market benchmark; SproutOS self-hosts)

| Item | Unit | Price | Source |
|---|---|---|---|
| Launch compute | CU-hour | $0.106 | [plans](https://neon.com/docs/introduction/plans) |
| Scale compute | CU-hour | $0.222 | same |
| Agent plan compute | CU-hour | $0.106 | [agent-plan](https://neon.com/docs/introduction/agent-plan) |
| Storage (all paid plans) | GB-month, measured hourly | $0.35 | plans |
| Instant restore (PITR) | GB-month | $0.20 | plans |
| Snapshot storage | GB-month | $0.09 | plans |
| Public egress, Launch/Scale | per project/month | 500 GB free, then $0.10/GB | [network-transfer](https://neon.com/docs/introduction/network-transfer) |
| Public egress, Agent plan | per project/month | 100 GB free, then $0.10/GB | agent-plan |
| Private transfer (PrivateLink, Scale only, bidirectional) | GB | $0.01 | plans |
| Extra branches | branch-month | $1.50 (~$0.002/hr, prorated hourly) | plans |
| Per-project charge | — | **none** (count limits only) | plans |
| Free tier | month | 100 CU-h/project, 0.5 GB storage/project, 100 projects, 5 GB egress | plans |
| Invoice collection floor | invoice | not collected under $0.50 | plans |

### Stripe

| Item | Unit | Price | Source |
|---|---|---|---|
| Card processing (US domestic) | transaction | 2.9% + $0.30 | [pricing](https://stripe.com/pricing) |
| International card surcharge | transaction | +1.5% | same |
| Currency conversion | transaction | +1% | same |
| Manually entered card | transaction | +0.5% | same |
| Dispute | each | $15.00 | same |
| Instant Payouts | payout | 1.5% (min $0.50) | same |
| ACH Direct Debit | transaction | 0.8%, capped $5.00 | [local payment methods](https://stripe.com/pricing/local-payment-methods) |
| ACH failed payment | each | $4.00 | same |
| SEPA Direct Debit | transaction | 0.8% + $0.30, capped $6.00; $5.00 failed | same |
| Bacs Direct Debit | transaction | 1% + $0.30, capped $6.00; $4.00 failed; $0.50/refund | same |
| Post-payment invoice (Checkout / Payment Links) | invoice | 0.4%, **capped $2.00** | [support](https://support.stripe.com/questions/pricing-for-post-payment-invoices-for-one-time-purchases-via-checkout-and-payment-links) |
| Stripe Invoicing Starter | paid invoice | 0.4%, no cap stated | [invoicing pricing](https://stripe.com/invoicing/pricing) |
| Stripe Invoicing Plus | paid invoice | 0.5%, no cap stated | same |
| Stripe Billing pay-as-you-go | billing volume | 0.7% (incl. up to 100M meter events/mo) | [billing pricing](https://stripe.com/billing/pricing) |
| Stripe Billing Starter/Scale/Pro/Enterprise | month (1-yr contract) | $620 / $1,500 / $2,950 / $5,750; overage 0.67% | same |
| Stripe Tax Basic (no-code) | transaction | 0.5% where registered | [Tax pricing](https://support.stripe.com/questions/understanding-stripe-tax-pay-as-you-go-pricing) |
| Stripe Tax Basic (API) | Transaction API call | $0.50 (incl. 10 calc calls); +$0.05/extra calc | same |
| Stripe Tax Complete Starter/Growth/Scale/Enterprise | month | $90 / $430 / $1,000 / $1,500 | [Tax pricing](https://stripe.com/tax/pricing) |
| Receipts (incl. PDF) | each | $0 | [receipts](https://docs.stripe.com/receipts) |
| Surcharge caps (preview API) | transaction | US 3% credit only; CA 2.4% credit only; AU 4%; NZ 4% | [surcharge](https://docs.stripe.com/payments/cards/surcharge) |

**Product tax codes:** `txcd_10102000` PaaS business use, `txcd_10102001` PaaS personal, `txcd_10103001` SaaS business, `txcd_10101000` IaaS business, `txcd_10701100` website hosting ([tax codes](https://docs.stripe.com/tax/tax-codes)).

### Worked example — $50 card top-up
$1.75 processing + $0.20 post-payment invoice (capped path) + $0.25 Stripe Tax = **~$2.20 (4.4%)**. Same over ACH: $0.40 + $0.20 + $0.25 = **~$0.85 (1.7%)**. At $10 the card path costs 5.9%. Set the smallest pack at $25–50.

### Hard quotas that are cost/architecture inputs

| Limit | Value | Adjustable? | Source |
|---|---|---|---|
| Lambda zip package | 50 MB zipped (API), **250 MB unzipped incl. layers** | No | [Lambda limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) |
| Lambda container image | 10 GB uncompressed | No | same |
| Lambda-managed code storage | 300 GB/region | **No** | same |
| Lambda sync response / streamed | 6 MB / 200 MB | No | same |
| Lambda layers per function | 5 | No | same |
| Target groups per ALB | 100 | **No** | [ALB limits](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-limits.html) |
| Target groups per forward action | 5 | **No** | same |
| Load balancers per target group | 1 | **No** | same |
| Rules per ALB | 100 (excl. default) | Yes | same |
| SNI certificates per ALB | 25 (excl. default) | Yes | [https-listener-certificates](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/https-listener-certificates.html) |
| CloudFront keys per key group / groups per account | 5 / 10 | Yes (ticket) | [CloudFront limits](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html) |
| Account-level CW Logs subscription filters | 1 per account per Region | No | [Subscriptions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Subscriptions.html) |
| Subscription filters per log group | 5 | No | same |
| S3 single PUT / multipart parts | 5 GB / 10,000 (5 MiB–5 GiB each) | No | [S3 qfacts](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) |
| Stripe unused credit grants per customer | 100 | No | [billing credits](https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits) |
| Lambda extensions per function | 10 | No | [Extensions API](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-extensions-api.html) |
| Lambda shutdown budget (external extension) | 2,000 ms then SIGKILL | No | same |
| Lambda init budget (on-demand) | 10 s total | No | [runtime environment](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html) |

---

## 5. Risks and unknowns

### Unverified — flagged as such in the research, not smoothed over

**Neon's vCPU-per-CU.** Not stated anywhere in Neon's docs. Publishing "1 CU = 1 vCPU + 4 GB" repeats a third-party blog as a contractual promise. **Cost of being wrong:** a pricing-page claim you cannot defend, contradicted by Neon's own "shared compute" language for 0.25/0.5 CU.

**Whether Neon's control plane is open source.** The storage engine is Apache-2.0; no official page confirms the control plane's licence. **Cost of being wrong:** the entire self-hosting plan. Check the `neondatabase` GitHub org LICENSE files before committing.

**ALB weight-change convergence time.** AWS documents no figure. One community report describes ~10 seconds of 504s on an abrupt 0→100 flip under load. **Cost of being wrong:** a "zero-downtime deploy" SLO built on an undocumented number. Shift gradually and measure in your own account.

**Whether `ignore_changes` on `forward[0].target_group` reliably prevents weight drift in OpenTofu.** Widely used, not documented by the AWS provider. **Cost of being wrong:** a routine `tofu apply` silently reverts a cutover or, worse, a rollback.

**Whether a plain `v1` tag (not attached to a Release) remains force-pushable with immutable releases enabled.** Inference, not documented. **Cost of being wrong:** discovering after publishing v1 that you cannot ship a patch to `@v1` without migrating every consumer.

**GitHub OIDC token TTL (~5 min) and the `{"count":1,"value":"..."}` response shape.** Both come from toolkit issues and vendor guides, not GitHub reference docs. **Cost of being wrong:** small — measure `exp - iat` in a scratch workflow.

**Whether OpenSearch search stats groups have bounded cardinality or an eviction policy.** No statement either way. With one group per tenant, the stats map grows per shard for the life of the index. **Cost of being wrong:** the per-tenant search meter becomes a memory leak on the search node. Load-test at expected tenant count before shipping it as the billing path.

**Whether `CLUSTER SLOT-STATS` works in a single-node cluster owning all 16384 slots**, and the measured overhead of `cluster-slot-stats-enabled yes`. Implied but not confirmed; no overhead figure published.

**Whether Valkey `INFO commandstats` `usec` is CPU time or wall-clock, and how blocked commands (BLPOP/BRPOP — exactly what BullMQ and Celery use) are accounted.** Docs say "CPU time"; a linked issue suggests blocking-command accounting is not straightforward. **Cost of being wrong:** queue billing is systematically wrong in an unknown direction.

**Whether Lambda's native S3/Firehose logging destination bypasses CloudWatch Logs ingestion charges, or whether the intermediate `Delivery` log group is also billed.** This changes the $0.25 vs $0.50 comparison entirely. Verify with a small test workload before it drives a decision.

**Whether standalone Stripe Invoicing has any per-invoice cap.** Stripe's own pages say no cap; third-party blogs claim $2. Treat the blogs as wrong until Stripe support says otherwise. **Cost of being wrong:** a revenue model that assumes a $2 ceiling on an uncapped 0.4%.

**Metronome's pricing.** Not published anywhere. Sales-negotiated. **Cost of being wrong:** the escape hatch from Stripe Billing Meters has unknown cost and no Connect, no Workflows, no Adaptive Pricing, no Dashboard, "limited" Checkout.

**Whether the Stripe surcharge preview API supports Invoices or Subscriptions at all.** Absent from the interoperability list rather than explicitly excluded.

**Android developer verification mechanics** — whether registration binds package name *and* signing certificate, and whether a platform can register on customers' behalf. Not stated on any Google page found. Whether the Android Developer Console API (global Aug 2026) can automate it is also unverified. **Cost of being wrong: existential for the app-store feature.** If it cannot be automated, package registration becomes a manual step in every customer's first deploy.

**Whether AWS KMS asymmetric keys can back `apksigner` directly.** CloudHSM's PKCS#11 path is verified; a KMS path exists only as third-party `aws-kms-pkcs11`. Treat CloudHSM as the verified route.

**Whether the official F-Droid client sends Basic Auth preemptively or only after a 401.** Determines whether the CloudFront Function must issue `WWW-Authenticate` and whether credentials reach APK download requests.

**The formal JSON Schema for index-v2.** Reverse-engineered from a live repo plus `fdroidserver` source; field optionality unverified.

**ALB Always Free hours under the post-July-2025 model, and whether ElastiCache Serverless enforces a minimum ECPU charge.** Both unresolved; both small.

**Third-party pooler latency figures.** Supavisor's reported +80–160% vs PgBouncer/PgCat comes from vendor blogs whose methodology could not be retrieved. No measured RSS-vs-statement-count curves exist for *any* pooler under prepared-statement load — all memory sizing here reasons from data structures, not measurement.

### Highest-consequence risks

**Losing an app signing key is unrecoverable.** `PackageInstaller` requires identical signing certificates for an update, and `apksigner rotate` requires the **old** key to build the lineage. Recovery is uninstall/reinstall for every affected user. A per-customer key multiplies this by the customer count.

**The ALB will happily canary traffic into a broken green fleet.** Both safety gaps (no failover out of an all-unhealthy weighted group; fails open into one) mean the load balancer provides zero protection. This is entirely on the deploy script.

**Prices moved recently and will move again.** Neon's rates dropped sharply and monthly minimums were removed reportedly in December 2025 post-Databricks. AWS revises offer files without notice. **Record the Price List API version string alongside any price book committed to the repo**, so divergence is detectable rather than silent.

**One OVH box is one failure domain for every tenant's search and every tenant's queue.** With swap off and no replica, AOF `everysec` is the only thing between a power loss and losing every tenant's in-flight jobs. Combined-mode KRaft means the controller quorum is one node with no majority to survive a metadata-directory loss.

**`ttl_only_drop_parts=1` means one long-tailed row pins an entire partition.** Clock skew on a tenant container, or a client sending seconds where milliseconds are expected, pins that day's partition indefinitely. Clamp `ts` at ingest in the materialized view. Also: `system.dead_letter_queue` is never cleaned up automatically — give it its own TTL or it becomes the leak.

**Every prepared-statement bug in the pooler research was found by a driver test suite (Npgsql, JDBC, sqlx, Liquibase, Ecto), never by pgbench.** Whatever pooler ships, the acceptance test is running those suites through it. A TPS benchmark cannot fail on a name-collision bug.

**Stripe prohibits billing credits functioning as stored value, gift cards, or third-party payment.** A SproutOS credit balance that could be transferred or cashed out would breach Stripe's terms and potentially money-transmitter rules. Keep credits non-refundable-to-cash and non-transferable, or take legal advice.

**Off-session SCA declines are a silent revenue stop in the EEA/UK.** Low-value exemptions expire after 5 transactions or €100 cumulative since the last SCA — precisely the pattern a small recurring auto-top-up produces. Build the "bring the customer back on-session" path first, not last, and suspend compute on your side rather than waiting for a Stripe dunning cycle.
