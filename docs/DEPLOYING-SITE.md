# Deploying theopennote.com

The website is a **static site**. There is no server, no Node process and no
build step at request time — `pnpm site:build` writes plain HTML, CSS, JS and
images to `apps/site/dist/`, and that directory *is* the website.

```bash
pnpm install
pnpm site:build          # → apps/site/dist
```

It is hosted from a private S3 bucket behind CloudFront. Pushing to `main`
deploys it; nothing is deployed by hand.

| | |
|---|---|
| Infrastructure | [`infra/site`](../infra/site) — Terraform, applied manually |
| Deploy | [`.github/workflows/deploy-site.yml`](../.github/workflows/deploy-site.yml) — on push to `main` |
| Credentials | GitHub OIDC → a scoped IAM role. No stored AWS keys. |

## The moving parts

Nothing about the *site* is host-specific — `dist/` will work on any static
host. Two things about **this** host are not obvious, and both are solved in
`infra/site`:

**Astro emits directory-style pages.** `/features` is `features/index.html`.
An S3 *website* endpoint would resolve that itself, but a website endpoint is
HTTP-only and public, so it cannot be locked to CloudFront with Origin Access
Control. This uses the REST endpoint with a private bucket instead, and a
CloudFront Function on viewer request maps `/features` onto the file. The same
function 301s `www` to the apex, so there is one canonical hostname.

**The REST endpoint returns 403, not 404,** for a key that does not exist — S3
will not confirm absence to a caller that cannot list the bucket. The
distribution maps both 403 and 404 onto `/404.html`, or a mistyped URL would
render as an S3 XML error.

## First-time setup

The domain is registered in Route 53, which means the hosted zone already
exists; Terraform looks it up rather than creating one. Everything else it
creates: the bucket, the certificate, the distribution, the DNS records, and the
IAM role GitHub Actions assumes.

```bash
cd infra/site
terraform init
terraform apply
```

The certificate is validated over DNS, so the apply pauses for a few minutes
while ACM checks the records Terraform just wrote, and again while CloudFront
distributes. Fifteen to twenty minutes end to end is normal for the first apply.

If the AWS account has ever run a GitHub Actions workflow it already has an OIDC
provider, and an account can hold only one per URL. Set
`create_github_oidc_provider = false` in `terraform.tfvars` and the existing one
is looked up by URL — you do not need its ARN. Leaving this true against an
account that already has one fails the apply with `EntityAlreadyExists`.

### The OIDC subject claim

GitHub can issue tokens with an **immutable** subject claim, which embeds the
numeric owner and repository IDs:

```
repo:RightStackUK@129496338/open-note@1350515140:ref:refs/heads/main
```

rather than the classic `repo:RightStackUK/open-note:ref:refs/heads/main`. It
exists so renaming an org or repo cannot hand its AWS trust to whoever claims
the old name. This organisation has it on, so `github_owner_id` and
`github_repository_id` are set in `terraform.tfvars` and the role trusts **both**
spellings, exactly. Get them with:

```bash
gh api repos/RightStackUK/open-note --jq '{owner: .owner.id, repo: .id}'
```

Trusting the wrong one fails with a bare `Not authorized to perform
sts:AssumeRoleWithWebIdentity`, which names neither the claim it got nor the one
it wanted. CloudTrail does — look up the `AssumeRoleWithWebIdentity` event and
read `userIdentity.principalId`:

```bash
aws cloudtrail lookup-events --region eu-west-2 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --max-results 1 --query 'Events[].CloudTrailEvent' --output text
```

Do not be tempted to fix a mismatch with `StringLike` and a wildcard:
`repo:RightStackUK*/open-note*` also matches `RightStackUKx/open-note-evil`, an
org name anyone can register.

### Repository variables

The deploy reads four **variables** — not secrets. None is sensitive, and a
variable prints its value in the run log, which makes a misconfigured deploy
obvious instead of silent.

| Variable | Value | Source |
|---|---|---|
| `AWS_REGION` | `eu-west-2` | fixed |
| `AWS_S3_BUCKET` | `theopennote-com-site` | `terraform output bucket_name` |
| `SITE_DOMAIN` | `theopennote.com` | fixed; only the smoke test reads it |
| `AWS_DEPLOY_ROLE_ARN` | — | `terraform output deploy_role_arn` |
| `AWS_CLOUDFRONT_DISTRIBUTION_ID` | — | `terraform output cloudfront_distribution_id` |

