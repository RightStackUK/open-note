import { describe, expect, it } from 'vitest';

import {
  extractHeadings,
  extractLinks,
  extractTags,
  extractTodos,
  noteTitle,
  parseNote,
  partialTagBefore,
  splitFrontmatter,
  toPlainText,
} from './parse';

describe('splitFrontmatter', () => {
  it('returns the whole source when there is no frontmatter', () => {
    const fm = splitFrontmatter('# Hello');
    expect(fm.data).toEqual({});
    expect(fm.body).toBe('# Hello');
  });

  it('parses a YAML header', () => {
    const fm = splitFrontmatter('---\ntitle: Ideas\nstarred: true\n---\n# Body');
    expect(fm.data).toEqual({ title: 'Ideas', starred: true });
    expect(fm.body).toBe('# Body');
  });

  it('parses list values', () => {
    const fm = splitFrontmatter('---\ntags:\n  - work\n  - urgent\n---\nbody');
    expect(fm.data.tags).toEqual(['work', 'urgent']);
  });

  it('survives malformed YAML rather than throwing', () => {
    // A broken header must never stop a note from opening.
    const fm = splitFrontmatter('---\n: : :\n  bad\n---\nbody');
    expect(fm.data).toEqual({});
    expect(fm.body).toBe('body');
  });

  it('ignores a horizontal rule that is not a header', () => {
    const fm = splitFrontmatter('Some text\n\n---\n\nMore text');
    expect(fm.body).toBe('Some text\n\n---\n\nMore text');
  });

  it('handles CRLF line endings', () => {
    const fm = splitFrontmatter('---\r\ntitle: Win\r\n---\r\nbody');
    expect(fm.data).toEqual({ title: 'Win' });
  });
});

describe('extractTags', () => {
  it('finds tags at the start of a line and after whitespace', () => {
    expect(extractTags('#work and #home')).toEqual(['work', 'home']);
  });

  it('supports nested tags', () => {
    expect(extractTags('#project/open-note')).toEqual(['project/open-note']);
  });

  it('does not treat a URL fragment as a tag', () => {
    expect(extractTags('see https://example.com/page#section')).toEqual([]);
  });

  it('does not treat a heading as a tag', () => {
    expect(extractTags('# Heading\n\nbody')).toEqual([]);
  });

  it('ignores tags inside inline code', () => {
    expect(extractTags('use `#define` in C')).toEqual([]);
  });

  it('ignores tags inside fenced code blocks', () => {
    expect(extractTags('```sh\n# a comment\necho "#nope"\n```\n\n#yes')).toEqual(['yes']);
  });

  it('does not produce a tag from a bare number', () => {
    expect(extractTags('issue #123')).toEqual([]);
  });

  it('deduplicates', () => {
    expect(extractTags('#a and #a again')).toEqual(['a']);
  });

  it('supports non-ASCII tags', () => {
    expect(extractTags('#günlük')).toEqual(['günlük']);
  });
});

describe('partialTagBefore', () => {
  it('finds a tag being typed at the start of a line', () => {
    expect(partialTagBefore('#wo')).toEqual({ start: 0, query: 'wo' });
  });

  it('finds a tag after whitespace', () => {
    expect(partialTagBefore('about #wo')).toEqual({ start: 6, query: 'wo' });
  });

  it('reports a bare # with an empty query', () => {
    expect(partialTagBefore('about #')).toEqual({ start: 6, query: '' });
  });

  it('finds a nested tag', () => {
    expect(partialTagBefore('#work/urg')).toEqual({ start: 0, query: 'work/urg' });
  });

  it('returns null mid-word, where a # is not a tag', () => {
    expect(partialTagBefore('I write C#')).toBeNull();
  });

  it('returns null in a URL fragment', () => {
    expect(partialTagBefore('https://example.com/page#sec')).toBeNull();
  });

  it('returns null with no # at all', () => {
    expect(partialTagBefore('just prose')).toBeNull();
  });

  it('returns null once a space ends the tag', () => {
    expect(partialTagBefore('#work and')).toBeNull();
  });

  it('returns null for a bare number, as extractTags does', () => {
    expect(partialTagBefore('issue #123')).toBeNull();
  });

  it('agrees with extractTags about what is a tag', () => {
    // The two must not disagree: completion offering a tag the indexer then
    // refuses to record is exactly the bug this shared rule prevents.
    const cases = ['#work', 'about #work', '(#work', 'C#work'];
    for (const text of cases) {
      const partial = partialTagBefore(text);
      const extracted = extractTags(text);
      expect(Boolean(partial)).toBe(extracted.length > 0);
      if (partial) expect(extracted).toContain(partial.query);
    }
  });
});

