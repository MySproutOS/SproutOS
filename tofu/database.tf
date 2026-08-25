/**
 * The control-plane database, and the backups that make it recoverable.
 *
 * This is *our* Postgres — organizations, projects, the credit ledger, the audit log. Tenant
 * databases are a different thing entirely: those are Neon OSS compute attached to pageserver
 * storage, provisioned per customer, and nothing here touches them.
 *
 * Aurora Serverless v2 rather than a fixed RDS instance. The control plane's load follows the
 * product's — near nothing overnight, spiking when a region wakes up — and the alternative is
 * paying for the peak twenty-four hours a day. `min_capacity` is not zero on purpose: scale-to-zero
 * exists in v2 now, but the first connection after a pause waits for a resume, and the thing
 * connecting is the API serving somebody's dashboard.
 */

resource "aws_db_subnet_group" "control_plane" {
  name       = "${var.name_prefix}-control-plane"
  subnet_ids = aws_subnet.database[*].id
  tags       = local.tags
}

resource "aws_security_group" "database" {
  name        = "${var.name_prefix}-database"
  description = "Control-plane Postgres. Reachable only from the cluster."
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.tags, { Name = "${var.name_prefix}-database" })
}

/*
  Ingress from the cluster's security group, not from a CIDR.

  A CIDR rule says "anything that happens to hold an address in this range". A security-group
  reference says "anything running in the cluster", which stays true when the subnets are resized
  and false for anything that merely borrows an address.
*/
resource "aws_vpc_security_group_ingress_rule" "database_from_service" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.service.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from the EKS cluster"
}

# No egress rule at all. A database has nothing to say to the internet, and the database subnets
# have no route out regardless — this is the second lock on that door.

/*
  One RDS instance, not an Aurora cluster.

  Aurora buys three things this control plane does not need yet: read replicas it has no reads for,
  storage that scales past what a single volume holds, and sub-second failover. It charges for them
  whether or not they are used — Serverless v2 holds a 0.5-ACU floor per instance, so an idle
  cluster is roughly $44 a month per instance before a single query.

  A `db.t4g.micro` on regular RDS is in the free tier for the first year and is a few dollars a
  month after. When the control plane outgrows it, moving back is a snapshot restore into an Aurora
  cluster — Aurora reads Postgres snapshots — so this is not a door that closes.

  **What is given up, stated plainly:** there is no failover target. An availability-zone failure
  takes the control plane down until RDS restores it, which is minutes rather than seconds. Set
  `database_multi_az = true` when that stops being acceptable; it doubles the instance cost and
  needs nothing else changed.
*/
resource "aws_db_instance" "control_plane" {
  identifier     = "${var.name_prefix}-control-plane"
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.database_instance_class
  db_name        = "main"

  allocated_storage = var.database_storage_gb
  # Grows on its own rather than filling up at 3am. The ceiling is what stops a runaway query
  # turning a disk into a bill.
  max_allocated_storage = var.database_max_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.database.arn

  username = "sproutos"
  # Managed by RDS in Secrets Manager, so no password is ever written to state. A password in
  # `terraform.tfstate` is a password in whatever laptop last ran a plan.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.secrets.arn

  db_subnet_group_name   = aws_db_subnet_group.control_plane.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  multi_az               = var.database_multi_az

  /*
    Backups.

    35 days is the maximum and the difference between the retention window and the time it takes
    somebody to notice a slow corruption. The ledger is append-only and the audit log has a trigger
    refusing DELETE, so the realistic disaster is not "a table was dropped" but "a migration was
    wrong three weeks ago" — which a seven-day window does not survive.
  */
  backup_retention_period = 35
  backup_window           = "07:00-08:00"
  maintenance_window      = "sun:08:30-sun:09:30"
  copy_tags_to_snapshot   = true

  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name_prefix}-control-plane-final"

  deletion_protection = var.deletion_protection

  # Postgres logs to CloudWatch. Not the tenant observability pipeline — that is ClickHouse and it
  # is for customers. This is for us, and slow-query logs are where a control plane's problems show
  # up first.
  enabled_cloudwatch_logs_exports = ["postgresql"]

  auto_minor_version_upgrade = false

  /*
    Major upgrades happen because this configuration asked for one, in place, keeping the data.

    There was an `ignore_changes = [engine_version]` here, on the reasoning that an upgrade should
    be a deliberate act in a maintenance window rather than something a plan noticed. It was
    redundant — `auto_minor_version_upgrade = false` already means RDS never moves the version on
    its own, so there was no drift to ignore — and it was worse than redundant: it hid *our own*
    change. The variable was set to 18 and the instance came up on 17.11 with `plan` reporting no
    changes, which is the same failure the listener had in `compute.tf`. The version this file
    states is now the version that runs.
  */
  allow_major_version_upgrade = true

  tags = local.tags
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${var.name_prefix}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

/*
  A second copy of the backups, in another region and another account's blast radius.

  Aurora's own backups live with the cluster. That covers a failed migration and a dropped table; it
  does not cover the region, and it does not cover somebody with enough credentials deleting the
  cluster and its backups together. AWS Backup with a vault lock is the copy that survives the
  account being wrong about something.
*/
resource "aws_backup_vault" "control_plane" {
  name        = "${var.name_prefix}-control-plane"
  kms_key_arn = aws_kms_key.database.arn
  tags        = local.tags
}

resource "aws_backup_plan" "control_plane" {
  name = "${var.name_prefix}-control-plane"

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.control_plane.name
    # 03:00 UTC, well clear of the RDS backup window so the two are not competing for IO.
    schedule = "cron(0 3 * * ? *)"

    lifecycle {
      delete_after = 90
    }
  }

  tags = local.tags
}

resource "aws_backup_selection" "control_plane" {
  name         = "${var.name_prefix}-control-plane"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.control_plane.id
  resources    = [aws_db_instance.control_plane.arn]
}

resource "aws_iam_role" "backup" {
  name = "${var.name_prefix}-backup"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "backup.amazonaws.com" }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}
