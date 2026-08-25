/*
  Egress for the private subnets, on an instance rather than a managed gateway.

  A NAT gateway is $0.045 an hour — $33 a month — before it passes a byte, plus $0.045 per gigabyte
  processed. `fck-nat` is a maintained AMI that does the same job on an ordinary EC2 instance: a
  `t4g.nano` is about $3 a month, and data processing is not billed at all, only the instance's
  network throughput.

  ## What is given up, plainly

  A NAT gateway is a managed, horizontally-scaled AWS service with no instance to patch and no
  single process to die. This is one instance:

  - **It is a single point of failure for egress.** If it stops, private instances lose outbound
    internet — not inbound, so the ALB keeps serving anything already running, but a Lambda
    invocation from the router or a package fetch at boot will fail. The Auto Scaling group below
    replaces a failed instance in a couple of minutes.
  - **Throughput is the instance's.** A `t4g.nano` does around 5 Gbps burst and is credit-limited on
    sustained traffic. That is far more than this platform's egress, and it is a real ceiling a
    gateway does not have.
  - **It is in one availability zone.** Everything egresses through that zone, which is a
    cross-AZ hop for instances in the other two and a dependency on a zone they otherwise do not
    need.

  Every one of those is the right trade for a platform with no traffic and the wrong one at scale.
  The variable below switches back.
*/

data "aws_ami" "fck_nat" {
  count = var.use_nat_instance ? 1 : 0

  most_recent = true
  owners      = ["568608671756"] # fck-nat's publisher

  filter {
    name = "name"
    # arm64, matching the instance type below — the x86 image on a Graviton instance simply will
    # not launch, with an error about the platform rather than the architecture.
    values = ["fck-nat-al2023-*-arm64-ebs"]
  }
}

resource "aws_security_group" "nat" {
  count = var.use_nat_instance ? 1 : 0

  name        = "${var.name_prefix}-nat"
  description = "NAT instance"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.tags, { Name = "${var.name_prefix}-nat" })
}

/*
  From the VPC only.

  A NAT instance forwards whatever it is given, so a security group open to the internet is an open
  proxy — one anybody can point at anything, billed to this account. The CIDR is what keeps it a
  NAT rather than a relay.
*/
resource "aws_vpc_security_group_ingress_rule" "nat_from_vpc" {
  count = var.use_nat_instance ? 1 : 0

  security_group_id = aws_security_group.nat[0].id
  description       = "Everything inside the VPC, and nothing outside it"
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "nat_out" {
  count = var.use_nat_instance ? 1 : 0

  security_group_id = aws_security_group.nat[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_iam_role" "nat" {
  count = var.use_nat_instance ? 1 : 0

  name = "${var.name_prefix}-nat"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

/*
  What a replacement instance needs to take over.

  When the Auto Scaling group replaces a failed NAT, the new instance has to attach the Elastic IP
  and re-point the private route tables at its own interface. Without this it comes up healthy and
  routes nothing, which is the failure mode that looks like a network problem for an hour.
*/
resource "aws_iam_role_policy" "nat" {
  count = var.use_nat_instance ? 1 : 0

  name = "take-over-egress"
  role = aws_iam_role.nat[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ec2:AttachNetworkInterface",
        "ec2:ModifyNetworkInterfaceAttribute",
        "ec2:AssociateAddress",
        "ec2:DisassociateAddress",
        "ec2:DescribeAddresses",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeInstances",
        "ec2:DescribeSubnets",
        "ec2:ReplaceRoute",
        "ec2:DescribeRouteTables",
      ]
      # Not scoped to a resource: every one of these is a Describe or an operation whose target is
      # chosen at runtime by the instance itself, and none of them can be named in advance.
      Resource = "*"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "nat_ssm" {
  count = var.use_nat_instance ? 1 : 0

  role       = aws_iam_role.nat[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "nat" {
  count = var.use_nat_instance ? 1 : 0

  name = "${var.name_prefix}-nat"
  role = aws_iam_role.nat[0].name
}

/*
  One address, kept across replacements.

  An Elastic IP is free while attached and $3.60 a month while it is not. Attached to the instance
  it costs nothing, and it is what makes a replacement invisible to anything that allowlisted this
  platform's egress address — OVH's Valkey and OpenSearch, above all.
*/
resource "aws_eip" "nat" {
  count = var.use_nat_instance ? 1 : 0

  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.name_prefix}-nat" })
}

resource "aws_instance" "nat" {
  count = var.use_nat_instance ? 1 : 0

  ami           = data.aws_ami.fck_nat[0].id
  instance_type = var.nat_instance_type
  subnet_id     = aws_subnet.public[0].id

  vpc_security_group_ids = [aws_security_group.nat[0].id]
  iam_instance_profile   = aws_iam_instance_profile.nat[0].name

  /*
    The line that makes it a NAT at all.

    EC2 drops packets whose destination is not the instance unless this is off. A NAT instance with
    the check enabled comes up, passes its health check, and silently forwards nothing.
  */
  source_dest_check = false

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  user_data = <<-EOT
    #!/bin/bash
    echo "eni_id=${aws_network_interface.nat[0].id}" >> /etc/fck-nat.conf
    echo "eip_id=${aws_eip.nat[0].id}" >> /etc/fck-nat.conf
    service fck-nat restart
  EOT

  tags = merge(local.tags, { Name = "${var.name_prefix}-nat" })
}

/*
  A fixed network interface, separate from the instance.

  The private route tables point at an interface id. If that id belonged to the instance, replacing
  the instance would change it and every private subnet would route to something that no longer
  exists — until somebody noticed and ran an apply. A standalone interface outlives the instance.
*/
resource "aws_network_interface" "nat" {
  count = var.use_nat_instance ? 1 : 0

  subnet_id         = aws_subnet.public[0].id
  security_groups   = [aws_security_group.nat[0].id]
  source_dest_check = false

  tags = merge(local.tags, { Name = "${var.name_prefix}-nat" })
}

resource "aws_eip_association" "nat" {
  count = var.use_nat_instance ? 1 : 0

  allocation_id        = aws_eip.nat[0].id
  network_interface_id = aws_network_interface.nat[0].id
}
