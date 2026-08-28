# Deploying this, and what it costs

Nothing here has been applied. `tofu validate` and `tflint` pass, which says the configuration is
well-formed — not that it works. **`tofu plan` against a real account is the first thing that will
find what is wrong**, and it is free: a plan reads, it does not create.

This document exists so that decision is one command rather than an evening of working out what
`apply` would do to the bill.

## What it costs to leave running

Measured against this account on 2026-08-25, not estimated. Month-to-date actual spend was **$0.535**
— the Route 53 hosted zone plus a few cents of S3 — because the free tier covers the rest. The table
below is what a _full_ month looks like with everything running.

**There are no credits on this account.** Cost Explorer's record-type breakdown shows only `Usage`
and `Tax`, and `get-account-plan-state` returns not-found — this is a legacy free tier account, so
the subsidy is twelve months of allowances rather than a pot of dollars that runs out.

|                                       | While the free tier lasts | After it ends   |
| ------------------------------------- | ------------------------- | --------------- |
| Application Load Balancer             | $0 (730 h ≤ 750 free)     | $16.20          |
| RDS `db.t4g.micro` + 20 GB gp3        | $0                        | $13.98          |
| ElastiCache `cache.t4g.micro`         | $0                        | $11.68          |
| EC2 — 2× `t4g.micro` + 1× `t4g.nano`  | ~$9                       | $15.50          |
| **Public IPv4 × 3**                   | **$10.95**                | **$10.95**      |
| Route 53 hosted zone                  | $0.50                     | $0.50           |
| S3 / CloudFront / KMS / CloudWatch    | ~$1                       | ~$1             |
| Secrets Manager (RDS master password) | $0.40                     | $0.40           |
| **Total**                             | **≈ $21/month**           | **≈ $70/month** |

An earlier version of this table said $20 and $43. The $43 was wrong in two ways: it assumed the
website Auto Scaling group sat at zero, and it priced only the NAT's Elastic IP while the load
balancer quietly holds two more addresses.

### The two lines worth understanding

**The free tier's 750 hours is per service and in aggregate, not per instance.** One instance running
continuously is about 730 hours, so the allowance is effectively _one_ instance — and this estate
runs three. That is the entire EC2 line. It is also the argument for `ecs.tf`: consolidating the
website, the API and the worker onto one instance takes the count from three to two.

**Public IPv4 is the largest line, and it is already at its floor.** Since 1 February 2024 AWS bills
every public IPv4 address at $0.005/hour — Elastic or auto-assigned, attached or idle, with no free
tier. Three addresses is not a choice:

- **two belong to the load balancer**, one per availability zone, and AWS refuses to create an ALB
  spanning fewer than two. They are the addresses `sproutos.me` resolves to. They are also _service
  owned_: `release-address` on them answers `AuthFailure`, so the only way to hold fewer is to span
  fewer subnets, which `aws_lb.main` already does.
- **one belongs to the NAT instance**, and is the address every private instance appears as when it
  reaches out. Nothing connects inbound to it.

Getting below three means removing the load balancer or removing IPv4 egress — fronting tenants with
CloudFront, or moving egress to the (free) egress-only gateway the VPC already has. Both are projects
rather than settings.

What is _not_ in the table, because it is usage-priced and near zero when nothing runs: Lambda, data
transfer, and every tenant service on the OVH box.

## Before the first plan

1. **Credentials.** `AWS_PROFILE` or the usual environment variables, for an account you are willing
   to see charged.
2. **The domain.** `sproutos.me` must already be delegated to a Route 53 hosted zone in that
   account. `dns.tf` adopts it by data source rather than creating one — creating a second zone
   would give different name servers, the delegation would still point at the first, and nothing
   would resolve.
3. **`terraform.tfvars`**, at minimum:

   ```hcl
   aws_account_id       = "…"
   aws_region           = "us-east-1"
   control_plane_domain = "sproutos.me"
   github_repo          = "MySproutOS/SproutOS"
   ```

4. **State.** `main.tf` has no `backend` block, so state is a local file. That is fine for one
   person and wrong for two. S3 with native locking is the intended target and is a prerequisite
   before anybody else runs this — a second person applying against their own local state will
   create a second copy of everything.

## The plan

```bash
cd tofu
tofu init
tofu plan -out=plan.tfplan
```

Read it. Expect roughly 127 resources on a first run. The things worth checking before you apply:

- **`aws_acm_certificate_validation.tenant`** — this one _waits_, for up to 45 minutes, on DNS that
  `dns.tf` writes. If the zone is not the one the domain is delegated to, this is where it hangs
  rather than where it fails.
