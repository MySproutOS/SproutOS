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

resource "aws_iam_role" "object_storage_admin" {
  name = "${var.name_prefix}-object-storage-admin"

  /*
    Assumed by the service instances, not by a Kubernetes service account.

    This was an IRSA role bound to one service account, and the `sub` condition was what stopped any
    other pod assuming it. There is no cluster and no pods: the boundary is now the instance role,
    which only the website and router instances carry, and which cannot itself create buckets — that
    separation is the point of having two roles rather than one.
  */
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = aws_iam_role.instance.arn }
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
