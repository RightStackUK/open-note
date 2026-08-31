/**
 * Turning a GitHub releases feed into download buttons.
 *
 * The site is static, so this runs in the visitor's browser rather than at build
 * time. That is deliberate: a build-time fetch would freeze the version at
 * whenever the site was last deployed, and the download page would quietly go
 * stale every time a release is cut.
 */

export const REPO = 'RightStackUK/open-note';
export const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  tag_name: string;
  name?: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  html_url: string;
  assets: ReleaseAsset[];
}

export type PlatformId = 'macos' | 'windows' | 'linux';

export interface Download {
  /** Shown on the button, e.g. `.dmg`. */
  label: string;
  /** What the file is for, when a platform offers more than one. */
  note: string;
  url: string;
  size: number;
}

export interface PlatformDownloads {
  id: PlatformId;
  name: string;
  downloads: Download[];
}

/**
 * Which release the download page should offer.
 *
 * `/releases/latest` cannot be used: GitHub excludes pre-releases from it, and
 * while the project has only ever tagged pre-releases that endpoint returns 404.
 * A stable release always wins; a pre-release is offered only when there is no
 * stable one at all, which is the honest thing to show rather than an empty page.
 */
export function pickRelease(releases: Release[]): Release | null {
  const usable = releases.filter((release) => !release.draft && release.assets.length > 0);
  const byDate = (a: Release, b: Release) =>
    new Date(b.published_at).getTime() - new Date(a.published_at).getTime();

  const stable = usable.filter((release) => !release.prerelease).sort(byDate);
  if (stable.length > 0) return stable[0] ?? null;

  const pre = usable.filter((release) => release.prerelease).sort(byDate);
  return pre[0] ?? null;
}

/** Extension to the label and explanation shown beside it, per platform. */
const MATCHERS: Array<{
  id: PlatformId;
  name: string;
  files: Array<{ extension: string; label: string; note: string }>;
}> = [
  {
    id: 'macos',
    name: 'macOS',
    files: [
      { extension: '.dmg', label: 'Download .dmg', note: 'Universal — Apple silicon and Intel' },
    ],
  },
  {
    id: 'windows',
    name: 'Windows',
    files: [
      { extension: '.exe', label: 'Download .exe', note: 'Installer — recommended' },
      { extension: '.msi', label: 'Download .msi', note: 'For managed deployment' },
    ],
  },
  {
    id: 'linux',
    name: 'Linux',
    files: [
      {
        extension: '.appimage',
        label: 'Download .AppImage',
        note: 'Runs anywhere — chmod +x and go',
      },
      { extension: '.deb', label: 'Download .deb', note: 'Debian, Ubuntu' },
      { extension: '.rpm', label: 'Download .rpm', note: 'Fedora, RHEL, openSUSE' },
    ],
  },
];

/**
 * Group a release's assets by platform.
 *
 * Matching is by extension rather than by filename, because the filenames carry
 * the version (`Open.Note_0.1.0_universal.dmg`) and would need changing here on
 * every release. A platform with no matching asset is omitted rather than shown
 * with a dead button — a pre-release ships no `.msi`, and that is expected.
 */
export function downloadsFor(release: Release): PlatformDownloads[] {
  return MATCHERS.map((platform) => ({
    id: platform.id,
    name: platform.name,
    downloads: platform.files.flatMap(({ extension, label, note }) => {
      const asset = release.assets.find((a) => a.name.toLowerCase().endsWith(extension));
      return asset ? [{ label, note, url: asset.browser_download_url, size: asset.size }] : [];
    }),
  })).filter((platform) => platform.downloads.length > 0);
}

/** Best guess at the visitor's platform, so their download can be offered first. */
export function detectPlatform(userAgent: string): PlatformId | null {
  const ua = userAgent.toLowerCase();
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'macos';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('linux') || ua.includes('x11')) return 'linux';
  return null;
}

/** Put the visitor's own platform first, keeping the rest in their usual order. */
export function orderForVisitor(
  platforms: PlatformDownloads[],
  detected: PlatformId | null,
): PlatformDownloads[] {
  if (!detected) return platforms;
  const mine = platforms.filter((p) => p.id === detected);
  const rest = platforms.filter((p) => p.id !== detected);
  return [...mine, ...rest];
}

/** Sizes people can read: releases run from a few MB to nearly a hundred. */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** `v0.2.0-beta.1` reads better as `0.2.0-beta.1` next to the word "version". */
export function versionOf(release: Release): string {
  return release.tag_name.replace(/^v/, '');
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