- **`aws_route53_record.alb_ipv4["sproutos.me"]`** — an alias at the apex. If the zone already has
  an A record there, the plan will replace it.
- **The NAT instance and the database** — the two lines above worth checking. Confirm
  `use_nat_instance` and `database_instance_class` are what you intend before they start billing.

## Applying, and what follows

`tofu apply plan.tfplan` creates the estate. It does **not** make anything serve traffic — that
takes three more things, in this order:

1. **`tofu output`** → set `LAMBDA_EXECUTION_ROLE_ARN`, `VALKEY_URL` (from
   `platform_cache_endpoint`), `LISTENER_ARN`, `WEBSITE_RULE_ARN`, `PG_LISTENER_ARN`,
   `VALKEY_LISTENER_ARN`, `FORWARD_PROXY_LISTENER_ARN` and `AWS_ACCOUNT_ID` as repository variables
   for the Deploy workflow.
2. **Application secrets.** Run `bin/put-app-secrets.sh`, which reads an allowlist of keys out of
   your local `.env` and writes one `SecureString` parameter each under `/sproutos/application`.
   Instances read that path at boot and write it into `/etc/sproutos/env`.

   It is a person's job rather than CI's or OpenTofu's, and `app-secrets.tf` creates no parameter at
   all, so **no value ever enters `terraform.tfstate`**. Skipping this step does not fail a boot: the
   site comes up, serves its landing page, and answers 500 on the first request that needs a
   credential — which is exactly how the missing `GITHUB_OAUTH_CLIENT_ID` was found.

   Parameter Store rather than Secrets Manager because standard parameters are free and a secret is
   $0.40 a month, and nothing here uses managed rotation. The one secret still in Secrets Manager is
   the database's master password, which `manage_master_user_password` puts there and RDS rotates.

3. **Run the Deploy workflow.** It builds the website and router, uploads a release tarball, writes
   the pointer, fills the idle colour, and waits for health. The cutover is a separate job behind a
   protected environment.

Until (3), the Auto Scaling groups will start instances that boot, find no release pointer, fail
their bootstrap and be replaced. That is a loop, and it bills. **Either run the deploy promptly or
set `service_desired_count = 0` for the first apply.**

### Moving the website to ECS

The ECS service is a replacement for the website Auto Scaling groups, not a third copy. Leave the
`ECS_WEB_ENABLED` repository variable absent while applying the ECS task definition, execution-role
secret policy, deploy-role ECS permissions and deployment circuit breaker. Confirm legacy website
traffic is entirely on blue and that green has no legacy instance before enabling the switch.

Set these repository variables:

- `ECS_WEB_ENABLED=true` — the ownership switch;
- `ECS_WEB_DESIRED_COUNT=1` — optional, and one by default.

The next push to `main` that includes `website` then performs this order behind the production
environment gate:

1. build and publish `sproutos-web:<12-character Git SHA>`;
2. derive a one-container migration task from the current API container's environment, secrets and
   roles;
3. run Postgres migrations, seeds and ClickHouse schema from that immutable image;
4. only after a zero exit, register/update the three-container service revision and wait for ECS and
   both ALB target groups to report healthy;
5. pin the website and API rules to green and scale the drained legacy blue group to zero.

With the gate enabled, legacy fill, SSM migration and website cutover are removed from the workflow;
router blue/green is unchanged. A migration failure never updates the service. A failed service
rollout is automatically restored by the ECS deployment circuit breaker.

The service ignores `task_definition` changes in OpenTofu because application deploys own image
revisions. When an apply registers an infrastructure-only container contract change, hand that
exact revision to the migration-first deploy instead of updating the service directly:

```bash
corrected_task_arn="$(tofu -chdir=tofu state show -no-color aws_ecs_task_definition.web \
  | sed -n 's/^    arn *= *"\([^"]*\)"/\1/p')"
test -n "$corrected_task_arn"

aws ecs describe-task-definition --task-definition "$corrected_task_arn" \
  --query 'taskDefinition.containerDefinitions[?name==`api`].environment[?name==`CLICKHOUSE_DATABASE`].value' \
  --output text

ECS_BASE_TASK_DEFINITION="$corrected_task_arn" \
  IMAGE="ghcr.io/mysproutos/sproutos-web:<12-character Git SHA>" \
  NAME_PREFIX=sproutos \
  bin/deploy-ecs-web.sh --cutover
```

The inspection prints only the non-secret database name and must report `sproutos`. The deploy
requires an exact active ARN in the service's task family, derives both new definitions from it,
runs migrations first, and changes the service only after a zero exit.

