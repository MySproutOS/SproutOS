variable "aws_account_id" {
  description = "AWS account ID to validate against"
  type        = string
  default     = "471112590391"
}

variable "github_repo" {
  description = "GitHub repository in owner/repo format"
  type        = string
  default     = "Andrew-Chen-Wang/nextjs-spa-split"
}

variable "s3_bucket_name" {
  description = "Name of the S3 bucket for SPA assets"
  type        = string
  default     = "nextjs-spa-split"
}
