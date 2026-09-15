import { describe, expect, it } from 'vitest';

import { enexFolderName, enexSourceNote, enexTimestamp } from './enex';
import { NameAllocator } from './names';
import { describeImport, planNote, type SourceNote } from './pipeline';

function source(overrides: Partial<SourceNote> = {}): SourceNote {
  return {
    title: 'A note',
    html: '<en-note><div>Hello</div></en-note>',
    tags: [],
    created: null,
    updated: null,
    sourceUrl: null,
    resources: [],
    ...overrides,
  };
}

function plan(note: SourceNote, attachmentFolder = 'assets', folder = 'Inbox') {
  return planNote(note, { folder, attachmentFolder, names: new NameAllocator() });
}

describe('planNote', () => {
  it('writes the note where the notebook says, with what the source knew', () => {
    const planned = plan(
      source({
        title: 'A note',
        tags: ['work', 'reading'],
        created: '2024-01-15T09:30:00Z',
        sourceUrl: 'https://example.com/page',
      }),
    );

    expect(planned.path).toBe('Inbox/A note.md');
    expect(planned.markdown).toBe(
      [
        '---',
        'created: "2024-01-15T09:30:00Z"',
        'source: "https://example.com/page"',
        'tags:',
        '  - work',
        '  - reading',
        '---',
        '',
        'Hello',
        '',
      ].join('\n'),
    );
  });

  it('keeps the original title only when the filename could not carry it', () => {
    expect(plan(source({ title: 'Plans' })).markdown).not.toContain('title:');
    expect(plan(source({ title: 'Q1: plans/ideas' })).markdown).toContain(
      'title: "Q1: plans/ideas"',
    );
  });

  it('turns Evernote checkboxes into the task syntax the app reads', () => {
    const planned = plan(
      source({
        html:
          '<en-note><div><en-todo checked="false"/>Buy milk</div>' +
          '<div><en-todo checked="true"/>Call Ann</div></en-note>',
      }),
    );

    // One tight list: Evernote writes a line per `<div>`, and left alone the
    // conversion puts a paragraph between every item of a checklist.
    expect(planned.markdown).toContain('- [ ] Buy milk\n- [x] Call Ann');
  });

  it('resolves an image reference to the file it wrote', () => {
    const planned = plan(
      source({
        html: '<en-note><en-media hash="ABC123" type="image/png"/></en-note>',
        resources: [{ hash: 'abc123', mime: 'image/png', fileName: 'Scan 1.png', size: 10 }],
      }),
    );

    expect(planned.assets).toEqual([{ hash: 'abc123', path: 'assets/Scan-1.png' }]);
    // The alt text keeps the name the export gave it; the path is
    // note-relative, and has no space in it to escape.
    expect(planned.markdown).toContain('![Scan 1](../assets/Scan-1.png)');
  });

  it('links a resource that is not an image', () => {
    const planned = plan(
      source({
        html: '<en-note><en-media hash="f1" type="application/pdf"/></en-note>',
        resources: [{ hash: 'f1', mime: 'application/pdf', fileName: 'Invoice.pdf', size: 10 }],
      }),
    );

    expect(planned.markdown).toContain('[Invoice.pdf](../assets/Invoice.pdf)');
  });

  it('honours a vault that keeps attachments beside the note', () => {
    const planned = plan(
      source({
        html: '<en-note><en-media hash="f1" type="image/png"/></en-note>',
        resources: [{ hash: 'f1', mime: 'image/png', fileName: 'shot.png', size: 10 }],
      }),
      '.',
    );

    expect(planned.assets[0]?.path).toBe('Inbox/shot.png');
    expect(planned.markdown).toContain('](shot.png)');
  });

  it('names a resource the export did not name, from its type', () => {
    const planned = plan(
      source({
        title: 'Receipts',
        html: '<en-note><en-media hash="f1" type="image/jpeg"/></en-note>',
        resources: [{ hash: 'f1', mime: 'image/jpeg', fileName: null, size: 10 }],
      }),
    );

    expect(planned.assets[0]?.path).toBe('assets/Receipts.jpg');
  });

  it('carries a repeated resource once and points both references at it', () => {
    const planned = plan(
      source({
        html: '<en-note><en-media hash="f1" type="image/png"/><en-media hash="f1" type="image/png"/></en-note>',
        resources: [
          { hash: 'f1', mime: 'image/png', fileName: 'logo.png', size: 10 },
          { hash: 'f1', mime: 'image/png', fileName: 'logo.png', size: 10 },
        ],
      }),
    );

    expect(planned.assets).toHaveLength(1);
    expect(planned.markdown.match(/logo\.png/g)).toHaveLength(2);
  });

  it('reports a reference the export did not carry rather than dropping it quietly', () => {
    const planned = plan(
      source({ html: '<en-note><en-media hash="gone" type="image/png"/></en-note>' }),
    );

    expect(planned.warnings).toEqual([
      { note: 'A note', reason: 'an attachment was missing from the export' },
    ]);
  });

  it('marks an encrypted block in the note and in the summary', () => {
    const planned = plan(
      source({ html: '<en-note><div>Before</div><en-crypt>xxx</en-crypt></en-note>' }),
    );

    expect(planned.markdown).toContain('*[encrypted in Evernote — not importable]*');
    expect(planned.warnings[0]?.reason).toContain('1 encrypted block');
  });

  it('links an attachment the body never referenced', () => {
    const planned = plan(
      source({ resources: [{ hash: 'f1', mime: 'image/png', fileName: 'stray.png', size: 10 }] }),
    );

    expect(planned.markdown).toContain('## Attachments');
    expect(planned.markdown).toContain('- ![stray](../assets/stray.png)');
  });

  it('shares one allocator, so two notes of one name become two files', () => {
    const names = new NameAllocator(['Inbox/Ideas.md']);
    const options = { folder: 'Inbox', attachmentFolder: 'assets', names };

    expect(planNote(source({ title: 'Ideas' }), options).path).toBe('Inbox/Ideas 2.md');
    expect(planNote(source({ title: 'ideas' }), options).path).toBe('Inbox/ideas 3.md');
  });

  it('tidies the blank space the source drew its gaps with', () => {
    // Apple Notes draws a gap as `<div><br></div>`, which converts to a line
    // of two spaces — nothing in Markdown, noise in a diff, and gone the first
    // time an editor strips trailing whitespace, which would make the next
    // edit of the note a whole-file diff.
    const planned = plan(
      source({
        html: '<div>One</div><div><br></div><div><br></div><div><br></div><div>Two</div>',
      }),
    );

    expect(planned.markdown).toBe('One\n\nTwo\n');
  });

  it('leaves blank lines inside a code block alone', () => {
    const planned = plan(source({ html: '<pre><code>one\n\n\ntwo</code></pre>' }));

    expect(planned.markdown).toContain('one\n\n\ntwo');
  });

  it('keeps a hard line break, which is content rather than spacing', () => {
    const planned = plan(source({ html: '<div>One<br>Two</div>' }));
    expect(planned.markdown).toContain('One  \nTwo');
  });

  it('still creates a note whose body was empty', () => {
    const planned = plan(source({ title: 'Blank', html: '<en-note></en-note>' }));

    expect(planned.path).toBe('Inbox/Blank.md');
    expect(planned.markdown.trim()).toBe('');
  });
});