For an application rollback, dispatch `website` with `cutover` checked and `ecs_image_tag` set to a
previous 12-character image SHA. Database migrations remain forward-only, so choose an application
revision compatible with the current schema. To return the whole website to legacy EC2, set
`ECS_WEB_ENABLED=false`, then dispatch `website` with `cutover`: the legacy workflow fills blue,
migrates from that release, moves both rules, and leaves the ECS green target idle for diagnosis.

### Enabling object storage for the first time

Object storage has a deliberate two-apply interlock. The first apply and deploy leave
`storage_proxy_enabled = false`, which creates the bucket, rule and target groups without enrolling
port 9000 in Auto Scaling health. This prevents an older router release from being replaced forever
because it cannot answer a health check for a binary it does not contain.

After a router release containing `storage-proxy` is serving, add this to the real, persistent
`terraform.tfvars` — do not pass it only as a one-off command-line variable — and apply again:

```hcl
storage_proxy_enabled = true
```

Then run `bin/enable-storage-proxy.sh`. It refuses unless both router colours are enrolled in their
storage target groups and the live colour is healthy, and only then points the staged listener rule
at that colour. Restore the Deploy workflow's `STORAGE_RULE_ARN` variable after the script succeeds,
then run one more deployment so both colours and the website/API receive the enabled configuration.

Leaving the value out of `terraform.tfvars` after cutover is unsafe: its rollout default is false,
so a later ordinary apply would detach both storage target groups while the listener rule could
remain pointed at one of them.

### Enabling the Rust tenant edge and custom domains

The tenant edge also has a two-phase interlock. Its rollout defaults keep the existing NLB TLS
listener and generated tenant DNS unchanged while OpenTofu creates the certificate bucket and the
empty Secrets Manager container. Do not put an ACME private key in a variable or state file.

This network/parser hardening is not by itself authorization to cut over. Before step 6 or any
production custom-domain activation, separate reviewed changes must prove all of these launch gates:

- certificate rows persist ACME issuer/directory provenance and changing staging to production
  forces a new order rather than activating or renewing staging material;
- renewal scheduling follows ACME Renewal Information when offered, with a bounded fallback;
- deletion and supersession clean up every versioned certificate/key object after route withdrawal;
- Route 53 mutation is absent from the public router instance role and exists only on the narrowly
  scoped certificate/deployment worker role;
- static CloudFront log reconciliation and delayed-delivery credit safeguards are deployed and
  verified independently of this dynamic edge.

1. Apply with `acme_worker_enabled`, `tenant_edge_preview_enabled`, and `tenant_edge_enabled` false,
   then seed the account key once with `bin/bootstrap-acme-account-key.sh`. The script refuses to
   overwrite an existing secret version. The worker stays at desired count zero during this apply:
   the old web task reserves 768 MiB and must retain the second host for its replacement.
2. Deploy the edge-capable release normally and prove the live web task uses the new 640 MiB task
   definition. Only then set `acme_worker_enabled = true`, save/review another plan, and apply it.
   The 256 MiB isolated worker must binpack beside web on one 916 MiB registered host; refuse the
   rollout if it instead pins the spare host. Rebuild the exact production Linux/arm64 image from
   the final deployment commit and measure both startup and a staging issuance/deployment job before
   enabling it; refuse the rollout if either approaches the 256 MiB hard limit. A macOS startup
   measurement is only a regression signal because native plugin isolation exits before the worker
   reaches its poll loop. While the edge flags remain false the worker may issue and store a Let's
   Encrypt staging certificate, but `PLATFORM_EDGE_ROLLOUT_ENABLED=0` prevents it from refreshing
   either router Auto Scaling group.
3. Set `tenant_edge_preview_enabled = true` and set `tenant_edge_preview_colour` to the colour that
   contains the new release. Apply a reviewed plan. This creates a separate dual-stack, EIP-backed
   edge NLB. Its listeners use public 80/443 so HTTP-01 and ordinary TLS clients exercise the real
   protocol, while `preview-ingress.<tenant-domain>` points only at this parallel balancer. This does
   not replace the live Postgres/Valkey NLB or move generated production DNS.
4. Wait for the platform certificate row to become active after every live serving router in the
   Valkey membership set acknowledges the exact version. Smoke the generated wildcard, tenant apex, exact egress
   hostname, HTTP challenge/redirect behavior, unknown SNI, Host/SNI mismatch, and the existing
   Postgres and Valkey listeners through the unchanged data-plane NLB. Exercise preview over both
   IPv4 and IPv6 through the preview ingress name and confirm Lambda receives the viewer address
   from Proxy Protocol v2.
