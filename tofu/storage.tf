/*
  Tenant object storage, and the one IRSA role in the platform that grants anything at S3.

  Every other data-plane proxy authenticates tenants and talks to something inside the cluster.
  `storage-proxy` is different: it verifies a tenant's SigV4 signature and then *re-signs the request
  with the platform's own credential*, because the customer holds a `SPROUT…` key that AWS has never
  heard of. So this role is what actually reaches a customer's vault, and how narrow it is decides
  what a compromised proxy is worth.

  Narrow means two things here, and neither is optional:

  - **The `v-*` prefix.** Every tenant bucket is `v-<short-id>`; nothing else in the account is. A
    role granted `arn:aws:s3:::*` could read the SPA bucket, the Terraform state bucket, and the
    backups — none of which any tenant request has a reason to touch.
  - **Six actions, not `s3:*`.** The same set `bucketPolicy()` in `lib/typescript/services` produces,
    which is the set `obsidian-livesync` uses. `DeleteBucket` is absent: a compromised proxy can
    delete a customer's notes one at a time, which is recoverable from versioning, and cannot delete
    the vault wholesale, which is not.
*/

resource "aws_iam_role" "storage_proxy" {
  name = "${var.name_prefix}-storage-proxy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.cluster.arn }
      Condition = {
        StringEquals = {
          # Bound to the one service account. Without the `sub` condition any pod in the cluster
          # could assume this role, which would make the tenant boundary a formality.
          "${local.oidc_issuer}:sub" = "system:serviceaccount:sproutos-system:storage-proxy"
          "${local.oidc_issuer}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "storage_proxy" {
  name = "tenant-buckets"
  role = aws_iam_role.storage_proxy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListTenantBuckets"
        Effect   = "Allow"
        Action   = ["s3:GetBucketLocation", "s3:ListBucket"]
        Resource = ["arn:aws:s3:::${var.tenant_bucket_prefix}*"]
      },
      {
        Sid      = "ReadWriteTenantObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = ["arn:aws:s3:::${var.tenant_bucket_prefix}*/*"]
      },
    ]
  })
}

/*
  Bucket creation and teardown belong to the control plane, not the proxy.

  The API provisions and destroys a service; the proxy only ever serves requests for one that
  already exists. Splitting them means a compromise of the thing on the network edge cannot create a
  bucket to exfiltrate into, and cannot delete one at all.
*/
resource "aws_iam_role" "object_storage_admin" {
  name = "${var.name_prefix}-object-storage-admin"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.cluster.arn }
      Condition = {
        StringEquals = {
          "${local.oidc_issuer}:sub" = "system:serviceaccount:sproutos-system:internal-api"
          "${local.oidc_issuer}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "object_storage_admin" {
  name = "tenant-bucket-lifecycle"
  role = aws_iam_role.object_storage_admin.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:CreateBucket",
          "s3:DeleteBucket",
          "s3:PutBucketCORS",
          "s3:GetBucketCORS",
          "s3:ListBucket",
          "s3:DeleteObject",
        ]
        Resource = [
          "arn:aws:s3:::${var.tenant_bucket_prefix}*",
          "arn:aws:s3:::${var.tenant_bucket_prefix}*/*",
        ]
      },
    ]
  })
}
