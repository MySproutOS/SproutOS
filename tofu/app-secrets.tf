/**
 * Where the application's own secrets live, and why nothing here creates one.
 *
 * The instances get `DATABASE_URL`, the Valkey address and their ports from `user-data.sh.tftpl`.
 * Everything else an application needs to work — the GitHub OAuth credentials, the webhook secrets,
 * the Stripe keys — was never provisioned anywhere, which is why pressing "Login with GitHub" in
 * production answered 500 with `Missing required environment variable: GITHUB_OAUTH_CLIENT_ID`.
 *
 * ## Parameter Store, not Secrets Manager
 *
 * This was one Secrets Manager secret holding a JSON object. Secrets Manager bills **$0.40 per
 * secret per month**; SSM Parameter Store standard parameters are **free** up to 10,000, and a
 * `SecureString` is KMS-encrypted exactly the same way. What Secrets Manager sells on top is
 * managed rotation, cross-region replication and resource policies, none of which this uses. On a
 * platform whose entire argument is the size of the bill, paying $4.80 a year for a feature set we
 * do not touch is the wrong default.
 *
 * (The database's master password stays in Secrets Manager: `manage_master_user_password` puts it
 * there and RDS owns the rotation. That one is not ours to move.)
 *
 * ## One parameter per key, not one JSON blob
 *
 * A standard parameter caps at 4 KB. `GITHUB_APP_PRIVATE_KEY` is a PEM at roughly 1.7 KB on its
 * own, so a single JSON object holding it plus eighteen other keys is close enough to the ceiling
 * to fail on the day somebody adds a twentieth. One parameter per key also means adding a secret
 * rewrites one parameter rather than the whole set, and IAM scopes by path.
 *
 * ## Nothing is created here
 *
 * There is deliberately no `aws_ssm_parameter` resource. **A secret written through OpenTofu is a
 * secret in `terraform.tfstate`** — on whatever laptop last ran a plan, and in whatever bucket the
 * state is kept in. `bin/put-app-secrets.sh` writes them with `put-parameter --overwrite`, run by a
 * person, and OpenTofu never sees a value. What OpenTofu owns is the *path* and the permission to
 * read it, which is the part that belongs in code.
 *
 * The consequence to know: an instance that boots before the script has ever run finds an empty
 * path and starts anyway, then answers 500 on the first request needing a credential. That is the
 * same failure as before, and it is why the script is a documented step in `DEPLOY.md` rather than
 * a thing to remember.
 */

locals {
  # No trailing slash: this is both the path `GetParametersByPath` is called with and the prefix
  # stripped off each name to recover the environment variable.
  application_parameter_path = "/${var.name_prefix}/application"

  application_parameter_arns = [
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.application_parameter_path}",
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.application_parameter_path}/*",
  ]

  # Signer credentials are not ordinary application configuration. The legacy EC2, router and
  # ACME roles retain a path-wide read below /application for their boot/runtime contracts, so
  # placing custody tokens there would make container placement cosmetic. Only the web task's ECS
  # execution role receives exact object ARNs below this separate path.
  android_custody_parameter_path = "/${var.name_prefix}/android-custody"
  android_custody_parameter_arns = [
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.android_custody_parameter_path}",
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.android_custody_parameter_path}/*",
  ]
}

output "application_parameter_path" {
  description = "Parameter Store path holding the application's secrets. Fill it with bin/put-app-secrets.sh."
  value       = local.application_parameter_path
}
