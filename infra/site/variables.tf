variable "domain" {
  description = "Apex domain the site is served from."
  type        = string
  default     = "theopennote.com"
}

variable "www_redirect" {
  description = <<-EOT
    Also answer on www.<domain> and 301 it to the apex. One canonical hostname
    keeps links, search results and the CDN cache from splitting in two.
  EOT
  type        = bool
  default     = true
}

variable "region" {
  description = "Region for the bucket. Anything but us-east-1 is fine; CloudFront serves from the edge either way."
  type        = string
  default     = "eu-west-2"
}

variable "bucket_name" {
  description = "Origin bucket. Never public — CloudFront reaches it through Origin Access Control."
  type        = string
  default     = "theopennote-com-site"
}

variable "github_repository" {
  description = "owner/name of the repository allowed to assume the deploy role."
  type        = string
  default     = "RightStackUK/open-note"
}

variable "github_deploy_refs" {
  description = <<-EOT
    Git refs whose workflow runs may assume the deploy role. Anything not listed
    cannot reach the bucket, so a pull request from a fork can build the site but
    never publish it.

    Note: attaching a GitHub Environment to the deploy job replaces the ref in
    the token's subject claim with `environment:<name>`, and the role stops
    trusting it. Change the trust policy at the same time, or the deploy fails
    with an unhelpful "Not authorized to perform sts:AssumeRoleWithWebIdentity".
  EOT
  type        = list(string)
  default     = ["refs/heads/main"]
}

variable "github_owner_id" {
  description = <<-EOT
    Numeric ID of the repository owner, from `gh api repos/OWNER/REPO --jq .owner.id`.

    GitHub can issue OIDC tokens with an *immutable* subject claim, which embeds
    the numeric owner and repository IDs —
    `repo:Owner@129496338/repo@1350515140:ref:refs/heads/main` — so that renaming
    an org or repo cannot silently hand its trust to whoever claims the old name.
    Some organisations have this on, some do not, and the two forms are not
    interchangeable. Supply the IDs and the role trusts both spellings exactly.
  EOT
  type        = string
  default     = ""
}

variable "github_repository_id" {
  description = "Numeric ID of the repository, from `gh api repos/OWNER/REPO --jq .id`. See github_owner_id."
  type        = string
  default     = ""
}

variable "create_github_oidc_provider" {
  description = <<-EOT
    Create the account-wide GitHub OIDC provider. There can only be one per AWS
    account, so set this to false if the account already has one — it is then
    looked up by URL, and needs no ARN from you.
  EOT
  type        = bool
  default     = true
}

variable "github_oidc_provider_arn" {
  description = <<-EOT
    Override for the provider ARN. Almost never needed: when
    create_github_oidc_provider is false, the existing provider is looked up in
    the account by its URL.
  EOT
  type        = string
  default     = ""
}

variable "price_class" {
  description = "PriceClass_100 is North America and Europe. Widen it if the audience turns out to be elsewhere."
  type        = string
  default     = "PriceClass_100"
}

variable "tags" {
  description = "Applied to every resource that accepts tags."
  type        = map(string)
  default = {
    Project   = "open-note"
    Component = "website"
    ManagedBy = "terraform"
  }
}
