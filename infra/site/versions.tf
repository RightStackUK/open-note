terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # 5.40 made `thumbprint_list` optional on the OIDC provider: AWS stopped
      # verifying it once it began trusting the root CAs directly, and pinning a
      # thumbprint here would only be one more thing to rotate. Held below 7 so a
      # major provider release cannot land in an unattended apply.
      version = ">= 5.40, < 7.0"
    }
  }

  # State is local by default, which is fine while one person owns this stack.
  # Point it at a bucket before a second person applies it — two local states
  # diverge silently and the second apply starts trying to recreate everything.
  #
  # backend "s3" {
  #   bucket = "opennote-tfstate"
  #   key    = "site/terraform.tfstate"
  #   region = "eu-west-2"
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = var.tags
  }
}

# CloudFront reads its certificate from us-east-1 and nowhere else, so the
# certificate is the one resource that cannot live in var.region.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = var.tags
  }
}
