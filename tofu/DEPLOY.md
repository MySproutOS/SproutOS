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

|                                      | While the free tier lasts | After it ends   |
| ------------------------------------ | ------------------------- | --------------- |
| Application Load Balancer            | $0 (730 h ≤ 750 free)     | $16.20          |
| RDS `db.t4g.micro` + 20 GB gp3       | $0                        | $14.70          |
| ElastiCache `cache.t4g.micro`        | $0                        | $12.41          |
| EC2 — 2× `t4g.micro` + 1× `t4g.nano` | ~$9                       | $15.50          |
| **Public IPv4 × 3**                  | **$10.95**                | **$10.95**      |
| Route 53 hosted zone                 | $0.50                     | $0.50           |
| S3 / CloudFront / KMS / CloudWatch   | ~$1                       | ~$1             |
| Secrets Manager (RDS master password) | $0.40                    | $0.40           |
| **Total**                            | **≈ $21/month**           | **≈ $70/month** |

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
   `platform_cache_endpoint`), `LISTENER_ARN`, `WEBSITE_RULE_ARN` and `AWS_ACCOUNT_ID` as repository
   variables for the Deploy workflow.
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
