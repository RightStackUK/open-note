import { beforeEach, describe, expect, it } from 'vitest';
import { buildNoteList } from './noteList';
import { VaultIndex } from './vaultIndex';
import { inWorkspace, normaliseWorkspace, withWorkspaceTag, workspaceLabel } from './workspace';

describe('what counts as inside', () => {
  it('is everything when there is no workspace', () => {
    // Every call site passes the current value unconditionally, so `null` has
    // to mean "the whole vault" rather than "nothing".
    expect(inWorkspace([], null)).toBe(true);
    expect(inWorkspace(['personal'], null)).toBe(true);
  });

  it('matches the tag, and its children', () => {
    expect(inWorkspace(['work'], 'work')).toBe(true);
    expect(inWorkspace(['work/clients'], 'work')).toBe(true);
    expect(inWorkspace(['Work'], 'work')).toBe(true);
    expect(inWorkspace(['personal'], 'work')).toBe(false);
    // Not a prefix match on the text: `#workshop` is not inside `#work`.
    expect(inWorkspace(['workshop'], 'work')).toBe(false);
  });

  it('normalises what the user picked', () => {
    expect(normaliseWorkspace('#work')).toBe('work');
    expect(normaliseWorkspace('  Work  ')).toBe('work');
    expect(normaliseWorkspace('#work/clients')).toBe('work/clients');
    expect(normaliseWorkspace('')).toBeNull();
    expect(normaliseWorkspace('   ')).toBeNull();
    expect(normaliseWorkspace('#')).toBeNull();
    expect(normaliseWorkspace(null)).toBeNull();
    expect(normaliseWorkspace(undefined)).toBeNull();
  });

  it('shows a workspace back with its hash', () => {
    expect(workspaceLabel('work')).toBe('#work');
    expect(workspaceLabel(null)).toBe('');
  });
});

/**
 * One test per surface the app scopes, because the failure this feature has to
 * avoid is not a wrong filter — it is a surface that never got one, quietly
 * showing notes from outside a scope that promised otherwise.
 */
describe('every surface stays inside the workspace', () => {
  let index: VaultIndex;

  beforeEach(() => {
    index = new VaultIndex();
    index.put('work/Plan.md', '# Plan\n\n#work\n\nQuarterly targets. [[work/Report]]\n');
    index.put('work/Report.md', '# Report\n\n#work/clients\n\n- [ ] Send the report\n');
    index.put('Personal/Recipes.md', '# Recipes\n\n#personal\n\nQuarterly targets too.\n');
    index.put('Personal/Chores.md', '# Chores\n\n#personal\n\n- [ ] Buy milk\n\n[[work/Report]]\n');
  });

  it('search', () => {
    const paths = (workspace: string | null) =>
      index
        .query('quarterly', 10, { workspace })
        .map((hit) => hit.path)
        .sort();

    expect(paths(null)).toEqual(['Personal/Recipes.md', 'work/Plan.md']);
    expect(paths('work')).toEqual(['work/Plan.md']);
    expect(paths('personal')).toEqual(['Personal/Recipes.md']);
  });

  it('the note list', () => {
    const titles = (workspace: string | null) =>
      buildNoteList({
        notes: index
          .paths()
          .map((path) => index.get(path))
          .filter((note): note is NonNullable<typeof note> => note !== undefined),
        modified: new Map(),
        created: new Map(),
        collection: { kind: 'all' },
        sort: 'title',
        descending: false,
        includeNestedTags: true,
        workspace,
      }).map((entry) => entry.title);

    expect(titles(null)).toHaveLength(4);
    expect(titles('work')).toEqual(['Plan', 'Report']);
  });

  it('the task list', () => {
    expect(index.todos({ workspace: 'work' }).map((todo) => todo.text)).toEqual([
      'Send the report',
    ]);
    expect(index.todos({ workspace: 'personal' }).map((todo) => todo.text)).toEqual(['Buy milk']);
    expect(index.todos()).toHaveLength(2);
  });

  it('backlinks', () => {
    // `work/Report` is linked from both sides of the vault.
    expect(
      index
        .backlinks('work/Report.md')
        .map((b) => b.from)
        .sort(),
    ).toEqual(['Personal/Chores.md', 'work/Plan.md']);
    expect(index.backlinks('work/Report.md', { workspace: 'work' }).map((b) => b.from)).toEqual([
      'work/Plan.md',
    ]);
  });

  it('unlinked mentions', () => {
    index.put('work/Notes.md', '# Notes\n\n#work\n\nSomething about Recipes here.\n');
    expect(index.unlinkedMentions('Personal/Recipes.md').map((m) => m.path)).toContain(
      'work/Notes.md',
    );
    expect(
      index
        .unlinkedMentions('Personal/Recipes.md', 20, { workspace: 'personal' })
        .map((m) => m.path),
    ).not.toContain('work/Notes.md');
  });

  it('the tag browser', () => {
    expect(
      index
        .tags({ workspace: 'work' })
        .map((t) => t.tag)
        .sort(),
    ).toEqual(['work', 'work/clients']);
    expect(index.tags({ workspace: 'personal' }).map((t) => t.tag)).toEqual(['personal']);
    expect(index.tags().length).toBeGreaterThan(2);
  });

  it('resolving a link is not scoped, because a link is not a view', () => {
    // Following an explicit `[[wikilink]]` out of the workspace is the user
    // asking to go there; silently failing to resolve it would look like a
    // broken link rather than a boundary.
    expect(index.resolveLink('Personal/Chores')).toBe('Personal/Chores.md');
  });
});

