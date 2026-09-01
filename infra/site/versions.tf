terraform {
  required_version = ">= 1.10" # use_lockfile in the S3 backend needs it

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

  # State lives in S3, not on one laptop: a local state file is a single point
  # of failure that, once lost, leaves Terraform unaware it owns any of this and
  # planning to create all of it a second time.
  #
  # The bucket is created out of band — see docs/DEPLOYING-SITE.md. It cannot be
  # managed here, because Terraform would need the bucket to exist in order to
  # store the state that records the bucket.
  backend "s3" {
    bucket = "open-note-terraform-state"
    key    = "site/terraform.tfstate"
    region = "eu-west-2"

    # Native S3 locking, added in Terraform 1.10 — it holds a .tflock object
    # beside the state. The DynamoDB table this used to require was a whole
    # second resource to provision and pay for, and is now unnecessary.
    use_lockfile = true

    encrypt = true
  }
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
