terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    # Only for the OIDC thumbprint the IRSA provider needs.
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    # Builds the placeholder zip the log shipper is created with, before the deploy replaces it.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Every resource, tagged, without each one remembering to. `local.tags` is still merged in
  # explicitly where a `Name` is wanted, because default tags cannot be interpolated per resource.
  default_tags {
    tags = {
      Project   = "SproutOS"
      ManagedBy = "OpenTofu"
    }
  }
}

locals {
  tags = {
    Project   = "SproutOS"
    ManagedBy = "OpenTofu"
  }
}

data "aws_caller_identity" "current" {}

check "aws_account" {
  assert {
    condition     = data.aws_caller_identity.current.account_id == var.aws_account_id
    error_message = "Running against wrong AWS account. Expected ${var.aws_account_id}, got ${data.aws_caller_identity.current.account_id}."
  }
}