describe('describeImport', () => {
  it('counts what landed', () => {
    expect(describeImport({ notes: 12, attachments: 3, warnings: [], cancelled: false })).toBe(
      'Imported 12 notes and 3 attachments.',
    );
  });

  it('says when it was stopped, and counts what was left behind', () => {
    // Counted, not listed: the dialog names them underneath, and a sentence
    // that tried to name hundreds is a sentence nobody reads.
    const message = describeImport({
      notes: 1,
      attachments: 0,
      warnings: [
        { note: 'a', reason: '1 encrypted block could not be decrypted' },
        { note: 'b', reason: '1 encrypted block could not be decrypted' },
      ],
      cancelled: true,
    });

    expect(message).toBe('Stopped after importing 1 note. 2 things could not be carried across:');
  });
});

describe('enex', () => {
  it('rewrites Evernote timestamps into the spelling the app writes', () => {
    expect(enexTimestamp('20240115T093000Z')).toBe('2024-01-15T09:30:00Z');
    expect(enexTimestamp('2024-01-15T09:30:00Z')).toBe('2024-01-15T09:30:00Z');
  });

  it('refuses to guess at a date it cannot read', () => {
    expect(enexTimestamp('last Tuesday')).toBeNull();
    expect(enexTimestamp(null)).toBeNull();
  });

  it('takes the notebook name from the file, which is the only record of it', () => {
    expect(enexFolderName('/Users/me/Downloads/Work: 2024.enex')).toBe('Work-2024');
  });

  it('adapts a scanned note to what the pipeline consumes', () => {
    const adapted = enexSourceNote({
      title: '  Spaced  ',
      content: '<en-note/>',
      created: '20240115T093000Z',
      updated: null,
      tags: ['work', ' '],
      sourceUrl: '',
      resources: [{ hash: 'AB', mime: 'image/png', fileName: 'a.png', size: 1 }],
    });

    expect(adapted.title).toBe('Spaced');
    expect(adapted.created).toBe('2024-01-15T09:30:00Z');
    expect(adapted.tags).toEqual(['work']);
    expect(adapted.sourceUrl).toBeNull();
    expect(adapted.resources[0]?.hash).toBe('ab');
  });
});
