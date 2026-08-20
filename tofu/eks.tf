/**
 * The cluster, and the two kinds of node underneath it.
 *
 * **Ordinary nodes** run the control plane's own workloads — the website, the API, the job worker,
 * the Rust proxies. Managed node groups, Graviton, spot-free: these are the processes that being
 * interrupted actually hurts.
 *
 * **Tenant metal** is where customer code runs, under Kata. It is a fixed-size group rather than
 * anything autoscaled, and that is ADR-level: metal takes ten to twenty minutes to boot, which is
 * unusable as a just-in-time scaling unit. Karpenter manages the ordinary pools; metal is planned
 * capacity.
 *
 * arm64 throughout. One architecture means one build of every image, one set of base layers, and no
 * class of bug that only appears on one node type — and Graviton is the cost thesis.
 */

resource "aws_eks_cluster" "main" {
  name     = var.name_prefix
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    subnet_ids = concat(aws_subnet.private[*].id, aws_subnet.public[*].id)
    # Private endpoint on, public endpoint on but restricted. Fully private would mean every
    # `kubectl` and every CI deploy runs through a bastion, and a bastion is a long-lived host with
    # cluster credentials — a worse trade than an allowlisted public endpoint.
    endpoint_private_access = true
    endpoint_public_access  = true
    public_access_cidrs     = var.cluster_public_access_cidrs
  }

  # Without this, Kubernetes Secrets sit in etcd in the clear and every etcd backup is a copy of
  # every credential the platform holds.
  encryption_config {
    provider {
      key_arn = aws_kms_key.eks.arn
    }
    resources = ["secrets"]
  }

  # `api` rather than the legacy `aws-auth` ConfigMap: access is IAM, versioned, and auditable,
  # instead of a ConfigMap that anyone with edit rights can rewrite.
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = false
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator"]

  depends_on = [
    aws_iam_role_policy_attachment.cluster,
    aws_cloudwatch_log_group.cluster,
  ]

  tags = local.tags
}

/*
  The log group is declared, not left to EKS.

  EKS creates it implicitly with never-expire retention, which is a bill that grows forever and a
  resource `tofu destroy` leaves behind. Declaring it means retention is a decision.
*/
resource "aws_cloudwatch_log_group" "cluster" {
  name              = "/aws/eks/${var.name_prefix}/cluster"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.secrets.arn
  tags              = local.tags
}

resource "aws_iam_role" "cluster" {
  name = "${var.name_prefix}-cluster"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["sts:AssumeRole", "sts:TagSession"]
      Principal = { Service = "eks.amazonaws.com" }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

/*
  IRSA, not EKS Pod Identity.

  Pod Identity is the newer and generally better mechanism, and it cannot be used here. Its agent
  serves credentials on the host's link-local address, `169.254.170.23`, which a Kata pod's in-guest
  network namespace cannot reach — and tenant isolation blocks link-local egress anyway. Projected
  service-account tokens work inside the guest because they are a file, not a network call.
*/
data "tls_certificate" "cluster" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "cluster" {
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.cluster.certificates[0].sha1_fingerprint]
  tags            = local.tags
}

resource "aws_iam_role" "node" {
  name = "${var.name_prefix}-node"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    # Pull-only. A node that can push to the registry is a node that can replace the image every
    # other node is about to pull.
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ])

  role       = aws_iam_role.node.name
  policy_arn = each.value
}

resource "aws_eks_node_group" "platform" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "platform"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = aws_subnet.private[*].id

  ami_type       = "AL2023_ARM_64_STANDARD"
  instance_types = var.platform_instance_types
  capacity_type  = "ON_DEMAND"

  scaling_config {
    desired_size = var.platform_node_count
    min_size     = 2
    max_size     = 10
  }

  update_config {
    max_unavailable = 1
  }

  labels = { "sproutos.dev/pool" = "platform" }
  tags   = local.tags

  lifecycle {
    # Karpenter and the cluster autoscaler both move this. A plan that resets it to the declared
    # value would undo a scaling decision made under load.
    ignore_changes = [scaling_config[0].desired_size]
  }
}

/*
  Tenant metal, tainted so nothing lands here by accident.

  Every pod that belongs here carries a matching toleration and a Kata runtime class. The taint is
  what stops a platform workload drifting onto the most expensive nodes in the account because a
  scheduler found room.
*/
resource "aws_eks_node_group" "tenant" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "tenant"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = aws_subnet.private[*].id

  ami_type       = "AL2023_ARM_64_STANDARD"
  instance_types = [var.tenant_instance_type]
  capacity_type  = "ON_DEMAND"

  scaling_config {
    desired_size = var.tenant_node_count
    min_size     = var.tenant_node_count
    max_size     = var.tenant_node_count
  }

  taint {
    key    = "sproutos.dev/tenant"
    value  = "true"
    effect = "NO_SCHEDULE"
  }

  labels = {
    "sproutos.dev/pool" = "tenant"
    # `kata-deploy` keys off this to install the runtime classes and the hypervisor binaries.
    "katacontainers.io/kata-runtime" = "true"
  }

  tags = local.tags
}
