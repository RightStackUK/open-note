import { describe, expect, it } from 'vitest';

import {
  detectPlatform,
  downloadsFor,
  formatSize,
  orderForVisitor,
  pickRelease,
  type Release,
  versionOf,
} from './releases';

const asset = (name: string, size = 1024 * 1024) => ({
  name,
  browser_download_url: `https://example.test/${name}`,
  size,
});

const release = (over: Partial<Release> = {}): Release => ({
  tag_name: 'v1.0.0',
  draft: false,
  prerelease: false,
  published_at: '2026-08-01T00:00:00Z',
  html_url: 'https://example.test/release',
  assets: [asset('Open.Note_1.0.0_universal.dmg')],
  ...over,
});

describe('pickRelease', () => {
  it('prefers the newest stable release', () => {
    const picked = pickRelease([
      release({ tag_name: 'v1.0.0', published_at: '2026-01-01T00:00:00Z' }),
      release({ tag_name: 'v1.2.0', published_at: '2026-06-01T00:00:00Z' }),
    ]);
    expect(picked?.tag_name).toBe('v1.2.0');
  });

  it('prefers a stable release over a newer pre-release', () => {
    const picked = pickRelease([
      release({ tag_name: 'v1.0.0', published_at: '2026-01-01T00:00:00Z' }),
      release({
        tag_name: 'v1.1.0-beta.1',
        prerelease: true,
        published_at: '2026-06-01T00:00:00Z',
      }),
    ]);
    expect(picked?.tag_name).toBe('v1.0.0');
  });

  it('falls back to a pre-release when nothing stable has shipped', () => {
    // The project's real state today, and the case that breaks
    // `/releases/latest`: GitHub omits pre-releases from it and returns 404.
    const picked = pickRelease([release({ tag_name: 'v0.0.1-test', prerelease: true })]);
    expect(picked?.tag_name).toBe('v0.0.1-test');
  });

  it('ignores drafts', () => {
    const picked = pickRelease([
      release({ tag_name: 'v2.0.0', draft: true, published_at: '2026-09-01T00:00:00Z' }),
      release({ tag_name: 'v1.0.0' }),
    ]);
    expect(picked?.tag_name).toBe('v1.0.0');
  });

  it('ignores a release whose build produced no assets', () => {
    expect(pickRelease([release({ assets: [] })])).toBeNull();
  });

  it('returns null when there is nothing to offer', () => {
    expect(pickRelease([])).toBeNull();
  });
});

describe('downloadsFor', () => {
  it('groups the real asset names a release produces', () => {
    const platforms = downloadsFor(
      release({
        assets: [
          asset('Open.Note-0.0.1-test-1.x86_64.rpm'),
          asset('Open.Note_0.0.1-test_amd64.AppImage'),
          asset('Open.Note_0.0.1-test_amd64.deb'),
          asset('Open.Note_0.0.1-test_universal.dmg'),
          asset('Open.Note_0.0.1-test_x64-setup.exe'),
        ],
      }),
    );

    expect(platforms.map((p) => p.id)).toEqual(['macos', 'windows', 'linux']);
    expect(platforms[0]?.downloads).toHaveLength(1);
    // No `.msi` on a pre-release, so Windows offers the installer alone rather
    // than a dead button.
    expect(platforms[1]?.downloads.map((d) => d.label)).toEqual(['Download .exe']);
    expect(platforms[2]?.downloads.map((d) => d.label)).toEqual([
      'Download .AppImage',
      'Download .deb',
      'Download .rpm',
    ]);
  });

  it('offers the msi as well on a stable release', () => {
    const platforms = downloadsFor(
      release({
        assets: [asset('Open.Note_1.0.0_x64-setup.exe'), asset('Open.Note_1.0.0_x64_en-US.msi')],
      }),
    );
    expect(platforms.map((p) => p.id)).toEqual(['windows']);
    expect(platforms[0]?.downloads).toHaveLength(2);
  });

  it('drops a platform the build did not produce', () => {
    const platforms = downloadsFor(release({ assets: [asset('Open.Note_1.0.0_universal.dmg')] }));
    expect(platforms.map((p) => p.id)).toEqual(['macos']);
  });
});

describe('detectPlatform', () => {
  it('recognises the three desktop platforms', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('gives up rather than guessing on a phone', () => {
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('macos');
    expect(detectPlatform('some unknown agent')).toBeNull();
  });
});

describe('orderForVisitor', () => {
  const platforms = downloadsFor(
    release({
      assets: [asset('a_universal.dmg'), asset('a_x64-setup.exe'), asset('a_amd64.AppImage')],
    }),
  );

  it('puts the visitor’s platform first', () => {
    expect(orderForVisitor(platforms, 'linux').map((p) => p.id)).toEqual([
      'linux',
      'macos',
      'windows',
    ]);
  });

  it('leaves the order alone when the platform is unknown', () => {
    expect(orderForVisitor(platforms, null).map((p) => p.id)).toEqual([
      'macos',
      'windows',
      'linux',
    ]);
  });
});

describe('formatting', () => {
  it('reads sizes the way a download dialog would', () => {
    expect(formatSize(12341703)).toBe('11.8 MB');
    expect(formatSize(81820152)).toBe('78.0 MB');
    expect(formatSize(0)).toBe('');
  });

  it('drops the leading v from a tag', () => {
    expect(versionOf(release({ tag_name: 'v0.2.0-beta.1' }))).toBe('0.2.0-beta.1');
  });
});