5. While `tenant_edge_enabled` remains false, set `custom_domain_issuance_enabled = true` only after
   a test hostname points at `preview-ingress.<tenant-domain>`. Exercise the complete asynchronous
   ownership and HTTP-01 flow against Let's Encrypt staging. This flag is deliberately independent
   of generated-traffic cutover; do not move the wildcard merely to test issuance. Turn the flag
   back off as soon as the controlled staging claim is created so other organizations cannot begin
   claims during the preview.
6. Change `acme_directory_url` from Let's Encrypt staging to production and repeat issuance and the
   preview checks. Never reuse a staging certificate for the public cutover. The certificate row
   must prove production-directory provenance before it is eligible for activation.
7. Save and review a plan with `tenant_edge_enabled = true`. The preview NLB and its EIPs must remain
   in place, as must its existing public TCP 80/443 listeners: the plan moves generated A/AAAA plus
   ingress/egress DNS to them without a destroy/create listener gap. Refuse a plan which replaces
   `aws_lb.tenant`, `aws_lb.tenant_edge[0]`, or either `aws_lb_listener.tenant_*[0]`; the existing
   data-plane NLB continues serving Postgres, Valkey, and the legacy egress rollback listener
   throughout the web-edge cutover.
8. Apply that exact plan, update repository variables from `tofu output` (including
   `TENANT_HTTP_LISTENER_ARN` and `TENANT_HTTPS_TARGET_GROUP_SHORT=edge`), deploy both colours, and
   run the production browser and protocol smoke suite. Set `custom_domain_issuance_enabled = true`
   only after production-directory provenance and the remaining certificate lifecycle gates pass.

`acme_worker_enabled` is the explicit capacity/IAM rollout gate for the isolated worker.
`tenant_edge_enabled` controls generated traffic and the egress DNS cutover;
`custom_domain_issuance_enabled` controls API claim/check operations. Keep both decisions explicit
in persistent tfvars. Reverting the edge flag in a later apply would attempt to move generated and
egress traffic back to the legacy listeners; reverting only issuance stops new/check-now API work
without withdrawing routes or destroying certificate material.

To abandon preview, leave `tenant_edge_preview_enabled = true`, keep
`tenant_edge_enabled = false`, and apply once so edge deletion protection is off; only then set the
preview flag false and review the destroy plan. To roll back after cutover, use the same two applies
after DNS and protocol smoke prove the legacy paths healthy. The parallel edge cannot be removed
while any active custom hostname still points at either ingress alias: withdraw/migrate every route
and certificate first. Never turn the global `deletion_protection` variable off merely to remove
the preview NLB.

### Static-site metering

Static projects deliberately remain Browser -> CloudFront -> S3, so their cache hits never pass
through Rust. CloudFront standard logging v2 writes every available request record to the dedicated
encrypted log bucket, and the background worker imports those records into the canonical metering
pipeline with durable cursors and idempotent event IDs. Delivery can be delayed, so this is billing
durability rather than a live usage display.

If seconds-level visibility becomes a product requirement, the future path is 100% CloudFront
real-time logs through Kinesis and a checkpointed consumer. That paid path is intentionally not
enabled for launch.

## Two AWS constraints worth knowing

**An ALB needs at least two subnets, in two availability zones.** That is not a choice this
configuration makes — AWS rejects a load balancer with one. So the VPC keeps three public subnets
across three zones even though only one of them holds anything that costs money. Subnets are free;
what is in them is not.

**An ALB cannot have an Elastic IP** — only a Network Load Balancer supports one. An ALB is reached
by its DNS name, and `dns.tf` points the apex and the wildcard at it with alias records, which is
also why there is no address to allowlist here.

It does still _hold_ public IPv4 addresses: AWS allocates one per subnet the load balancer spans,
owned by the service. They appear in `describe-addresses` and cannot be disassociated or released —
AWS answers `AuthFailure` — so the only way to hold fewer is to span fewer subnets, which is why
`aws_lb.main` takes `slice(..., 0, 2)` rather than all three. Since 1 February 2024 each one is
billed at $0.005/hour like any other public IPv4.

The one Elastic IP this configuration allocates belongs to the NAT instance. It is the platform's
_egress_ address and the one OVH sees, and it is not a cost the estate could avoid by letting the
subnet auto-assign an address: auto-assigned and Elastic are billed identically, and auto-assign
only works on an instance's primary interface, which is not where `nat.tf` needs it.

## Undoing it

`tofu destroy` removes everything except what has deletion protection: the database
(`deletion_protection`) and the load balancer. Both are deliberate — they are the two resources
whose accidental removal is unrecoverable and expensive respectively. Turn the variable off first if
you mean it.
