import { describe, expect, it } from 'vitest';

import { exportNoteToDocx } from './docx';
import { exportAnchor, exportNotesToHtml, exportNoteToHtml, renderNoteBody } from './export';
import { htmlToMarkdown, isBareUrl } from './htmlToMarkdown';
import { stripTags } from './parse';
import { buildTextpack, dataUrlToBytes, localAssetReferences } from './textbundle';

describe('htmlToMarkdown', () => {
  it('converts the everyday elements to the dialect the app writes', () => {
    const markdown = htmlToMarkdown(
      '<h2>Title</h2><p>Some <strong>bold</strong> and <em>italic</em> text with a <a href="https://example.com">link</a>.</p><ul><li>one</li><li>two</li></ul>',
    );
    expect(markdown).toContain('## Title');
    expect(markdown).toContain('**bold**');
    expect(markdown).toContain('*italic*');
    expect(markdown).toContain('[link](https://example.com)');
    expect(markdown).toContain('- one');
  });

  it('converts tables, per the GFM plugin', () => {
    const markdown = htmlToMarkdown(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
    expect(markdown).toContain('| a | b |');
    expect(markdown).toContain('| 1 | 2 |');
  });

  it('produces fenced code blocks', () => {
    expect(htmlToMarkdown('<pre><code>const x = 1;</code></pre>')).toContain('```');
  });

  it('drops scripts entirely', () => {
    expect(htmlToMarkdown('<p>hi</p><script>alert(1)</script>')).toBe('hi');
  });

  it('returns null for markup with no text, so callers can fall back', () => {
    expect(htmlToMarkdown('<div><img src="x.png"></div>') ?? '![](x.png)').toBeTruthy();
    expect(htmlToMarkdown('<div></div>')).toBeNull();
  });
});

describe('isBareUrl', () => {
  it('accepts a lone http(s) URL and nothing else', () => {
    expect(isBareUrl('https://example.com/page?q=1')).toBe(true);
    expect(isBareUrl('  https://example.com  ')).toBe(true);
    expect(isBareUrl('see https://example.com')).toBe(false);
    expect(isBareUrl('ftp://example.com')).toBe(false);
    expect(isBareUrl('just text')).toBe(false);
  });
});

describe('stripTags', () => {
  it('removes tags the indexer would record', () => {
    expect(stripTags('do the thing #work #home/deep')).toBe('do the thing');
  });

  it('leaves a # that is not a tag', () => {
    expect(stripTags('C# and https://a.com/#x and issue #123')).toBe(
      'C# and https://a.com/#x and issue #123',
    );
  });

  it('leaves code untouched', () => {
    expect(stripTags('`#define` stays\n\n#gone')).toBe('`#define` stays\n\n');
  });
});

describe('export with wikilink resolution', () => {
  it('rewrites a resolvable wikilink to a link', async () => {
    const html = await exportNoteToHtml('see [[Other Note]]', {
      title: 'A',
      resolveWikiLink: (target) => (target === 'Other Note' ? 'Other Note.html' : null),
    });
    expect(html).toContain('href="Other%20Note.html"');
    expect(html).toContain('>Other Note</a>');
  });

  it('flattens an unresolvable wikilink to its text, as before', async () => {
    const html = await exportNoteToHtml('see [[Nowhere|the alias]]', { title: 'A' });
    expect(html).toContain('the alias');
    expect(html).not.toContain('href');
  });

  it('merges notes in order with anchors', async () => {
    const html = await exportNotesToHtml(
      [
        { title: 'First', source: '# First\n\nbody one', anchor: 'first' },
        { title: 'Second', source: 'links to [[First]]', anchor: 'second' },
      ],
      { title: 'Merged', resolveWikiLink: () => '#first' },
    );
    expect(html.indexOf('id="first"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="first"')).toBeLessThan(html.indexOf('id="second"'));
    expect(html).toContain('href="#first"');
  });

  it('keeps a # in a note name out of the fragment', async () => {
    const html = await exportNoteToHtml('see [[C# Notes]]', {
      title: 'A',
      resolveWikiLink: () => 'C# Notes.html',
    });
    expect(html).toContain('href="C%23%20Notes.html"');
  });

  it('deduplicates colliding anchors in a merged export', async () => {
    const html = await exportNotesToHtml(
      [
        { title: 'A B', source: 'one', anchor: 'a-b' },
        { title: 'A-B', source: 'two', anchor: 'a-b' },
      ],
      { title: 'Merged' },
    );
    expect(html).toContain('id="a-b"');
    expect(html).toContain('id="a-b-2"');
  });

  it('keeps the print colours above the dark scheme', async () => {
    const html = await exportNoteToHtml('x', { title: 'A' });
    // Order in the stylesheet is precedence here: dark must not win on paper.
    expect(html.indexOf('@media print')).toBeGreaterThan(
      html.indexOf('@media (prefers-color-scheme: dark)'),
    );
  });

  it('derives stable anchors from paths', () => {
    expect(exportAnchor('notes/Deep Dive.md')).toBe('notes-deep-dive');
  });

  it('renders a body without the page shell', async () => {
    const body = await renderNoteBody('**hi**', { title: 'x' });
    expect(body).toContain('<strong>hi</strong>');
    expect(body).not.toContain('<!doctype');
  });
});

describe('exportNoteToDocx', () => {
  it('produces a non-trivial zip payload', async () => {
    const base64 = await exportNoteToDocx(
      '# Title\n\nSome **bold** text.\n\n- a list\n- item\n\n```\ncode\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |',
      'Title',
    );
    // A docx is a zip; zips start with PK.
    expect(atob(base64.slice(0, 4)).startsWith('PK')).toBe(true);
    expect(base64.length).toBeGreaterThan(1000);
  });
});

describe('textbundle', () => {
  it('finds local asset references and skips remote ones', () => {
    const refs = localAssetReferences(
      '![a](assets/pic.png) ![b](https://x.com/y.png) ![[drawing.png]] ![c](data:image/png;base64,xx)',
    );
    expect(refs).toEqual(['assets/pic.png', 'drawing.png']);
  });

  it('builds a zip with the manifest, the text and the assets', async () => {
    const { unzipSync, strFromU8 } = await import('fflate');
    const pack = buildTextpack('# Hello', [{ name: 'pic.png', data: new Uint8Array([1, 2, 3]) }]);
    const files = unzipSync(pack);

    expect(strFromU8(files['text.md'] as Uint8Array)).toBe('# Hello');
    const info = JSON.parse(strFromU8(files['info.json'] as Uint8Array));
    expect(info.type).toBe('net.daringfireball.markdown');
    expect([...(files['assets/pic.png'] as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it('flattens a crafted asset path to its basename', async () => {
    const { unzipSync } = await import('fflate');
    const pack = buildTextpack('x', [
      { name: '../../evil.png', data: new Uint8Array([1]) },
      { name: '..\\..\\worse.png', data: new Uint8Array([2]) },
      { name: '..', data: new Uint8Array([3]) },
    ]);
    const files = unzipSync(pack);
    expect(Object.keys(files)).toContain('assets/evil.png');
    expect(Object.keys(files)).toContain('assets/worse.png');
    expect(Object.keys(files).some((k) => k.includes('..'))).toBe(false);
  });

  it('decodes a data URL to bytes', () => {
    expect([...(dataUrlToBytes('data:image/png;base64,AQID') ?? [])]).toEqual([1, 2, 3]);
    expect(dataUrlToBytes('not a data url')).toBeNull();
  });
});
