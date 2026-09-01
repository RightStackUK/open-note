import { describe, expect, it } from 'vitest';

import { parseSearchQuery } from './searchQuery';
import { removeTagFromNote, renameTagInNote, tagFamily } from './tags';
import { VaultIndex } from './vaultIndex';

describe('renameTagInNote', () => {
  it('renames every occurrence in the body', () => {
    const { text, count } = renameTagInNote('do #work now, more #work later', 'work', 'job');
    expect(text).toBe('do #job now, more #job later');
    expect(count).toBe(2);
  });

  it('renames children with the parent', () => {
    const { text } = renameTagInNote('a #work and #work/urgent and #work/deep/one', 'work', 'job');
    expect(text).toBe('a #job and #job/urgent and #job/deep/one');
  });

  it('leaves a tag that merely shares a prefix', () => {
    const { text, count } = renameTagInNote('the #workshop tag', 'work', 'job');
    expect(text).toBe('the #workshop tag');
    expect(count).toBe(0);
  });

  it('matches case-insensitively, like the index', () => {
    expect(renameTagInNote('a #Work note', 'work', 'job').text).toBe('a #job note');
  });

  it('never touches code', () => {
    const source = 'prose #work\n\n```\n#work stays\n```\nand `#work` inline';
    const { text } = renameTagInNote(source, 'work', 'job');
    expect(text).toBe('prose #job\n\n```\n#work stays\n```\nand `#work` inline');
  });

  it('rewrites frontmatter tag lists', () => {
    const source = '---\ntitle: X\ntags: [work, home]\n---\n\nbody #work';
    const { text, count } = renameTagInNote(source, 'work', 'job');
    expect(text).toContain('tags: [job, home]');
    expect(text).toContain('body #job');
    expect(count).toBe(2);
  });

  it('rewrites block-style frontmatter tags', () => {
    const source = '---\ntags:\n  - work\n  - home\n---\n\nbody';
    const { text } = renameTagInNote(source, 'work', 'job');
    expect(text).toContain('- job');
    expect(text).toContain('- home');
  });
});

describe('removeTagFromNote', () => {
  it('removes occurrences without deleting anything else', () => {
    const { text, count } = removeTagFromNote('keep this #gone and this', 'gone');
    expect(text).toBe('keep this and this');
    expect(count).toBe(1);
  });

  it('removes children with the parent', () => {
    expect(removeTagFromNote('a #work/urgent b', 'work').text).toBe('a b');
  });

  it('leaves code alone', () => {
    expect(removeTagFromNote('x `#gone` y #gone', 'gone').text).toBe('x `#gone` y');
  });
});

describe('rewrites stay surgical', () => {
  it('never reflows whitespace away from the removal site', () => {
    const source = 'a #gone b\n\n```\ncode  with   spaces\n```\n\n    indented  text';
    const { text } = removeTagFromNote(source, 'gone');
    expect(text).toContain('code  with   spaces');
    expect(text).toContain('    indented  text');
    expect(text).toContain('a b');
  });

  it('leaves dash items under other frontmatter keys alone', () => {
    const source = '---\ntags:\n  - work\naliases:\n  - work\n---\n\nbody';
    const renamedText = renameTagInNote(source, 'work', 'job').text;
    expect(renamedText).toContain('tags:\n  - job');
    expect(renamedText).toContain('aliases:\n  - work');

    const removedText = removeTagFromNote(source, 'work').text;
    expect(removedText).toContain('aliases:\n  - work');
    expect(removedText).not.toContain('tags:\n  - work');
  });

  it('drops a removed inline tag with its comma', () => {
    const { text } = removeTagFromNote('---\ntags: [work, home]\n---\n\nbody', 'work');
    expect(text).toContain('tags: [ home]');
  });
});

describe('tagFamily', () => {
  it('collects the tag and its children only', () => {
    expect(tagFamily(['work', 'work/urgent', 'workshop', 'home'], 'work')).toEqual([
      'work',
      'work/urgent',
    ]);
  });
});

describe('parseSearchQuery', () => {
  it('splits terms, phrases, exclusions, fields and filters', () => {
    const parsed = parseSearchQuery('plan "exact words" -draft title:meeting tag:work is:todo');
    expect(parsed.terms).toEqual(['plan']);
    expect(parsed.phrases).toEqual(['exact words']);
    expect(parsed.excluded).toEqual(['draft']);
    expect(parsed.title).toEqual(['meeting']);
    expect(parsed.tags).toEqual(['work']);
    expect(parsed.filters).toEqual(['is:todo']);
  });

  it('supports excluded phrases', () => {
    expect(parseSearchQuery('-"not this"').excluded).toEqual(['not this']);
  });

  it('accepts quoted field values', () => {
    const parsed = parseSearchQuery('title:"Quarterly Plan" tag:"deep/work"');
    expect(parsed.title).toEqual(['Quarterly Plan']);
    expect(parsed.tags).toEqual(['deep/work']);
    expect(parsed.terms).toEqual([]);
  });

  it('treats a lone dash as a term, not an exclusion of nothing', () => {
    expect(parseSearchQuery('-').terms).toEqual(['-']);
  });
});

