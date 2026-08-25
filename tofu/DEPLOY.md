# Deploying this, and what it costs

Nothing here has been applied. `tofu validate` and `tflint` pass, which says the configuration is
well-formed — not that it works. **`tofu plan` against a real account is the first thing that will
find what is wrong**, and it is free: a plan reads, it does not create.

This document exists so that decision is one command rather than an evening of working out what
`apply` would do to the bill.

## What it costs to leave running

Idle — nothing deployed to it, no traffic, `us-east-1` on-demand prices:

|                                                  | Monthly   | Free tier (first 12 months)        |
| ------------------------------------------------ | --------- | ---------------------------------- |
| Application Load Balancer                        | $16       | 750 hours included                 |
| NAT — `fck-nat` on `t4g.nano`                    | $3        | 750 hours of `t4g.micro`, not nano |
| RDS `db.t4g.micro`, 20 GB                        | $12       | included                           |
| ElastiCache `cache.t4g.micro`                    | $12       | included                           |
| EC2 `t4g.micro` × 0 (scaled to zero)             | $0        | 750 hours included                 |
| NAT Elastic IP                                   | $3.60     | —                                  |
| ALB public IPv4 × 2 (AWS's own, one per AZ)      | $7.20     | —                                  |
| Route 53 hosted zone                             | $0.50     | —                                  |
| **Serving nothing, account past its first year** | **≈ $43** |                                    |
| **Serving nothing, free tier still active**      | **≈ $20** |                                    |

Everything is the smallest instance that exists for its service. What changed to get here, and what
each gave up:

- **`fck-nat` instead of a NAT gateway** — $3 instead of $33, and no per-gigabyte processing charge.
  It is one instance in one availability zone: a single point of failure for _egress_, replaced in
  a couple of minutes, with the instance's throughput as a real ceiling. `use_nat_instance = false`
  switches back. See `nat.tf`.
- **RDS instead of Aurora** — Aurora Serverless v2 holds a 0.5-ACU floor per instance, about $44 a
  month before a query. A `db.t4g.micro` is free for a year and around $12 after. There is no
  failover target; `database_multi_az = true` adds one and doubles the instance cost.
- **One database instance, not two.** The second was a failover reader holding its own floor.

What is _not_ in the table, because it is usage-priced and zero when nothing runs: Lambda, S3,
CloudFront, data transfer, and every tenant service on the OVH box.

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
   `platform_cache_endpoint`), `LISTENER_ARN`, `WEBSITE_RULE_ARN` and `AWS_ACCOUNT_ID` as repository
   variables for the Deploy workflow.
2. **Secrets Manager.** The instances read non-secret configuration from `/etc/sproutos/env` and
   expect the rest at start. Nothing creates those entries yet — see the README's "Not here yet".
3. **Run the Deploy workflow.** It builds the website and router, uploads a release tarball, writes
   the pointer, fills the idle colour, and waits for health. The cutover is a separate job behind a
   protected environment.

Until (3), the Auto Scaling groups will start instances that boot, find no release pointer, fail
their bootstrap and be replaced. That is a loop, and it bills. **Either run the deploy promptly or
set `service_desired_count = 0` for the first apply.**

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