describe('extractLinks', () => {
  it('finds a plain wikilink', () => {
    expect(extractLinks('see [[Other Note]]')).toEqual([
      { target: 'Other Note', alias: null, heading: null },
    ]);
  });

  it('supports aliases', () => {
    expect(extractLinks('[[target|shown]]')).toEqual([
      { target: 'target', alias: 'shown', heading: null },
    ]);
  });

  it('supports heading fragments', () => {
    expect(extractLinks('[[note#Section]]')).toEqual([
      { target: 'note', alias: null, heading: 'Section' },
    ]);
  });

  it('supports a heading and an alias together', () => {
    expect(extractLinks('[[note#Section|see here]]')).toEqual([
      { target: 'note', alias: 'see here', heading: 'Section' },
    ]);
  });

  it('ignores links inside code', () => {
    expect(extractLinks('`[[not a link]]`')).toEqual([]);
  });

  it('deduplicates identical links', () => {
    expect(extractLinks('[[a]] and [[a]]')).toHaveLength(1);
  });

  it('keeps two links to the same note with different aliases', () => {
    expect(extractLinks('[[a|one]] and [[a|two]]')).toHaveLength(2);
  });
});

describe('extractTodos', () => {
  it('reads open and completed tasks', () => {
    const todos = extractTodos('- [ ] open\n- [x] done');
    expect(todos.map((t) => t.done)).toEqual([false, true]);
    expect(todos.map((t) => t.text)).toEqual(['open', 'done']);
  });

  it('accepts uppercase X', () => {
    expect(extractTodos('- [X] done')[0]?.done).toBe(true);
  });

  it('accepts * and + bullets', () => {
    expect(extractTodos('* [ ] a\n+ [ ] b')).toHaveLength(2);
  });

  it('reports 1-based line numbers', () => {
    const todos = extractTodos('intro\n\n- [ ] task');
    expect(todos[0]?.line).toBe(3);
  });

  it('reads a due date', () => {
    const todo = extractTodos('- [ ] ship it due:2026-09-15')[0];
    expect(todo?.due).toBe('2026-09-15');
    expect(todo?.text).toBe('ship it');
  });

  it('reads a priority', () => {
    const todo = extractTodos('- [ ] ship it prio:high')[0];
    expect(todo?.priority).toBe('high');
    expect(todo?.text).toBe('ship it');
  });

  it('reads tags and people', () => {
    const todo = extractTodos('- [ ] ship it #work @fatih')[0];
    expect(todo?.tags).toEqual(['work']);
    expect(todo?.people).toEqual(['fatih']);
    expect(todo?.text).toBe('ship it');
  });

  it('reads every token together', () => {
    const todo = extractTodos('- [ ] Ship v1 due:2026-09-15 prio:high #work @fatih')[0];
    expect(todo).toMatchObject({
      done: false,
      text: 'Ship v1',
      due: '2026-09-15',
      priority: 'high',
      tags: ['work'],
      people: ['fatih'],
    });
  });

  it('leaves a plain GFM checkbox untouched', () => {
    // The metadata is entirely optional; the base format is plain GFM.
    const todo = extractTodos('- [ ] just a task')[0];
    expect(todo).toMatchObject({ text: 'just a task', due: null, priority: null, tags: [] });
  });

  it('leaves unknown tokens in the text rather than swallowing them', () => {
    const todo = extractTodos('- [ ] task effort:3')[0];
    expect(todo?.text).toBe('task effort:3');
  });

  it('ignores a malformed due date', () => {
    const todo = extractTodos('- [ ] task due:soon')[0];
    expect(todo?.due).toBeNull();
    expect(todo?.text).toBe('task due:soon');
  });

  it('keeps indented sub-tasks', () => {
    expect(extractTodos('- [ ] parent\n  - [ ] child')).toHaveLength(2);
  });

  it('does not treat an ordinary list item as a task', () => {
    expect(extractTodos('- not a task')).toEqual([]);
  });

  it('preserves the raw line so the UI can rewrite it exactly', () => {
    const raw = '  - [ ] indented task due:2026-01-01';
    expect(extractTodos(raw)[0]?.raw).toBe(raw);
  });
});

