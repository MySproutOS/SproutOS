resource "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]

  thumbprint_list = [
    "d89e3bd43d5d909b47a18977aa9d5ce36cee184c",
  ]
}

resource "aws_iam_role" "github_actions_spa_deploy" {
  name = "github-actions-spa-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:refs/heads/main"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "spa_deploy" {
  name = "spa-deploy-s3"
  role = aws_iam_role.github_actions_spa_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:GetObject",
        ]
        Resource = "${aws_s3_bucket.spa.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
        ]
        Resource = aws_s3_bucket.spa.arn
      },
      {
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation",
        ]
        Resource = aws_cloudfront_distribution.spa.arn
      }
    ]
  })
}

/*
  The role the Deploy workflow assumes.

  Separate from `github-actions-spa-deploy`, which only ever pushed static assets to a bucket. This
  one can replace what production runs, so the two are not one role with a wider policy — the SPA
  deploy runs on every merge and this one does not.

  Trusted for the `main` branch and the `production` environment. The environment condition is what
  makes the protected-environment gate on the cutover job mean something: without it, any workflow
  on `main` could assume this role and skip the approval by calling the API directly.
*/
resource "aws_iam_role" "deploy" {
  name = "${var.name_prefix}-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          # Both spellings of the same repository — see `github_repo_ids` in `variables.tf` for why
          # there are two. `compact` drops the id form if the variable is empty.
          "token.actions.githubusercontent.com:sub" = compact([
            "repo:${var.github_repo}:ref:refs/heads/main",
            "repo:${var.github_repo}:environment:production",
            var.github_repo_ids == "" ? "" : "repo:${var.github_repo_ids}:ref:refs/heads/main",
            var.github_repo_ids == "" ? "" : "repo:${var.github_repo_ids}:environment:production",
          ])
        }
      }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "deploy" {
  name = "release-and-cut-over"
  role = aws_iam_role.deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Releases only. The artifacts bucket also holds customer build archives, and a deploy role
        # that could read those could read every customer's source.
        Sid      = "PublishReleases"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.artifacts.arn}/releases/*"
      },
      {
        /*
          Writing an encrypted object takes two permissions, the mirror of reading one.

          The bucket is SSE-KMS, so `s3:PutObject` alone fails — and fails as `AccessDenied` on
          `CreateMultipartUpload`, naming the KMS key but not the fact that the bucket's encryption
          is what put it in the path. `GenerateDataKey` is what S3 calls to make the per-object key.

          `Decrypt` alongside it because a multipart upload reads back what it has written to
          complete the object, and a release tarball is well past the 8 MB threshold at which the
          CLI switches to multipart.

          Scoped through S3 only, so this role cannot use the key against Secrets Manager — which is
          where the database password lives under the same key.
        */
        Sid      = "PublishReleasesEncryption"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = aws_kms_key.secrets.arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com"
          }
        }
      },
      {
        # Named groups only, so a compromised workflow cannot scale something else in the account.
        Sid    = "FillTheIdleColour"
        Effect = "Allow"
        Action = ["autoscaling:SetDesiredCapacity", "autoscaling:DescribeAutoScalingGroups"]
        Resource = [
          for group in concat(
            [for colour in local.service_colours : aws_autoscaling_group.website[colour].arn],
            [for colour in local.service_colours : aws_autoscaling_group.router[colour].arn],
          ) : group
        ]
      },
      {
        /*
          The describes are unscoped and the modifies are not.

          `elbv2` describe actions do not support resource-level permissions — AWS rejects a policy
          that tries — so they are `*` with the modifies pinned to this listener and this rule. The
          asymmetry is AWS's, and writing it down is better than quietly granting `*` to both.
        */
        Sid    = "ReadTheLoadBalancer"
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeTargetHealth",
          "elasticloadbalancing:DescribeListeners",
          "elasticloadbalancing:DescribeRules",
        ]
        Resource = "*"
      },
      {
        Sid    = "MoveTraffic"
        Effect = "Allow"
        Action = ["elasticloadbalancing:ModifyListener", "elasticloadbalancing:ModifyRule"]
        Resource = [
          aws_lb_listener.https.arn,
          aws_lb_listener_rule.website.arn,
          # The API's rule moves with the website's — one release, two ports, see `bin/cutover.sh`.
          aws_lb_listener_rule.api.arn,
        ]
      },
    ]
  })
}
