# Deploying this, and what it costs

Nothing here has been applied. `tofu validate` and `tflint` pass, which says the configuration is
well-formed — not that it works. **`tofu plan` against a real account is the first thing that will
find what is wrong**, and it is free: a plan reads, it does not create.

This document exists so that decision is one command rather than an evening of working out what
`apply` would do to the bill.

## What it costs to leave running

Idle — nothing deployed to it, no traffic, `us-east-1` on-demand prices:

| | Monthly |
| --- | --- |
| NAT gateway × 1 | $33 |
| Aurora Serverless v2, floor of 0.5 ACU | $44 |
| Application Load Balancer | $16 |
| EC2 `t4g.small` × 2 (one colour, two instances) | $25 |
| ElastiCache `cache.t4g.micro` | $12 |
| Route 53 hosted zone | $0.50 |
| **Total, serving nothing** | **≈ $130** |

Two numbers dominate, and both are adjustable:

- **NAT gateways.** `nat_gateway_count` defaults to **1** ($33). Production wants 3 ($99) so an
  availability-zone failure does not take egress out for the other two — but that is $66 a month of
  redundancy for a platform with no users. Raise it before there is traffic worth protecting.
- **Aurora's floor.** `database_min_acu` is 0.5, which is Aurora Serverless v2's minimum that still
  accepts a connection. Scale-to-zero exists and is not used here on purpose: resuming from zero
  takes seconds, and the thing waiting is the API serving somebody's dashboard.

What is *not* in the table, because it is usage-priced and zero when nothing runs: Lambda, S3,
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

Read it. Expect roughly 90 resources on a first run. The things worth checking before you apply:

- **`aws_acm_certificate_validation.tenant`** — this one *waits*, for up to 45 minutes, on DNS that
  `dns.tf` writes. If the zone is not the one the domain is delegated to, this is where it hangs
  rather than where it fails.
- **`aws_route53_record.alb_ipv4["sproutos.me"]`** — an alias at the apex. If the zone already has
  an A record there, the plan will replace it.
- **NAT gateways and Aurora** — the two lines in the table above. Confirm the counts are what you
  intend before they start billing.

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

## Undoing it

`tofu destroy` removes everything except what has deletion protection: the Aurora cluster
(`deletion_protection`) and the load balancer. Both are deliberate — they are the two resources
whose accidental removal is unrecoverable and expensive respectively. Turn the variable off first if
you mean it.
