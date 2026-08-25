/**
 * The VPC everything else sits in.
 *
 * Dual-stack IPv4 + IPv6, and the IPv6 half is not decoration. A tenant workload gets a pod IP, and
 * on a platform whose thesis is density — many small projects per node — IPv4 exhaustion inside the
 * cluster CIDR is a real ceiling rather than a theoretical one. IPv6 also removes the NAT gateway
 * from egress-heavy paths, and NAT data processing is billed per gigabyte on traffic that is
 * otherwise free.
 */

locals {
  # Three AZs. Two is the minimum for EKS and leaves no headroom when one is degraded; more than
  # three multiplies inter-AZ transfer, which is billed in both directions and is the line item that
  # quietly dominates a chatty cluster's bill.
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 3)

  # /16 split into /20s: 4094 usable addresses per subnet, twelve subnets, room to add pools without
  # renumbering. Renumbering a VPC means recreating it, and recreating it means recreating the
  # cluster inside it.
  public_subnets   = [for index in range(3) : cidrsubnet(var.vpc_cidr, 4, index)]
  private_subnets  = [for index in range(3) : cidrsubnet(var.vpc_cidr, 4, index + 3)]
  database_subnets = [for index in range(3) : cidrsubnet(var.vpc_cidr, 4, index + 6)]
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block                       = var.vpc_cidr
  assign_generated_ipv6_cidr_block = true
  enable_dns_support               = true
  # Required by EKS: without it nodes cannot resolve the cluster endpoint by name.
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = "${var.name_prefix}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${var.name_prefix}-igw" })
}

/*
  Egress-only gateway for IPv6.

  IPv6 has no NAT — an address is globally routable — so "private" for v6 means *nothing may
  initiate inbound*, which is exactly what this provides. Using a NAT gateway for v6 would be both
  impossible and unnecessary.
*/
resource "aws_egress_only_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${var.name_prefix}-eigw" })
}

resource "aws_subnet" "public" {
  count = length(local.availability_zones)

  vpc_id            = aws_vpc.main.id
  availability_zone = local.availability_zones[count.index]
  cidr_block        = local.public_subnets[count.index]

  ipv6_cidr_block                 = cidrsubnet(aws_vpc.main.ipv6_cidr_block, 8, count.index)
  assign_ipv6_address_on_creation = true
  map_public_ip_on_launch         = false

  tags = merge(local.tags, {
    Name = "${var.name_prefix}-public-${local.availability_zones[count.index]}"
    # The tag the AWS Load Balancer Controller looks for when placing an internet-facing ALB. It is
    # a magic string; without it the controller reports "no subnets found" and nothing explains why.
    "kubernetes.io/role/elb" = "1"
  })
}

resource "aws_subnet" "private" {
  count = length(local.availability_zones)

  vpc_id            = aws_vpc.main.id
  availability_zone = local.availability_zones[count.index]
  cidr_block        = local.private_subnets[count.index]

  ipv6_cidr_block                 = cidrsubnet(aws_vpc.main.ipv6_cidr_block, 8, count.index + 3)
  assign_ipv6_address_on_creation = true

  tags = merge(local.tags, {
    Name                              = "${var.name_prefix}-private-${local.availability_zones[count.index]}"
    "kubernetes.io/role/internal-elb" = "1"
  })
}

/*
  Database subnets have no route to any gateway at all.

  Not "private with egress" — no egress. The control-plane database has no business reaching the
  internet, and a subnet that cannot route out is a stronger statement than a security group rule,
  because it survives somebody loosening the security group.
*/
resource "aws_subnet" "database" {
  count = length(local.availability_zones)

  vpc_id            = aws_vpc.main.id
  availability_zone = local.availability_zones[count.index]
  cidr_block        = local.database_subnets[count.index]

  tags = merge(local.tags, {
    Name = "${var.name_prefix}-database-${local.availability_zones[count.index]}"
  })
}

/*
  One NAT gateway per AZ, not one shared.

  A shared NAT is cheaper until the AZ holding it degrades, at which point every other AZ loses
  egress — the failure mode a three-AZ deployment exists to avoid. It also means cross-AZ data
  processing charges on every byte of egress from the other two.
*/
resource "aws_eip" "nat" {
  count  = length(local.availability_zones)
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.name_prefix}-nat-${count.index}" })
}

/*
  One NAT gateway per availability zone, or one for all of them.

  Per-AZ is the correct production shape: a NAT gateway is zonal, so a single one makes the other
  two zones depend on the zone it lives in — an AZ failure takes egress out for instances that were
  otherwise fine, and cross-AZ NAT traffic is billed on top.

  It is also **$99 a month before a single request is served**, which is the largest idle cost in
  this estate by a wide margin. For a deployment nobody is using yet that is the wrong trade, so
  `nat_gateway_count` exists and defaults to one. Raise it to three before there is traffic worth
  protecting; the routes below follow it either way.
*/
resource "aws_nat_gateway" "main" {
  count = var.nat_gateway_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  depends_on    = [aws_internet_gateway.main]

  tags = merge(local.tags, { Name = "${var.name_prefix}-nat-${count.index}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${var.name_prefix}-public" })
}

resource "aws_route" "public_ipv4" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route" "public_ipv6" {
  route_table_id              = aws_route_table.public.id
  destination_ipv6_cidr_block = "::/0"
  gateway_id                  = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  count = length(local.availability_zones)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count = length(local.availability_zones)

  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${var.name_prefix}-private-${count.index}" })
}

resource "aws_route" "private_ipv4" {
  count = length(local.availability_zones)

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  # `% count`, so three private subnets share however many gateways there are. With one, every
  # subnet routes through it; with three, each has its own.
  nat_gateway_id = aws_nat_gateway.main[count.index % var.nat_gateway_count].id
}

resource "aws_route" "private_ipv6" {
  count = length(local.availability_zones)

  route_table_id              = aws_route_table.private[count.index].id
  destination_ipv6_cidr_block = "::/0"
  egress_only_gateway_id      = aws_egress_only_internet_gateway.main.id
}

resource "aws_route_table_association" "private" {
  count = length(local.availability_zones)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

/*
  A gateway endpoint for S3, because it is free and the alternative is not.

  Every image pull, build artefact and log shipment would otherwise leave through the NAT gateway
  and be billed per gigabyte. A gateway endpoint costs nothing per hour and nothing per byte. This
  is the single highest-leverage line in this file for the cost thesis.
*/
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = merge(local.tags, { Name = "${var.name_prefix}-s3" })
}
