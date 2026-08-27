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
            /*
              Both spellings, for the same reason the deploy role below carries both: GitHub issues
              an *id-qualified* subject for this organisation, and a trust policy naming only
              `repo:owner/name:...` never matches it. This role was written with the plain form
              only, which made it correct on paper and impossible to assume — the failure is an
              `AssumeRoleWithWebIdentity` denial that says nothing about subjects.
            */
            "token.actions.githubusercontent.com:sub" = compact([
              "repo:${var.github_repo}:ref:refs/heads/main",
              var.github_repo_ids == "" ? "" : "repo:${var.github_repo_ids}:ref:refs/heads/main",
            ])
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
          The website's hashed assets, which the CDN serves instead of the origin.

          Scoped to `_next/static/`, not the whole bucket: the same bucket holds the dashboard and
          admin SPAs, and a deploy of the website has no business rewriting those. Content-hashed
          names mean this only ever adds keys, so there is no delete permission here and none needed.
        */
        Sid      = "PublishWebsiteAssets"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.spa.arn}/_next/static/*"
      },
      {
        # `aws s3 sync` compares against what is already there before uploading, so it needs List.
        Sid      = "ListWebsiteAssets"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.spa.arn
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
        /*
          The two mutating calls, scoped to this platform's own groups.

          `TerminateInstanceInAutoScalingGroup` is here because filling the idle colour has to
          *replace* what is already running, not merely count it: an instance reads the release
          pointer at boot, so one that is already up is running an older release however healthy it
          looks.
        */
        Action = [
          "autoscaling:SetDesiredCapacity",
          "autoscaling:TerminateInstanceInAutoScalingGroup",
        ]
        Resource = [
          for group in concat(
            [for colour in local.service_colours : aws_autoscaling_group.website[colour].arn],
            [for colour in local.service_colours : aws_autoscaling_group.router[colour].arn],
          ) : group
        ]
      },
      {
        /*
          `Describe*` takes no resource, and scoping it is how it gets denied.

          Auto Scaling's read calls do not support resource-level permissions: listing is not an
          operation *on* a group, it is an operation that returns groups. Naming ARNs here produces
          an `AccessDenied` that reads as a missing permission when the permission was granted — it
          was simply granted against a resource the action cannot be scoped to.
        */
        Sid      = "ReadAutoScalingState"
        Effect   = "Allow"
        Action   = ["autoscaling:DescribeAutoScalingGroups"]
        Resource = "*"
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
        /*
          Running the migration on an instance, because the database cannot be reached from a runner.

          The control-plane database is in a subnet with no route to any gateway, so CI drives the
          migration rather than performing it: `bin/migrate.sh` sends one shell command to an
          instance already inside the VPC and reads back its exit status.

          **Two statements, because `SendCommand` authorizes against two resources** — the document
          and each target instance — and an IAM condition applies to every resource in the statement
          it sits in. Written as one statement with the tag condition, the condition was also
          evaluated against `AWS-RunShellScript`, which carries no `Service` tag, so it failed and
          the call was denied with "no identity-based policy allows the ssm:SendCommand action" —
          a message that reads like the action was never granted at all.

          The instance half stays scoped: an unscoped grant would let this role run arbitrary shell
          on every managed instance in the account, including the NAT instance and the router, which
          is a far larger capability than "deploy the website". `Service` is the tag the launch
          template actually sets; `Project` is on the OpenTofu resources and never reaches the
          instances.
        */
        Sid      = "RunMigrationsUsingTheShellDocument"
        Effect   = "Allow"
        Action   = ["ssm:SendCommand"]
        Resource = ["arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript"]
      },
      {
        Sid      = "RunMigrationsOnWebsiteInstancesOnly"
        Effect   = "Allow"
        Action   = ["ssm:SendCommand"]
        Resource = ["arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:instance/*"]
        Condition = {
          StringEquals = {
            "ssm:resourceTag/Service" = "website"
          }
        }
      },
      {
        Sid      = "ReadTheMigrationResult"
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation"]
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
          # And the listeners on the tenant load balancer, which the router is the default of.
          # They move with the router exactly as the search rule does.
          aws_lb_listener.postgres.arn,
          aws_lb_listener.valkey.arn,
          aws_lb_listener.forward_proxy.arn,
          # The search split's rule moves with the router's listener, for the same reason.
          #
          # Enumerated rather than a wildcard on the listener, so a rule added by hand cannot be
          # moved by CI. The cost is that adding one here is a step that is easy to forget — and it
          # was: the cutover's first run with a search rule got `AccessDenied` on `ModifyRule` after
          # the fill had already succeeded. What made that harmless rather than an outage is the
          # ordering in `cutover.sh`, which moves the *not yet serving* rule first: the listener was
          # never touched, so traffic stayed where it was.
          aws_lb_listener_rule.search.arn,
        ]
      },
    ]
  })
}