describe('extractHeadings', () => {
  it('reads levels and text', () => {
    const headings = extractHeadings('# One\n## Two\n### Three');
    expect(headings).toEqual([
      { level: 1, text: 'One', line: 1 },
      { level: 2, text: 'Two', line: 2 },
      { level: 3, text: 'Three', line: 3 },
    ]);
  });

  it('ignores comments inside fenced code', () => {
    const headings = extractHeadings('# Real\n\n```sh\n# not a heading\n```');
    expect(headings.map((h) => h.text)).toEqual(['Real']);
  });
});

describe('toPlainText', () => {
  it('strips markup for indexing', () => {
    const plain = toPlainText('# Title\n\nSome **bold** and *italic* text.');
    expect(plain).toBe('Title Some bold and italic text.');
  });

  it('keeps link text but drops the URL', () => {
    expect(toPlainText('see [the docs](https://example.com)')).toBe('see the docs');
  });

  it('prefers a wikilink alias', () => {
    expect(toPlainText('see [[note|the note]]')).toBe('see the note');
  });

  it('drops code block contents', () => {
    expect(toPlainText('text\n\n```js\nconst secret = 1;\n```')).toBe('text');
  });
});

describe('noteTitle', () => {
  it('prefers frontmatter', () => {
    expect(noteTitle('a/b.md', { title: 'From matter' }, [{ level: 1, text: 'H', line: 1 }])).toBe(
      'From matter',
    );
  });

  it('falls back to the first heading', () => {
    expect(noteTitle('a/b.md', {}, [{ level: 1, text: 'From heading', line: 1 }])).toBe(
      'From heading',
    );
  });

  it('falls back to the filename without its extension', () => {
    expect(noteTitle('daily/2026-08-29.md', {}, [])).toBe('2026-08-29');
  });

  it('ignores a blank frontmatter title', () => {
    expect(noteTitle('a/b.md', { title: '   ' }, [])).toBe('b');
  });
});

describe('parseNote', () => {
  it('reads everything from a realistic note', () => {
    const source = [
      '---',
      'title: Project Plan',
      'tags: [planning, work]',
      '---',
      '# Overview',
      '',
      'Linked to [[Research]] and tagged #active.',
      '',
      '- [ ] Draft the spec due:2026-09-01 prio:high',
      '- [x] Book the room',
    ].join('\n');

    const note = parseNote('plans/project.md', source);
    expect(note.title).toBe('Project Plan');
    expect(note.tags.sort()).toEqual(['active', 'planning', 'work']);
    expect(note.links.map((l) => l.target)).toEqual(['Research']);
    expect(note.todos).toHaveLength(2);
    expect(note.headings[0]?.text).toBe('Overview');
  });

  it('shifts line numbers past the frontmatter', () => {
    const source = '---\ntitle: T\n---\n# H\n\n- [ ] task';
    const note = parseNote('a.md', source);
    // The heading really is on line 4 of the file.
    expect(note.headings[0]?.line).toBe(4);
    expect(note.todos[0]?.line).toBe(6);
  });

  it('merges frontmatter tags with inline ones and deduplicates', () => {
    const note = parseNote('a.md', '---\ntags: [work]\n---\nbody #work #home');
    expect(note.tags.sort()).toEqual(['home', 'work']);
  });

  it('accepts frontmatter tags written as a string', () => {
    expect(parseNote('a.md', '---\ntags: work, home\n---\nbody').tags.sort()).toEqual([
      'home',
      'work',
    ]);
  });

  it('strips a leading # from frontmatter tags', () => {
    expect(parseNote('a.md', '---\ntags: ["#work"]\n---\nbody').tags).toEqual(['work']);
  });

  it('handles an empty file', () => {
    const note = parseNote('empty.md', '');
    expect(note.title).toBe('empty');
    expect(note.tags).toEqual([]);
    expect(note.todos).toEqual([]);
  });
});
