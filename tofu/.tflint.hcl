# Core rules alone check style. The AWS ruleset checks the things that cannot be planned here:
# whether an instance type exists, whether an attribute is valid for a resource, whether an IAM
# policy document is well-formed. Without an AWS account this is the deepest verification available,
# and it is the difference between "the HCL parses" and "these arguments are real".
plugin "aws" {
  enabled = true
  version = "0.44.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

rule "terraform_required_version" {
  enabled = true
}

rule "terraform_documented_variables" {
  enabled = true
}
