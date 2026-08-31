import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

/**
 * theopennote.com.
 *
 * Static output only: the deploy target is an object store behind a CDN, so
 * there is nothing to run. `astro build` writes plain HTML, CSS and a little JS
 * to `dist/`, and that directory is the whole website.
 *
 * The marketing pages are hand-built Astro in `src/pages`; `/docs` is Starlight,
 * which brings a sidebar, search and mobile navigation that would otherwise have
 * to be written and maintained here. Custom pages take precedence over
 * Starlight's routes, so the two coexist without fighting.
 */
export default defineConfig({
  site: 'https://theopennote.com',
  output: 'static',
  // Astro's default directory format (`features/index.html`). It is what
  // Starlight is built around, and what an S3 *website* endpoint serves without
  // help. This deploys behind CloudFront's REST origin instead, so a CloudFront
  // Function does the rewrite — see docs/DEPLOYING-SITE.md.
  integrations: [
    sitemap(),
    starlight({
      title: 'Open Note',
      description: 'Markdown notes, backed by Git.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/RightStackUK/open-note' },
      ],
      customCss: ['./src/styles/tokens.css', './src/styles/starlight.css'],
      // The marketing header is the site's own; Starlight only owns /docs.
      disable404Route: true,
      credits: false,
      editLink: {
        baseUrl: 'https://github.com/RightStackUK/open-note/edit/main/apps/site/',
      },
      sidebar: [
        { label: 'Getting started', slug: 'docs/getting-started' },
        { label: 'Sync', slug: 'docs/sync' },
        { label: 'Conflicts', slug: 'docs/conflicts' },
        { label: 'Keyboard shortcuts', slug: 'docs/shortcuts' },
        { label: 'Diagrams', slug: 'docs/diagrams' },
        { label: 'Files and folders', slug: 'docs/files' },
      ],
    }),
  ],
});
