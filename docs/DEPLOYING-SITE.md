# Deploying theopennote.com

The website is a **static site**. There is no server, no Node process and no
build step at request time — `pnpm site:build` writes plain HTML, CSS, JS and
images to `apps/site/dist/`, and that directory *is* the website.

```bash
pnpm install
pnpm site:build          # → apps/site/dist
```

Upload the contents of `dist/` to any static host. Nothing about the site is
host-specific.

## S3 + CloudFront

The one thing worth getting right.

Astro emits **directory-style** pages: `/features` is `features/index.html`.
Something has to map a request for `/features` onto that file, and where that
happens depends on which S3 endpoint you point CloudFront at.

### Option A — the S3 *website* endpoint (simplest)

Enable **Static website hosting** on the bucket, set the index document to
`index.html` and the error document to `404.html`, then use the website endpoint
(`bucket.s3-website-region.amazonaws.com`) as CloudFront's origin, as a **custom
origin**.

S3 does the index-document resolution itself. Nothing else is needed.

The trade-off: a website endpoint is HTTP-only and public, so it cannot be locked
to CloudFront with Origin Access Control.

### Option B — the S3 REST endpoint with OAC (private bucket)

Keep the bucket private and attach a CloudFront Function on **viewer request**:

```js
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (!uri.includes('.')) {
    request.uri = uri + '/index.html';
  }

  return request;
}
```

Add a custom error response mapping **404 → `/404.html`** with a 404 status code.

## Cache headers

Astro fingerprints its own assets, so they can be cached hard. HTML must not be.

| Path | `Cache-Control` |
|---|---|
| `/_astro/*` | `public, max-age=31536000, immutable` |
| `/screenshots/*` | `public, max-age=604800` |
| `*.html`, `/` | `public, max-age=0, must-revalidate` |
| `/pagefind/*` | `public, max-age=604800` |

Invalidate `/*` on deploy, or just the HTML paths if you would rather not pay for
a full invalidation.

## A sketch of the upload

```bash
aws s3 sync apps/site/dist s3://$BUCKET --delete \
  --exclude '*.html' --cache-control 'public, max-age=31536000, immutable'

aws s3 sync apps/site/dist s3://$BUCKET --delete \
  --exclude '*' --include '*.html' \
  --cache-control 'public, max-age=0, must-revalidate'

aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*'
```

The two passes matter: the first would otherwise stamp `immutable` onto HTML and
leave visitors on a stale page until their browser cache expired.

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
