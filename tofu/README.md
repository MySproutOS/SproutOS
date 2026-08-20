# `tofu/` — the AWS foundation

What this is: the network, the cluster, the control-plane database and its backups, the keys, and
the registry. Phase 9 of the plan.

## What "verified" means here, precisely

**Nothing in this directory has ever been applied, planned, or run against an AWS account.**

`tofu validate` and `tflint` both pass, and it is worth being exact about what that does and does not
establish, because the gap is wider than it looks:

| Checked | Not checked |
| --- | --- |
| HCL parses | Whether an instance type exists |
| Every resource and argument exists in the provider schema | Whether an engine version is real |
| The reference graph resolves — no unknown resource, no cycle | Whether IAM policies grant what is needed |
| Types match, required arguments are present | Whether any of it converges |
| Core lint: unused declarations, undocumented variables | Quotas, capacity, service availability per region |

I confirmed the right-hand column empirically rather than assuming it: with `m8g.metal-nonsense` as
an instance type and `not-a-real-engine` as the RDS engine, both `tofu validate` and `tflint` — with
the AWS ruleset installed — reported no issue. The AWS ruleset's deep value rules do not fire for
these resource types.

So: treat this as a reviewed design expressed in HCL, not as working infrastructure. The first
`tofu plan` against a real account will find things. That is expected, and it is where the actual
verification starts.

## Layout

| File | |
| --- | --- |
| `main.tf` | Providers, default tags, the account-identity guard |
| `network.tf` | Dual-stack VPC, three AZs, NAT per AZ, S3 gateway endpoint |
| `eks.tf` | Cluster, platform and tenant node groups, IRSA |
| `database.tf` | Aurora Serverless v2, PITR, AWS Backup |
| `kms.tf` | One key per purpose |
| `registry.tf` | ECR per image, artifact bucket |
| `s3.tf`, `cloudfront.tf`, `oidc.tf` | SPA assets and CI's deploy role, from the original scaffold |

## Decisions worth knowing before changing something

**IPv6 is not decoration.** A platform whose thesis is density hits IPv4 exhaustion inside the
cluster CIDR as a real ceiling. It also keeps egress off the NAT gateway, which is billed per
gigabyte.

**One NAT per AZ.** A shared NAT is cheaper until the AZ holding it degrades, at which point the
other two lose egress — the exact failure a three-AZ deployment exists to avoid.

**Database subnets have no route to any gateway.** Not "private with egress" — none. That survives
somebody loosening a security group.

**IRSA, not EKS Pod Identity.** Pod Identity's agent serves credentials on link-local
`169.254.170.23`, which a Kata pod's in-guest network namespace cannot reach, and tenant isolation
blocks link-local egress anyway. Projected service-account tokens work because they are a file.

**Tenant metal is fixed-size.** Metal takes 10–20 minutes to boot, which is unusable as a
just-in-time scaling unit. Karpenter manages the ordinary pools; this is planned capacity.

**35-day backup retention, plus AWS Backup to a separate vault.** The ledger is append-only and the
audit log refuses `DELETE`, so the realistic disaster is not a dropped table but a migration that
was wrong three weeks ago — which a seven-day window does not survive.

**`aws_account_id` has no default.** It used to default to the upstream template author's account.
A variable whose job is to assert "we are in the right account" must not default to somebody else's:
a wrong value that is present is worse than one that is absent, because the guard passes.

## Not here yet

The deploy layer is a foundation, not a finished estate. Absent, and each is real work:

- **Route53, ACM, the ALB controller** — nothing is reachable from a browser yet.
- **Karpenter**, and the cluster autoscaler configuration the platform pool assumes.
- **`kata-deploy`, the runtime classes, devmapper thin pools** — the tenant nodes are labelled for
  it and nothing installs it. Phase 11.
- **Knative**, and the build pipeline that fills the registry. Phase 10.
- **The Neon OSS control plane** — pageserver, safekeepers, storage broker, `compute_ctl`. Phase 8,
  and the largest single piece missing.
- **The metering agent DaemonSet**, the Rust binary for which exists and is tested.
- **Secrets Manager entries and External Secrets**, so the cluster can read what `kms.tf` protects.
- **State backend.** `main.tf` has no `backend` block, so state is local. S3 with native locking is
  the intended target and is a prerequisite for anyone else running this.
