# infra/site

Terraform for theopennote.com: a private S3 bucket, a CloudFront distribution in
front of it, DNS and a certificate, and the IAM role GitHub Actions assumes to
publish.

Applied **by hand**. CI can replace the site's contents and invalidate the cache
and deliberately nothing else, so a compromised workflow cannot change where the
site lives.

```bash
export AWS_PROFILE=fyelci
terraform init
terraform apply
terraform output
```

State is in S3 (`open-note-terraform-state`), locked with a `.tflock` object
beside it. Nothing is kept locally.

Setup, the GitHub variables the outputs feed, and why the routing is shaped the
way it is: [`docs/DEPLOYING-SITE.md`](../../docs/DEPLOYING-SITE.md).
