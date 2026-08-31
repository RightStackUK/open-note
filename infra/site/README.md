# infra/site

Terraform for theopennote.com: a private S3 bucket, a CloudFront distribution in
front of it, DNS and a certificate, and the IAM role GitHub Actions assumes to
publish.

Applied **by hand**. CI can replace the site's contents and invalidate the cache
and deliberately nothing else, so a compromised workflow cannot change where the
site lives.

```bash
terraform init
terraform apply
terraform output
```

Setup, the GitHub variables the outputs feed, and why the routing is shaped the
way it is: [`docs/DEPLOYING-SITE.md`](../../docs/DEPLOYING-SITE.md).
