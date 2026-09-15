import { describe, expect, it } from 'vitest';

import {
  type AppleNoteBody,
  type AppleNoteRef,
  appleNotesDate,
  appleNotesFolder,
  appleNotesSourceNote,
  appleNotesWarnings,
  isRecentlyDeleted,
} from './appleNotes';
import { NameAllocator } from './names';
import { planNote } from './pipeline';

/** A 1×1 transparent GIF, so the fixture carries real base64. */
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function ref(overrides: Partial<AppleNoteRef> = {}): AppleNoteRef {
  return {
    id: 'x-coredata://ABC/ICNote/p1',
    name: 'Shopping',
    locked: false,
    created: '2026-03-29T20:55:05.000Z',
    modified: '2026-03-29T20:55:08.000Z',
    ...overrides,
  };
}

function body(overrides: Partial<AppleNoteBody> = {}): AppleNoteBody {
  return {
    id: 'x-coredata://ABC/ICNote/p1',
    body: '<div><h1>Shopping</h1></div><div>Milk</div>',
    attachments: [],
    error: null,
    ...overrides,
  };
}

describe('the trash is never imported', () => {
  it('knows the folder by name, in the languages it can', () => {
    expect(isRecentlyDeleted('Recently Deleted')).toBe(true);
    expect(isRecentlyDeleted('recently deleted')).toBe(true);
    expect(isRecentlyDeleted('最近削除した項目')).toBe(true);
    // Nested under it counts too.
    expect(isRecentlyDeleted('Recently Deleted/Work')).toBe(true);
  });

  it('does not mistake an ordinary folder for it', () => {
    expect(isRecentlyDeleted('Deleted scenes')).toBe(false);
    expect(isRecentlyDeleted('Notes')).toBe(false);
  });
});

describe('folders become directories', () => {
  it('keeps the hierarchy and sanitises each level on its own', () => {
    expect(appleNotesFolder('Work/Q1: plans')).toBe('Work/Q1-plans');
    // A `/` inside one folder's name must not become a second level.
    expect(appleNotesFolder('Reading / Writing')).toBe('Reading/Writing');
  });
});

describe('dates', () => {
  it('drops the milliseconds JXA adds, so the vault writes one shape', () => {
    expect(appleNotesDate('2026-03-29T20:55:05.000Z')).toBe('2026-03-29T20:55:05Z');
  });

  it('refuses to guess at an unreadable date', () => {
    expect(appleNotesDate('whenever')).toBeNull();
    expect(appleNotesDate(null)).toBeNull();
  });
});

