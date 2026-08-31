import { describe, expect, it } from 'vitest';

import { exportNoteToHtml } from './export';

describe('exportNoteToHtml', () => {
  it('renders markdown to a full HTML page', async () => {
    const html = await exportNoteToHtml('# Title\n\nSome **bold** text.', { title: 'Title' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('uses the title in the page title', async () => {
    const html = await exportNoteToHtml('body', { title: 'My Note' });
    expect(html).toContain('<title>My Note</title>');
  });

  it('escapes a title containing markup', async () => {
    const html = await exportNoteToHtml('body', { title: '<script>x</script>' });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<title><script>');
  });

  it('drops the frontmatter', async () => {
    const html = await exportNoteToHtml('---\ntags: [a]\n---\n# Body', { title: 'x' });
    expect(html).not.toContain('tags:');
    expect(html).toContain('<h1>Body</h1>');
  });

  it('turns a wikilink into plain text', async () => {
    // There is nothing for it to point at outside the vault.
    const html = await exportNoteToHtml('see [[Research]] now', { title: 'x' });
    expect(html).toContain('see Research now');
    expect(html).not.toContain('[[');
  });

  it('prefers a wikilink alias as the text', async () => {
    const html = await exportNoteToHtml('see [[research|the notes]]', { title: 'x' });
    expect(html).toContain('the notes');
  });

  it('renders GFM task lists', async () => {
    const html = await exportNoteToHtml('- [x] done\n- [ ] open', { title: 'x' });
    expect(html).toContain('type="checkbox"');
  });

  it('inlines a local image so the export stands alone', async () => {
    const html = await exportNoteToHtml('![alt](assets/a.png)', {
      title: 'x',
      resolveImage: async () => 'data:image/png;base64,AAAA',
    });
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain('assets/a.png');
  });

  it('leaves a remote image alone', async () => {
    const html = await exportNoteToHtml('![alt](https://example.com/a.png)', {
      title: 'x',
      resolveImage: async () => 'data:image/png;base64,AAAA',
    });
    expect(html).toContain('https://example.com/a.png');
  });

  it('keeps the reference when an image cannot be resolved', async () => {
    const html = await exportNoteToHtml('![alt](assets/missing.png)', {
      title: 'x',
      resolveImage: async () => null,
    });
    expect(html).toContain('assets/missing.png');
  });
});
