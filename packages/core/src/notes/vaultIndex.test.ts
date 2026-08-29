import { beforeEach, describe, expect, it } from 'vitest';

import { fuzzyScore, snippetFor, VaultIndex } from './vaultIndex';

let index: VaultIndex;

beforeEach(() => {
  index = new VaultIndex();
});

describe('put / remove', () => {
  it('indexes a note', () => {
    index.put('a.md', '# Alpha');
    expect(index.size).toBe(1);
    expect(index.get('a.md')?.title).toBe('Alpha');
  });

  it('replaces a note on re-put rather than duplicating it', () => {
    index.put('a.md', '# Alpha');
    index.put('a.md', '# Renamed');
    expect(index.size).toBe(1);
    expect(index.get('a.md')?.title).toBe('Renamed');
  });

  it('removes a note and its searchability', () => {
    index.put('a.md', '# Alpha unique-word');
    index.remove('a.md');
    expect(index.size).toBe(0);
    expect(index.query('unique-word')).toEqual([]);
  });

  it('ignores removal of a note it does not have', () => {
    expect(() => index.remove('nope.md')).not.toThrow();
  });

  it('clears everything', () => {
    index.put('a.md', '# A');
    index.put('b.md', '# B');
    index.clear();
    expect(index.size).toBe(0);
    expect(index.query('A')).toEqual([]);
  });
});

describe('resolveLink', () => {
  it('resolves an exact path', () => {
    index.put('folder/note.md', '# N');
    expect(index.resolveLink('folder/note.md')).toBe('folder/note.md');
  });

  it('resolves a path without the extension', () => {
    index.put('folder/note.md', '# N');
    expect(index.resolveLink('folder/note')).toBe('folder/note.md');
  });

  it('resolves by basename from anywhere in the vault', () => {
    index.put('deep/nested/Research.md', '# R');
    expect(index.resolveLink('Research')).toBe('deep/nested/Research.md');
  });

  it('resolves case-insensitively', () => {
    index.put('Research.md', '# R');
    expect(index.resolveLink('research')).toBe('Research.md');
  });

  it('refuses to guess when a basename is ambiguous', () => {
    // Linking to the wrong note silently is worse than an unresolved link.
    index.put('a/notes.md', '# A');
    index.put('b/notes.md', '# B');
    expect(index.resolveLink('notes')).toBeNull();
  });

  it('returns null for a target that does not exist', () => {
    expect(index.resolveLink('ghost')).toBeNull();
  });

  it('returns null for an empty target', () => {
    expect(index.resolveLink('   ')).toBeNull();
  });
});

describe('backlinks', () => {
  it('finds notes linking here', () => {
    index.put('target.md', '# Target');
    index.put('source.md', '# Source\n\nsee [[target]]');
    const links = index.backlinks('target.md');
    expect(links).toEqual([{ from: 'source.md', fromTitle: 'Source', alias: null }]);
  });

  it('carries the alias through', () => {
    index.put('target.md', '# Target');
    index.put('source.md', 'see [[target|the target]]');
    expect(index.backlinks('target.md')[0]?.alias).toBe('the target');
  });

  it('does not count a note linking to itself', () => {
    index.put('self.md', '# Self\n\n[[self]]');
    expect(index.backlinks('self.md')).toEqual([]);
  });

  it('lists a linking note once even with several links', () => {
    index.put('target.md', '# T');
    index.put('source.md', '[[target]] and again [[target|twice]]');
    expect(index.backlinks('target.md')).toHaveLength(1);
  });

  it('drops a backlink when the source stops linking', () => {
    index.put('target.md', '# T');
    index.put('source.md', '[[target]]');
    index.put('source.md', 'no more links');
    expect(index.backlinks('target.md')).toEqual([]);
  });

  it('returns nothing for an unlinked note', () => {
    index.put('lonely.md', '# Lonely');
    expect(index.backlinks('lonely.md')).toEqual([]);
  });
});

describe('unresolvedLinks', () => {
  it('reports links with no destination', () => {
    index.put('a.md', 'see [[Nowhere]]');
    expect(index.unresolvedLinks()).toEqual([{ target: 'Nowhere', from: ['a.md'] }]);
  });

  it('groups sources pointing at the same missing note', () => {
    index.put('a.md', '[[Ghost]]');
    index.put('b.md', '[[Ghost]]');
    expect(index.unresolvedLinks()[0]?.from.sort()).toEqual(['a.md', 'b.md']);
  });

  it('says nothing when every link resolves', () => {
    index.put('a.md', '[[b]]');
    index.put('b.md', '# B');
    expect(index.unresolvedLinks()).toEqual([]);
  });
});

describe('tags', () => {
  it('counts tags across the vault, most used first', () => {
    index.put('a.md', '#work #home');
    index.put('b.md', '#work');
    expect(index.tags()).toEqual([
      { tag: 'work', count: 2 },
      { tag: 'home', count: 1 },
    ]);
  });

  it('lists notes carrying a tag', () => {
    index.put('a.md', '#work');
    index.put('b.md', '#home');
    expect(index.notesWithTag('work')).toEqual(['a.md']);
  });

  it('matches tags case-insensitively', () => {
    index.put('a.md', '#Work');
    expect(index.notesWithTag('work')).toEqual(['a.md']);
  });

  it('includes frontmatter tags', () => {
    index.put('a.md', '---\ntags: [planning]\n---\nbody');
    expect(index.tags()).toEqual([{ tag: 'planning', count: 1 }]);
  });
});