describe('what cannot come across is named', () => {
  it('reports a locked note rather than importing an empty one', () => {
    const locked = ref({ name: 'Passwords', locked: true });
    expect(appleNotesSourceNote(locked, body({ body: null, error: 'locked' }))).toBeNull();
    expect(appleNotesWarnings(locked, body({ body: null, error: 'locked' }))).toEqual([
      { note: 'Passwords', reason: 'locked in Apple Notes, so it could not be read' },
    ]);
  });

  it('names a non-image attachment, because those cannot be exported at all', () => {
    const warnings = appleNotesWarnings(ref(), body({ attachments: ['Invoice.pdf', 'Shot.png'] }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reason).toContain('“Invoice.pdf” stayed in Apple Notes');
  });

  it('says nothing about images, which do come across', () => {
    expect(appleNotesWarnings(ref(), body({ attachments: ['Shot.png', 'photo.HEIC'] }))).toEqual(
      [],
    );
  });
});

describe('a fetched note, planned', () => {
  const plan = (note: AppleNoteRef, content: AppleNoteBody, folder = 'Notes') => {
    const source = appleNotesSourceNote(note, content);
    if (!source) throw new Error('expected a source note');
    return planNote(source, {
      folder,
      attachmentFolder: 'assets',
      names: new NameAllocator(),
    });
  };

  it('writes the note with the dates Notes recorded', () => {
    const planned = plan(ref(), body());

    expect(planned.path).toBe('Notes/Shopping.md');
    expect(planned.markdown).toContain('created: "2026-03-29T20:55:05Z"');
    expect(planned.markdown).toContain('updated: "2026-03-29T20:55:08Z"');
    expect(planned.markdown).toContain('# Shopping');
  });

  it('pulls an inline image out of the body and into a file', () => {
    // This is the shape Apple Notes really emits: a data URL in the body,
    // which is the only way an attachment can be got out of it at all.
    const planned = plan(
      ref({ name: 'Screenshots' }),
      body({
        body: `<div><h1>Screenshots</h1></div><div><img style="max-width: 100%;" src="data:image/gif;base64,${GIF}"></div>`,
        attachments: ['Screenshot 2026-01-23 at 09.53.37.png'],
      }),
    );

    expect(planned.inline).toEqual([{ path: 'assets/Screenshots.gif', base64: GIF }]);
    expect(planned.markdown).toContain('![Screenshots](../assets/Screenshots.gif)');
    // And no megabyte of base64 left in a file people have to read and diff.
    expect(planned.markdown).not.toContain('base64');
  });

  it('numbers several images in the order the note has them', () => {
    const planned = plan(
      ref({ name: 'Trip' }),
      body({
        body:
          `<div><img src="data:image/gif;base64,${GIF}"></div>` +
          `<div><img src="data:image/png;base64,${GIF}"></div>`,
      }),
    );

    expect(planned.inline.map((asset) => asset.path)).toEqual([
      'assets/Trip.gif',
      'assets/Trip-2.png',
    ]);
  });

  it('keeps a checklist a checklist, whichever way it is drawn', () => {
    // Which of these Apple Notes emits is not documented and differs by
    // release, so every plausible shape lands as the GFM checkbox the task
    // view reads. An `<input>` in a list is what the GFM plugin already
    // handles; the other two silently became plain bullets.
    const shapes = [
      '<ul><li><input type="checkbox" checked>Done</li><li><input type="checkbox">Todo</li></ul>',
      '<ul class="checklist"><li class="checklist-item checked">Done</li><li class="checklist-item">Todo</li></ul>',
      '<ul><li checked="checked">Done</li><li checked="false">Todo</li></ul>',
    ];
    for (const shape of shapes) {
      const planned = plan(ref({ name: 'Tasks' }), body({ body: shape }));
      expect(planned.markdown, shape).toContain('- [x] Done');
      expect(planned.markdown, shape).toContain('- [ ] Todo');
    }
  });

  it('leaves an ordinary list alone', () => {
    const planned = plan(ref(), body({ body: '<ul><li>Milk</li><li>Bread</li></ul>' }));
    expect(planned.markdown).toContain('- Milk');
    expect(planned.markdown).not.toContain('[ ]');
  });

  it('converts the markup Notes actually emits', () => {
    // Taken from a real note's structure: a heading in a div, empty divs for
    // spacing, and nested lists emitted as `<ul>` siblings of `<li>` rather
    // than children — which is invalid HTML, and what Notes sends.
    const planned = plan(
      ref({ name: 'Plans' }),
      body({
        body:
          '<div><h1>Plans</h1></div><div><br></div><div>Groceries</div>' +
          '<ul><li>Milk</li><ul><li>Whole</li></ul><li>Bread</li></ul>' +
          '<div><br></div><table><tr><th>Item</th><th>Cost</th></tr><tr><td>Milk</td><td>2</td></tr></table>',
      }),
    );

    expect(planned.markdown).toContain('# Plans');
    expect(planned.markdown).toContain('- Milk');
    expect(planned.markdown).toContain('- Bread');
    // Tables have a real GFM equivalent, and the plugin is already enabled.
    expect(planned.markdown).toContain('| Item | Cost |');
    expect(planned.markdown).toContain('| Milk | 2 |');
  });
});
