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
resource "aws_vpc_security_group_ingress_rule" "database_from_cluster" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from the EKS cluster"
}

# No egress rule at all. A database has nothing to say to the internet, and the database subnets
# have no route out regardless — this is the second lock on that door.

resource "aws_rds_cluster" "control_plane" {
  cluster_identifier = "${var.name_prefix}-control-plane"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = var.postgres_version
  database_name      = "main"

  master_username = "sproutos"
  # Managed by RDS in Secrets Manager, so no password is ever written to state. A password in
  # `terraform.tfstate` is a password in an S3 bucket, in a backup of that bucket, and in whatever
  # laptop last ran a plan.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.secrets.arn

  db_subnet_group_name   = aws_db_subnet_group.control_plane.name
  vpc_security_group_ids = [aws_security_group.database.id]

  storage_encrypted = true
  kms_key_id        = aws_kms_key.database.arn

  /*
    Backups.

    35 days is the maximum Aurora allows and the difference between the retention window and the
    time it takes somebody to notice a slow corruption. The ledger is append-only and the audit log
    has a trigger refusing DELETE, so the realistic disaster here is not "a table was dropped" but
    "a migration was wrong three weeks ago" — which a seven-day window does not survive.
  */
  backup_retention_period      = 35
  preferred_backup_window      = "07:00-08:00"
  preferred_maintenance_window = "sun:08:30-sun:09:30"

  # PITR to any second in the retention window is what `backup_retention_period` actually buys on
  # Aurora; continuous backup to S3 is on by default and cannot be turned off. The snapshot on
  # destroy is the guard against a `tofu destroy` that was meant for a different workspace.
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name_prefix}-control-plane-final"
  copy_tags_to_snapshot     = true

  deletion_protection = var.deletion_protection

  # Postgres logs to CloudWatch. Not the tenant observability pipeline — that is ClickHouse, and it
  # is for customers. This is for us, and slow-query logs are where a control plane's problems show
  # up first.
  enabled_cloudwatch_logs_exports = ["postgresql"]

  serverlessv2_scaling_configuration {
    min_capacity = var.database_min_acu
    max_capacity = var.database_max_acu
  }

  tags = local.tags

  lifecycle {
    # The version is upgraded deliberately, in a maintenance window, not because a plan noticed a
    # new minor. `engine_version` drift here is expected and is not a reason to replace a cluster.
    ignore_changes = [engine_version]
  }
}

/*
  Two instances: a writer and one reader.

  Not for read scaling — the control plane's reads are small — but because a single-instance Aurora
  cluster has no failover target, and the recovery from an AZ failure is a restore rather than a
  promotion. The reader is the difference between minutes and hours.
*/
resource "aws_rds_cluster_instance" "control_plane" {
  count = 2

  identifier         = "${var.name_prefix}-control-plane-${count.index}"
  cluster_identifier = aws_rds_cluster.control_plane.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.control_plane.engine
  engine_version     = aws_rds_cluster.control_plane.engine_version

  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.database.arn
  monitoring_interval             = 30
  monitoring_role_arn             = aws_iam_role.rds_monitoring.arn

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
  resources    = [aws_rds_cluster.control_plane.arn]
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
