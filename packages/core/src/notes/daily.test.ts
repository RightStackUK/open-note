import { describe, expect, it } from 'vitest';

import { dailyNotePath, dailyNoteTemplate, localIsoDate } from './daily';

describe('localIsoDate', () => {
  it('formats a date', () => {
    expect(localIsoDate(new Date(2026, 7, 29))).toBe('2026-08-29');
  });

  it('zero-pads months and days', () => {
    expect(localIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('uses local time, not UTC', () => {
    // Late evening local time must not roll over into tomorrow.
    const evening = new Date(2026, 7, 29, 23, 30);
    expect(localIsoDate(evening)).toBe('2026-08-29');
  });
});

describe('dailyNotePath', () => {
  it('puts the note in the configured folder', () => {
    expect(dailyNotePath(new Date(2026, 7, 29))).toBe('daily/2026-08-29.md');
  });

  it('honours a custom folder', () => {
    expect(
      dailyNotePath(new Date(2026, 7, 29), { folder: 'journal', dateFormat: 'YYYY-MM-DD' }),
    ).toBe('journal/2026-08-29.md');
  });

  it('supports a nested folder', () => {
    expect(
      dailyNotePath(new Date(2026, 7, 29), { folder: 'notes/daily', dateFormat: 'YYYY-MM-DD' }),
    ).toBe('notes/daily/2026-08-29.md');
  });

  it('places the note at the root when the folder is empty', () => {
    expect(dailyNotePath(new Date(2026, 7, 29), { folder: '', dateFormat: 'YYYY-MM-DD' })).toBe(
      '2026-08-29.md',
    );
  });

  it('tolerates stray slashes in the folder setting', () => {
    expect(
      dailyNotePath(new Date(2026, 7, 29), { folder: '/daily/', dateFormat: 'YYYY-MM-DD' }),
    ).toBe('daily/2026-08-29.md');
  });
});

describe('dailyNoteTemplate', () => {
  it('starts the note with the date as a heading', () => {
    expect(dailyNoteTemplate(new Date(2026, 7, 29))).toBe('# 2026-08-29\n\n');
  });
});