describe('a new note joins the workspace it was made in', () => {
  it('puts the tag under the heading, not above it', () => {
    // The first line of a note is its title. A note that opens on a tag line
    // has been given a worse first line by a feature nobody asked about.
    expect(withWorkspaceTag('# Scoped note\n\n', 'project')).toBe('# Scoped note\n\n#project\n');
  });

  it('keeps the body that follows', () => {
    expect(withWorkspaceTag('# Plan\n\nFirst paragraph.\n', 'work')).toBe(
      '# Plan\n\n#work\n\nFirst paragraph.\n',
    );
  });

  it('handles a note with no heading', () => {
    expect(withWorkspaceTag('Just text.\n', 'work')).toBe('#work\n\nJust text.\n');
  });

  it('handles an empty body', () => {
    expect(withWorkspaceTag('', 'work')).toBe('#work\n\n');
  });

  it('does nothing without a workspace', () => {
    expect(withWorkspaceTag('# Plan\n', null)).toBe('# Plan\n');
  });

  it('does not add a tag the note already carries', () => {
    const body = '# Plan\n\n#work\n';
    expect(withWorkspaceTag(body, 'work')).toBe(body);
    // Nested counts: a `#work/clients` note is already inside `#work`.
    const nested = '# Plan\n\n#work/clients\n';
    expect(withWorkspaceTag(nested, 'work')).toBe(nested);
  });

  it('does add the tag when a different one is there', () => {
    expect(withWorkspaceTag('# Plan\n\n#personal\n', 'work')).toBe(
      '# Plan\n\n#work\n\n#personal\n',
    );
  });

  it('is not fooled by a heading that is not one', () => {
    // `## Section` is not the note's title line.
    expect(withWorkspaceTag('## Section\n\nText\n', 'work')).toBe('#work\n\n## Section\n\nText\n');
  });

  it("keeps the file's own line endings", () => {
    expect(withWorkspaceTag('# Plan\r\n\r\n', 'work')).toBe('# Plan\r\n\r\n#work\r\n');
  });

  it('lands the note inside the workspace, which is the point', () => {
    const tagged = withWorkspaceTag('# Scoped note\n\n', 'project');
    const tags = [...tagged.matchAll(/#([\w/-]+)/g)].map((m) => m[1] ?? '');
    expect(inWorkspace(tags, 'project')).toBe(true);
  });
});
