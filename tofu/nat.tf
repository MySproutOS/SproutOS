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
  Why there is an Elastic IP here at all.

  It is not for stability, and it is not free — that was true until 2024 and is not any more.

  **A NAT instance cannot do its job without a public IPv4 address.** Translating a private
  instance's traffic onto the internet means having somewhere for the replies to come back to.

  **Since 1 February 2024 AWS bills every public IPv4 address at $0.005/hour**, whether it is an
  Elastic IP or one auto-assigned at launch, and whether it is attached or idle. So there is no
  cheaper form of "the NAT instance has a public address" — the $3.60 a month is the price of IPv4
  egress, not the price of this resource.

  Given that the cost is fixed, the question is only which form. An auto-assigned address would
  require `map_public_ip_on_launch` on the public subnet and would land on the instance's *primary*
  interface — and the private route tables point at the standalone interface below precisely so
  that replacing the instance does not change the id they route to. A standalone interface cannot
  take an auto-assigned address; an Elastic IP is the only way to give it one.

  So: same cost, and the only form that keeps egress working when the instance is replaced.

  **The way to actually remove this charge is IPv6.** The VPC is dual-stack and already has an
  egress-only internet gateway, which costs nothing and needs no NAT. Everything reachable over
  IPv6 could egress that way. That is a real piece of work — not every upstream this platform talks
  to has an AAAA record — and it is the thing to do before optimising this line any further.
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

  iam_instance_profile = aws_iam_instance_profile.nat[0].name

  /*
    The fixed interface, attached at launch as device 0 — not attached later by the instance itself.

    This was the other way round once, and it did not work: the instance launched into the public
    subnet on its own interface with `map_public_ip_on_launch = false`, so it had no address, and
    its user data asked it to call `ec2:AttachNetworkInterface` to pick up the interface holding the
    Elastic IP. That call goes to the EC2 API over the internet — the internet this instance is
    supposed to be providing. It could not make the call, the interface stayed `available`, and the
    private route tables' default route sat in state `blackhole`.

    **Nothing reported that.** The NAT instance was `running` and healthy, `tofu plan` was clean,
    and the failure surfaced three layers away as service instances that booted, could not reach
    S3's regional endpoint or SSM, failed their bootstrap and were replaced — an Auto Scaling loop
    with no message naming the cause.

    Attached at launch there is no call to make. The interface is the instance's primary one, it
    already carries the Elastic IP, and the route tables point at an id that outlives any instance.

    `subnet_id` and `vpc_security_group_ids` are not set here on purpose: both live on the interface
    now, and AWS rejects an instance that specifies either alongside a primary interface.
  */
  network_interface {
    device_index         = 0
    network_interface_id = aws_network_interface.nat[0].id
    # The interface is a resource in its own right and must survive the instance it is attached to —
    # that being the entire reason it exists.
    delete_on_termination = false
  }

  # `source_dest_check` is on the interface rather than here. EC2 drops packets whose destination is
  # not the instance unless it is off, and an instance block cannot set it while a primary interface
  # is specified — AWS rejects the pair.

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  tags = merge(local.tags, { Name = "${var.name_prefix}-nat" })
}

/*
  A fixed network interface, declared before the instance and outliving it.

  The private route tables point at an interface id. If that id belonged to the instance, replacing
  the instance would change it and every private subnet would route to something that no longer
  exists — until somebody noticed and ran an apply. This interface outlives the instance, which
  attaches it at launch as its primary interface.
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