describe('todos', () => {
  it('gathers tasks from every note', () => {
    index.put('a.md', '- [ ] one');
    index.put('b.md', '- [ ] two');
    expect(index.todos()).toHaveLength(2);
  });

  it('carries the note path and title', () => {
    index.put('plans/p.md', '# Plan\n\n- [ ] task');
    expect(index.todos()[0]).toMatchObject({ path: 'plans/p.md', noteTitle: 'Plan' });
  });

  it('puts open tasks before completed ones', () => {
    index.put('a.md', '- [x] done\n- [ ] open');
    expect(index.todos().map((t) => t.text)).toEqual(['open', 'done']);
  });

  it('sorts by due date, undated last', () => {
    index.put('a.md', '- [ ] later due:2026-12-01\n- [ ] undated\n- [ ] sooner due:2026-01-01');
    expect(index.todos().map((t) => t.text)).toEqual(['sooner', 'later', 'undated']);
  });

  it('breaks ties on priority', () => {
    index.put('a.md', '- [ ] low one prio:low\n- [ ] high one prio:high');
    expect(index.todos().map((t) => t.text)).toEqual(['high one', 'low one']);
  });
});

describe('query', () => {
  it('finds a note by body text', () => {
    index.put('a.md', '# Alpha\n\nThe quick brown fox.');
    expect(index.query('brown').map((h) => h.path)).toEqual(['a.md']);
  });

  it('ranks a title match above a body mention', () => {
    index.put('mention.md', '# Mention\n\nSomething about kubernetes here.');
    index.put('kubernetes.md', '# Kubernetes\n\nUnrelated prose.');
    expect(index.query('kubernetes')[0]?.path).toBe('kubernetes.md');
  });

  it('finds a note by tag', () => {
    index.put('a.md', '#infrastructure');
    expect(index.query('infrastructure').map((h) => h.path)).toEqual(['a.md']);
  });

  it('matches on a prefix', () => {
    index.put('a.md', '# Alphabet');
    expect(index.query('alpha')).not.toHaveLength(0);
  });

  it('returns a snippet around the match', () => {
    index.put('a.md', `# Doc\n\n${'padding '.repeat(40)}needle ${'more '.repeat(40)}`);
    const hit = index.query('needle')[0];
    expect(hit?.snippet).toContain('needle');
    expect(hit?.snippet.length).toBeLessThan(200);
  });

  it('returns nothing for an empty query', () => {
    index.put('a.md', '# A');
    expect(index.query('  ')).toEqual([]);
  });

  it('does not match text inside code blocks', () => {
    index.put('a.md', '# Doc\n\n```\nsupersecretidentifier\n```');
    expect(index.query('supersecretidentifier')).toEqual([]);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 40; i++) index.put(`n${i}.md`, '# Note about testing');
    expect(index.query('testing', 5)).toHaveLength(5);
  });
});

describe('quickSwitch', () => {
  it('lists notes when the query is empty', () => {
    index.put('a.md', '# Alpha');
    index.put('b.md', '# Beta');
    expect(index.quickSwitch('')).toHaveLength(2);
  });

  it('matches on a title substring', () => {
    index.put('a.md', '# Project Plan');
    index.put('b.md', '# Grocery List');
    expect(index.quickSwitch('plan')[0]?.path).toBe('a.md');
  });

  it('matches a scattered subsequence', () => {
    index.put('daily/2026-08-29.md', '# Daily');
    expect(index.quickSwitch('d29').map((r) => r.path)).toContain('daily/2026-08-29.md');
  });

  it('matches on path as well as title', () => {
    index.put('projects/open-note.md', '# Untitled thing');
    expect(index.quickSwitch('projects')[0]?.path).toBe('projects/open-note.md');
  });

  it('excludes notes that do not match at all', () => {
    index.put('a.md', '# Alpha');
    expect(index.quickSwitch('zzzz')).toEqual([]);
  });
});

describe('fuzzyScore', () => {
  it('scores a literal substring above a subsequence', () => {
    expect(fuzzyScore('project plan', 'plan')).toBeGreaterThan(fuzzyScore('pencil lane', 'plan'));
  });

  it('returns 0 when the needle is not a subsequence', () => {
    expect(fuzzyScore('abc', 'xyz')).toBe(0);
  });

  it('rewards a prefix match', () => {
    expect(fuzzyScore('plan b', 'plan')).toBeGreaterThan(fuzzyScore('the plan', 'plan'));
  });

  it('treats an empty needle as a match', () => {
    expect(fuzzyScore('anything', '')).toBeGreaterThan(0);
  });
});

describe('snippetFor', () => {
  it('centres on the match', () => {
    const text = `${'a '.repeat(100)}needle${' b'.repeat(100)}`;
    expect(snippetFor(text, 'needle')).toContain('needle');
  });

  it('marks truncation with ellipses', () => {
    const text = `${'a '.repeat(200)}needle`;
    expect(snippetFor(text, 'needle').startsWith('…')).toBe(true);
  });

  it('falls back to the start when nothing matches', () => {
    expect(snippetFor('hello world', 'zzz')).toBe('hello world');
  });

  it('handles empty text', () => {
    expect(snippetFor('', 'x')).toBe('');
  });
});
