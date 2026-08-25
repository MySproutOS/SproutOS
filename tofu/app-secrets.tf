/**
 * The application's own secrets, and the one thing this file deliberately does not contain.
 *
 * The instances get `DATABASE_URL`, the Valkey address and their ports from `user-data.sh.tftpl`.
 * Everything else an application needs to work — the GitHub OAuth credentials, the webhook secrets,
 * the Stripe keys — was never provisioned anywhere, which is why pressing "Login with GitHub" in
 * production answered 500 with `Missing required environment variable: GITHUB_OAUTH_CLIENT_ID`.
 * `DEPLOY.md` recorded this as an open gap; it is closed here.
 *
 * **No values live in this file, and none reach `terraform.tfstate`.** OpenTofu creates the
 * container; `bin/put-app-secrets.sh` fills it from the operator's `.env`. A secret written through
 * OpenTofu is a secret in the state file, which is a secret on whatever laptop last ran a plan and
 * in whatever bucket the state is kept in — the same reasoning that put the database password
 * behind `manage_master_user_password`.
 */

resource "aws_secretsmanager_secret" "application" {
  name        = "${var.name_prefix}/application"
  description = "GitHub, Stripe and signing secrets read by the website, API and worker at boot."
  kms_key_id  = aws_kms_key.secrets.arn

  # Long enough to undo a mistake, short enough that a rotated credential really goes away.
  recovery_window_in_days = 7

  tags = local.tags
}

/*
  An empty starting version, so the secret exists before anything tries to read it.

  `ignore_changes` on the value is what keeps the real contents out of state: the operator writes
  them with `put-secret-value` and OpenTofu never looks again. Without it, every apply would
  overwrite the live secret with this placeholder — which is the sort of thing that is discovered
  when logins stop working.
*/
resource "aws_secretsmanager_secret_version" "application" {
  secret_id     = aws_secretsmanager_secret.application.id
  secret_string = jsonencode({ placeholder = "run bin/put-app-secrets.sh" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

output "application_secret_arn" {
  description = "Where the application's secrets live. Populate with bin/put-app-secrets.sh."
  value       = aws_secretsmanager_secret.application.arn
}
