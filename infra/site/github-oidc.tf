# GitHub Actions authenticates by exchanging its own signed OIDC token for
# short-lived AWS credentials. Nothing long-lived is stored in the repository:
# there is no access key to leak, and no rotation to forget.

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# An account can hold only one provider per URL, and most AWS accounts that have
# ever run a GitHub workflow already have this one. Look it up rather than
# asking for an ARN nobody can recall — there is exactly one right answer and
# the account already knows it.
data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1

  url = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_provider_arn = coalesce(
    # An explicit ARN still wins, for the rare account with the provider in a
    # different partition or reached across an assumed role.
    var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : null,
    var.create_github_oidc_provider
    ? aws_iam_openid_connect_provider.github[0].arn
    : data.aws_iam_openid_connect_provider.github[0].arn,
  )
}

locals {
  github_owner = split("/", var.github_repository)[0]
  github_name  = split("/", var.github_repository)[1]

  # GitHub may send either spelling of the repository in the subject claim,
  # depending on whether the organisation has immutable OIDC subject claims
  # turned on. Trusting both exactly costs nothing and survives the setting
  # being flipped either way; guessing wrong fails with a bare "Not authorized
  # to perform sts:AssumeRoleWithWebIdentity" that names neither claim.
  github_repo_slugs = compact([
    var.github_repository,
    var.github_owner_id != "" && var.github_repository_id != ""
    ? "${local.github_owner}@${var.github_owner_id}/${local.github_name}@${var.github_repository_id}"
    : "",
  ])

  allowed_subjects = flatten([
    for slug in local.github_repo_slugs : [
      for ref in var.github_deploy_refs : "repo:${slug}:ref:${ref}"
    ]
  ])
}

data "aws_iam_policy_document" "deploy_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    # Without the audience check the role would trust any GitHub OIDC token,
    # including one minted for a completely different cloud.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # And without the subject check, any repository on GitHub could assume it.
    # StringEquals rather than StringLike, even though a wildcard would paper
    # over the two subject spellings: `repo:RightStackUK*/open-note*` also
    # matches an org someone else can register, such as RightStackUKx. A
    # wildcard here is the classic way this trust policy gets opened to the
    # whole internet.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.allowed_subjects
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "opennote-site-deploy"
  description        = "Assumed by GitHub Actions to publish theopennote.com."
  assume_role_policy = data.aws_iam_policy_document.deploy_assume_role.json
  # An hour is far longer than a deploy needs, and it is the floor AWS allows.
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  # `aws s3 sync` compares against a listing before it uploads anything.
  statement {
    sid       = "ListTheSiteBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.site.arn]
  }

  statement {
    sid    = "WriteSiteObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.site.arn}/*"]
  }

  # Scoped to this distribution. The role cannot invalidate anything else in the
  # account, and cannot change the distribution itself — a compromised workflow
  # can replace the site's contents but not where the site lives.
  statement {
    sid    = "InvalidateTheDistribution"
    effect = "Allow"
    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
    ]
    resources = [aws_cloudfront_distribution.site.arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "opennote-site-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