The first three are fixed and already set. The last two exist only once the
stack does, so set them straight after the first apply:

```bash
cd infra/site
gh variable set AWS_DEPLOY_ROLE_ARN            --body "$(terraform output -raw deploy_role_arn)"
gh variable set AWS_CLOUDFRONT_DISTRIBUTION_ID --body "$(terraform output -raw cloudfront_distribution_id)"
```

Then trigger a deploy without waiting for a commit:

```bash
gh workflow run deploy-site.yml
```

### State

State lives in S3, in `open-note-terraform-state` under `site/terraform.tfstate`,
with versioning on and 90 days of old versions kept. There is nothing to keep
safe on your laptop.

Locking is the S3-native kind (`use_lockfile`, Terraform 1.10+), which holds a
`.tflock` object beside the state — a second `terraform` is refused with a 412
rather than quietly racing. That replaces the DynamoDB table this used to
require, which was a whole second resource to provision and pay for.

The bucket is **created by hand**, not by this stack, and that is not an
oversight: Terraform would need the bucket to already exist in order to store
the state that records the bucket. It also means `terraform destroy` cannot take
the state with it. To recreate it from nothing:

```bash
B=open-note-terraform-state
aws s3api create-bucket --bucket $B --region eu-west-2 \
  --create-bucket-configuration LocationConstraint=eu-west-2
aws s3api put-public-access-block --bucket $B --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket $B --versioning-configuration Status=Enabled
```

Versioning matters more than it looks: it is the only way back from a state file
that gets truncated or corrupted mid-write.

## What the deploy does

It runs on push to `main` when `apps/site/**`, the lockfile or the workflow
changes, and on `workflow_dispatch`. Deploys are serialised and an in-flight one
is never cancelled: `aws s3 sync` interrupted halfway leaves the bucket holding
half of one build and half of another.

After building, it uploads in passes, and **the order is deliberate**:

1. **Fingerprinted assets first, without `--delete`.** The HTML about to go live
   references them, so they have to exist before it does.
2. **Pages and everything else, with `--delete`.** The new site goes live here.
3. **Invalidate `/*`, and wait for it.** Waiting means a green job implies the
   new site is actually being served.
4. **Prune orphaned assets, with `--delete`.** Last, because until the edge stops
   serving the previous HTML, that HTML's asset URLs still have to resolve.
5. **Smoke test.** Fetches four real pages and one bogus one. Since extensionless
   paths only resolve if the CloudFront Function rewrote them, this checks the
   routing as much as the upload.

## Cache headers

Astro fingerprints its own assets, so they can be cached forever. Nothing else
can be.

| Path | `Cache-Control` |
|---|---|
| `/_astro/*` | `public, max-age=31536000, immutable` |
| `/screenshots/*` | `public, max-age=604800` |
| everything else | `public, max-age=0, must-revalidate` |

"Everything else" includes `/pagefind/*`. Pagefind's fragments are
content-hashed, but `pagefind-entry.json` keeps a stable name while its contents
change every build — cached hard, docs search would go on answering from last
week's index.

Cache lifetimes are set per object **at upload time**, and `aws s3 sync` skips
files it considers unchanged, so it will not revisit an object just to correct
its metadata. Each pass therefore has to own a disjoint slice of the tree, or
the first pass to touch a file decides its `Cache-Control` permanently. If you
add a pass, check the includes and excludes still partition `dist/` exactly.

## The download page needs no deploy

Download links are fetched from the GitHub Releases API **in the visitor's
browser**, not at build time. Cutting a release therefore updates the site
without redeploying it.

The response is cached in `localStorage` for an hour, because the anonymous
GitHub API allows 60 requests per hour per IP and a shared network can exhaust
that between them. If the request fails for any reason, the page falls back to a
link to the releases page rather than showing nothing.

## Screenshots

The images under `apps/site/public/screenshots/` are captured from the real app
and committed. Regenerate them after a UI change:

```bash
pnpm site:screenshots
```

It serves the desktop app's web build with a stubbed IPC, drives it into each
state, and photographs it with headless Chrome. See
[`apps/site/scripts/screenshots/`](../apps/site/scripts/screenshots/).

## What is deliberately absent

No analytics, no tag manager, no fonts loaded from a third party, no newsletter
embed. The product's argument is that it does not phone home, and the website
would undercut it. Keep it that way.
