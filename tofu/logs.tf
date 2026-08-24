/*
  Getting customer log lines out of CloudWatch and into ClickHouse.

  One subscription filter on an account-wide log-group prefix, invoking one Lambda. The alternative
  the brief named — a Lambda extension on every customer function — runs our code inside their
  execution environment, shares their memory limit, adds to their cold start, and is billed to them;
  and it has to be attached, so a project deployed before it existed has no logs at all.
*/

resource "aws_iam_role" "log_shipper" {
  name = "${var.name_prefix}-log-shipper"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "log_shipper_basic" {
  role       = aws_iam_role.log_shipper.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# In the VPC, because ClickHouse and the platform Valkey are both reachable only from inside it.
resource "aws_iam_role_policy_attachment" "log_shipper_vpc" {
  role       = aws_iam_role.log_shipper.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_security_group" "log_shipper" {
  name        = "${var.name_prefix}-log-shipper"
  description = "The log shipper Lambda"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name_prefix}-log-shipper" }
}

resource "aws_vpc_security_group_egress_rule" "log_shipper_out" {
  security_group_id = aws_security_group.log_shipper.id
  description       = "To the platform Valkey and to ClickHouse at OVH"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_log_shipper" {
  security_group_id            = aws_security_group.cache.id
  description                  = "Valkey, so the shipper can read a project's live deployment"
  referenced_security_group_id = aws_security_group.log_shipper.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

/*
  The function's code is not managed here.

  `filename` points at a placeholder so the resource can be created; the deploy uploads the real
  package with `update-function-code`. OpenTofu managing Lambda code means every release is a
  `tofu apply`, which is the wrong tool for something that changes per commit — and `ignore_changes`
  is what stops the next apply reverting production to the placeholder.
*/
data "archive_file" "log_shipper_placeholder" {
  type        = "zip"
  output_path = "${path.module}/.build/log-shipper-placeholder.zip"

  source {
    content  = "export const handler = async () => ({ ok: false, reason: 'not deployed' })\n"
    filename = "index.mjs"
  }
}

resource "aws_lambda_function" "log_shipper" {
  function_name = "${var.name_prefix}-log-shipper"
  role          = aws_iam_role.log_shipper.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.log_shipper_placeholder.output_path
  source_code_hash = data.archive_file.log_shipper_placeholder.output_base64sha256

  # A batch is a few hundred lines and one insert. Generous enough for a slow ClickHouse and short
  # enough that a wedged invocation does not sit billing for a quarter of an hour.
  timeout     = 60
  memory_size = 256

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.log_shipper.id]
  }

  environment {
    variables = {
      CLICKHOUSE_URL      = var.clickhouse_url
      CLICKHOUSE_DATABASE = var.clickhouse_database
      VALKEY_URL          = "rediss://${aws_elasticache_replication_group.platform.primary_endpoint_address}:6379"
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash, environment]
  }

  tags = { Name = "${var.name_prefix}-log-shipper" }
}

resource "aws_lambda_permission" "log_shipper_from_logs" {
  statement_id  = "AllowCloudWatchLogs"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.log_shipper.function_name
  principal     = "logs.amazonaws.com"
  source_arn    = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/sproutos-app-*:*"
}

/*
  One filter for the whole account, not one per function.

  An account-level filter matches log groups by prefix as they are created, so a project deployed
  tomorrow is covered without anything running. A filter per function would have to be created by
  the deploy — and a deploy that forgot, or failed after creating the function, leaves a customer
  with an application that runs and produces no logs.

  There is a hard limit of **one** account-level subscription filter per account. That is a real
  constraint on anything else wanting one later, and it is the reason the filter pattern is empty:
  narrowing it here would mean this one filter could not also serve a future consumer.
*/
resource "aws_cloudwatch_log_account_policy" "tenant_logs" {
  policy_name = "${var.name_prefix}-tenant-logs"
  policy_type = "SUBSCRIPTION_FILTER_POLICY"
  scope       = "ALL"

  # Only tenant application log groups. The shipper's own group is excluded by the prefix, which
  # matters more than it looks: a shipper subscribed to itself is an infinite loop that bills.
  selection_criteria = "LogGroupName NOT IN [\"/aws/lambda/${var.name_prefix}-log-shipper\"]"

  policy_document = jsonencode({
    DestinationArn = aws_lambda_function.log_shipper.arn
    FilterPattern  = ""
    Distribution   = "Random"
  })

  depends_on = [aws_lambda_permission.log_shipper_from_logs]
}

/*
  The shipper's own logs expire quickly.

  Customer logs live three days in ClickHouse and CloudWatch is only the transport, so retaining
  them there as well is paying twice for the same lines. This group is the shipper's own output,
  which is small and only interesting while something is wrong.
*/
resource "aws_cloudwatch_log_group" "log_shipper" {
  name              = "/aws/lambda/${var.name_prefix}-log-shipper"
  retention_in_days = 3
  tags              = { Name = "${var.name_prefix}-log-shipper" }
}
