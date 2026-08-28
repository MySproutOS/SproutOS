# The CLI approval gate was shared with automatic deploys

**Found:** 2026-08-28, while running the first real CLI release acceptance.

## What looked true

The promotion workflow named the `production` environment, its OIDC role trusted only that
environment subject, and the deployment guide required reviewers on the environment. Read together,
those three files described a manually approved production pointer change.

## What was actually true

The same `production` environment is used by automatic main deployments. It intentionally had no
protection rules, because adding required reviewers there would turn every ordinary merge deployment
into a manual release. The promotion workflow therefore received an environment-scoped OIDC token
without the approval the guide claimed.

The IAM boundary was internally consistent but enforced the wrong external fact: an environment name
is not an approval gate. GitHub's protection rules are state outside this repository, and sharing the
name made the required state incompatible with the automatic deployment contract.

## What stops it recurring

CLI promotion now uses the dedicated `cli-release-production` environment. The narrow promotion role
trusts only that environment, in both repository-name and exact repository-ID subject forms. The
existing deploy role also trusts those two dedicated subjects because the promotion deliberately
reuses its migration-first ECS rollout, while retaining its existing main and shared-production
subjects for ordinary deployments.

The promotion regression test binds the workflow and both roles to the dedicated name and rejects a
promotion-role fallback to `production`. The deployment runbook makes the remaining external step
explicit: create `cli-release-production` with required reviewers before applying the role trust or
dispatching promotion. This repository change does not itself create that GitHub environment, apply
OpenTofu, or prove a protected production promotion.
