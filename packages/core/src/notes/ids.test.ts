import { describe, expect, it } from 'vitest';
import { isNoteId, newNoteId, noteIdOf, noteLink, withNoteId, withoutNoteId } from './ids';
import { splitFrontmatter } from './parse';

/** A deterministic "random" source, so the shape can be asserted exactly. */
const bytes = (fill: number) => (buffer: Uint8Array) => buffer.fill(fill);

describe('minting', () => {
  it('is 24 lowercase hex characters', () => {
    expect(newNoteId(bytes(0xab))).toBe('ab'.repeat(12));
    expect(isNoteId(newNoteId())).toBe(true);
  });

  it('pads a low byte rather than shortening the id', () => {
    expect(newNoteId(bytes(0x01))).toBe('01'.repeat(12));
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newNoteId()));
    expect(seen.size).toBe(200);
  });

  it('rejects anything that is not an id', () => {
    // Hand-editable, and half an id is not an identity. `id: 42` parses as a
    // number, which is the likely accident.
    expect(isNoteId('')).toBe(false);
    expect(isNoteId('ABCDEF012345678901234567')).toBe(false);
    expect(isNoteId('ab'.repeat(11))).toBe(false);
    expect(isNoteId(42)).toBe(false);
    expect(isNoteId(null)).toBe(false);
  });

  it('reads an id out of frontmatter, and refuses a broken one', () => {
    const id = newNoteId(bytes(0x0f));
    expect(noteIdOf({ id })).toBe(id);
    expect(noteIdOf({ id: 42 })).toBeNull();
    expect(noteIdOf({})).toBeNull();
  });
});

describe('writing an id into a note', () => {
  const id = 'a'.repeat(24);

  it('gives a plain note the smallest possible block', () => {
    expect(withNoteId('# Title\n\nBody.\n', id)).toBe(`---\nid: ${id}\n---\n\n# Title\n\nBody.\n`);
  });

  it('leaves an existing block otherwise byte-for-byte', () => {
    // No YAML round-trip: reordering keys, restyling quotes or dropping a
    // comment would make "we copied a link" a rewrite of the reader's file.
    const source = `---\ntitle: "Quarterly Plan"\n# a comment\ntags: [a, b]\nreadOnly: true\n---\n\n# Plan\n`;
    const next = withNoteId(source, id);
    expect(next).toBe(
      `---\ntitle: "Quarterly Plan"\n# a comment\ntags: [a, b]\nreadOnly: true\nid: ${id}\n---\n\n# Plan\n`,
    );
  });

  it('parses back as frontmatter, with the other fields intact', () => {
    const source = `---\ntitle: Plan\nreadOnly: true\n---\n\nBody\n`;
    const { data, body } = splitFrontmatter(withNoteId(source, id));
    expect(data).toEqual({ title: 'Plan', readOnly: true, id });
    expect(body).toBe('\nBody\n');
  });

  it('replaces an id that is already there rather than adding a second', () => {
    const source = `---\nid: ${'b'.repeat(24)}\ntitle: Plan\n---\n\nBody\n`;
    const next = withNoteId(source, id);
    expect(next).toBe(`---\nid: ${id}\ntitle: Plan\n---\n\nBody\n`);
    expect(next.match(/^id:/gm)).toHaveLength(1);
  });

  it('is idempotent', () => {
    const once = withNoteId('# Title\n', id);
    expect(withNoteId(once, id)).toBe(once);
  });

  it("keeps the file's own line endings", () => {
    const source = '---\r\ntitle: Plan\r\n---\r\n\r\nBody\r\n';
    const next = withNoteId(source, id);
    expect(next).toContain(`\r\nid: ${id}\r\n`);
    expect(next).not.toMatch(/[^\r]\n/);
  });

  it('handles an empty note', () => {
    expect(withNoteId('', id)).toBe(`---\nid: ${id}\n---\n\n`);
  });
});

describe('stripping an id', () => {
  const id = 'c'.repeat(24);

  it('removes the whole block when the id was all it held', () => {
    expect(withoutNoteId(`---\nid: ${id}\n---\n\n# Title\n`)).toBe('# Title\n');
  });

  it('keeps the other fields', () => {
    const source = `---\ntitle: Plan\nid: ${id}\nreadOnly: true\n---\n\nBody\n`;
    expect(withoutNoteId(source)).toBe('---\ntitle: Plan\nreadOnly: true\n---\n\nBody\n');
  });

  it('leaves a note with no id alone', () => {
    const source = '---\ntitle: Plan\n---\n\nBody\n';
    expect(withoutNoteId(source)).toBe(source);
    expect(withoutNoteId('# No frontmatter\n')).toBe('# No frontmatter\n');
  });

  it('round-trips with writing', () => {
    const source = '---\ntitle: Plan\n---\n\nBody\n';
    expect(withoutNoteId(withNoteId(source, id))).toBe(source);
  });
});

describe('the link', () => {
  it('carries the vault as well as the id', () => {
    // An id is unique only within the vault that minted it, and the app can
    // have several open.
    const link = noteLink('/Users/me/My Notes', 'd'.repeat(24));
    expect(link).toBe(`opennote://open?vault=%2FUsers%2Fme%2FMy%20Notes&id=${'d'.repeat(24)}`);
    const url = new URL(link);
    expect(url.searchParams.get('vault')).toBe('/Users/me/My Notes');
  });
});