function index(entries: Array<[string, string]>): VaultIndex {
  const idx = new VaultIndex();
  for (const [path, source] of entries) idx.put(path, source);
  return idx;
}

describe('query with the language', () => {
  const idx = index([
    ['a.md', '# Meeting notes\n\nThe quarterly plan was discussed. #work'],
    ['b.md', '# Groceries\n\nA plan for dinner: pasta. #home\n\n- [ ] buy pasta'],
    ['c.md', '# Draft plan\n\nquarterly things, draft quality. $x^2$'],
    ['d.md', '# Photos\n\n![shot](x.png)\n\n- [x] sort them'],
  ]);

  it('phrase search is exact, not fuzzy', () => {
    expect(idx.query('"quarterly plan"').map((h) => h.path)).toEqual(['a.md']);
    // Both words appear in a.md, but never in this order side by side.
    expect(idx.query('"discussed plan"')).toEqual([]);
  });

  it('exclusion drops notes containing the term', () => {
    const paths = idx.query('plan -draft').map((h) => h.path);
    expect(paths).toContain('a.md');
    expect(paths).not.toContain('c.md');
  });

  it('excludes whole words, not substrings', () => {
    const words = index([
      ['x.md', 'we are redrafting the plan'],
      ['y.md', 'a draft plan'],
    ]);
    const paths = words.query('plan -draft').map((h) => h.path);
    expect(paths).toEqual(['x.md']);
  });

  it('an excluded tag covers its children', () => {
    const nested = index([
      ['x.md', 'plan #work/urgent'],
      ['y.md', 'plan #home'],
    ]);
    expect(nested.query('plan -work').map((h) => h.path)).toEqual(['y.md']);
  });

  it('orders a filter-only query by recency before applying the limit', () => {
    const many = index(
      Array.from({ length: 5 }, (_, i) => [`n${i}.md`, `note ${i}`] as [string, string]),
    );
    const modified = new Map(Array.from({ length: 5 }, (_, i) => [`n${i}.md`, i]));
    const hits = many.query('is:untagged', 2, { modified });
    // The two *newest*, not the first two in insertion order.
    expect(hits.map((h) => h.path)).toEqual(['n4.md', 'n3.md']);
  });

  it('title: scopes to the title', () => {
    expect(idx.query('plan title:meeting').map((h) => h.path)).toEqual(['a.md']);
  });

  it('tag: requires the tag, children included', () => {
    expect(idx.query('plan tag:home').map((h) => h.path)).toEqual(['b.md']);
  });

  it('is:todo and is:done look at task state', () => {
    expect(idx.query('is:todo').map((h) => h.path)).toEqual(['b.md']);
    expect(idx.query('is:done').map((h) => h.path)).toEqual(['d.md']);
  });

  it('is:image, is:untagged and has:math filter on content', () => {
    expect(idx.query('is:image').map((h) => h.path)).toEqual(['d.md']);
    expect(idx.query('has:math').map((h) => h.path)).toEqual(['c.md']);
    const untagged = idx.query('is:untagged').map((h) => h.path);
    expect(untagged).toContain('c.md');
    expect(untagged).toContain('d.md');
    expect(untagged).not.toContain('a.md');
  });

  it('scopes to a tag when asked', () => {
    const hits = idx.query('plan', 30, { scope: { kind: 'tag', tag: 'work' } });
    expect(hits.map((h) => h.path)).toEqual(['a.md']);
  });

  it('scopes to a folder when asked', () => {
    const scoped = index([
      ['projects/x.md', 'the plan here'],
      ['y.md', 'the plan there'],
    ]);
    const hits = scoped.query('plan', 30, { scope: { kind: 'folder', folder: 'projects' } });
    expect(hits.map((h) => h.path)).toEqual(['projects/x.md']);
  });
});

describe('unlinked mentions', () => {
  const idx = index([
    ['Research.md', '# Research\n\nfindings'],
    ['a.md', 'This mentions Research without linking.'],
    ['b.md', 'This links to [[Research]] properly, and says Research too.'],
    ['c.md', 'Nothing relevant here.'],
  ]);

  it('finds notes that mention the title without linking', () => {
    expect(idx.unlinkedMentions('Research.md').map((m) => m.path)).toEqual(['a.md']);
  });

  it('requires whole words — Researcher does not mention Research', () => {
    const idx2 = index([
      ['Research.md', '# Research\n\nfindings'],
      ['a.md', 'The Researcher worked late.'],
      ['b.md', 'True Research happened here.'],
    ]);
    expect(idx2.unlinkedMentions('Research.md').map((m) => m.path)).toEqual(['b.md']);
  });

  it('skips very short titles — they would match everywhere', () => {
    const short = index([
      ['Go.md', '# Go\n\nx'],
      ['other.md', 'Let us go to the park.'],
    ]);
    expect(short.unlinkedMentions('Go.md')).toEqual([]);
  });
});
