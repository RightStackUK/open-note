# The two the deploy workflow needs. They go into GitHub as repository
# variables, not secrets: neither is sensitive, and a variable shows its value
# in the run log, which makes a misconfigured deploy obvious instead of silent.
output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repository variable."
  value       = aws_iam_role.deploy.arn
}

output "cloudfront_distribution_id" {
  description = "Set as the AWS_CLOUDFRONT_DISTRIBUTION_ID repository variable."
  value       = aws_cloudfront_distribution.site.id
}

output "bucket_name" {
  description = "Set as the AWS_S3_BUCKET repository variable."
  value       = aws_s3_bucket.site.id
}

output "cloudfront_domain_name" {
  description = "The distribution's own hostname. Useful for testing before DNS has propagated."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "site_url" {
  value = "https://${var.domain}"
}
