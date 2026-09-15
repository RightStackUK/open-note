import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { frontmatterLinesForTest, frontmatterSyntax } from './frontmatter';

function state(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, codeLanguages: [], extensions: [frontmatterSyntax] }),
    ],
  });
}

/** Every node name in the tree, for asserting what the parser decided. */
function nodes(doc: string): string[] {
  const found: string[] = [];
  const editor = state(doc);
  syntaxTree(editor).iterate({ enter: (node) => void found.push(node.name) });
  return found;
}

const HEADER = ['---', 'title: "Q1: plans/ideas"', 'created: "2026-01-15T09:30:00Z"', '---'];
const NOTE = [...HEADER, '', '# Plans', '', 'Body text.'].join('\n');

describe('a YAML header is a header, not a heading', () => {
  it('parses as its own block', () => {
    const found = nodes(NOTE);
    expect(found).toContain('Frontmatter');
    expect(found.filter((name) => name === 'FrontmatterMark')).toHaveLength(2);
  });

  it('no longer parses as a setext heading', () => {
    // The bug this exists for: `---` opens a thematic break, and the keys
    // below it are a paragraph closed by `---`, which is CommonMark's spelling
    // of a level-*two* heading — 1.42em in this theme, which is exactly the
    // size the header used to render at. So a note's metadata was its title.
    expect(nodes(NOTE)).not.toContain('SetextHeading2');
    expect(nodes(NOTE)).not.toContain('HorizontalRule');
  });

  it('leaves the real heading of the note first', () => {
    const found = nodes(NOTE);
    expect(found).toContain('ATXHeading1');
    // And the body after it is still prose.
    expect(found).toContain('Paragraph');
  });

  it('covers exactly the lines of the header', () => {
    expect(frontmatterLinesForTest(state(NOTE))).toEqual([1, 2, 3, 4]);
  });
});

describe('what is not frontmatter', () => {
  it('ignores a `---` anywhere but the first line', () => {
    const doc = ['# Plans', '', '---', 'title: not a header', '---'].join('\n');
    expect(nodes(doc)).not.toContain('Frontmatter');
    expect(frontmatterLinesForTest(state(doc))).toEqual([]);
  });

  it('leaves a thematic break at the top of a note alone', () => {
    // A note that opens with a horizontal rule. The line after the fence has
    // to look like YAML, and prose does not.
    const doc = ['---', '', 'Just a note that starts with a rule.'].join('\n');
    expect(nodes(doc)).not.toContain('Frontmatter');
    expect(nodes(doc)).toContain('HorizontalRule');
  });

  it('leaves a setext heading that is genuinely one alone', () => {
    const doc = ['A title', '---', '', 'Body.'].join('\n');
    expect(nodes(doc)).toContain('SetextHeading2');
    expect(nodes(doc)).not.toContain('Frontmatter');
  });

  it('does not treat a `---` inside a code fence as a header', () => {
    const doc = ['# Plans', '', '```yaml', '---', 'key: value', '---', '```'].join('\n');
    expect(nodes(doc)).not.toContain('Frontmatter');
  });
});

describe('a header that is still being typed', () => {
  it('keeps an unterminated one as metadata rather than as a title', () => {
    // Mid-typing, and the state a hand-edited file can be left in. The parser
    // has consumed the lines by the time it knows there is no closing fence,
    // so it keeps them — and showing them as metadata says the `---` is
    // missing more clearly than rendering half the note as a heading would.
    const doc = ['---', 'title: half done', 'created: today'].join('\n');
    expect(nodes(doc)).toContain('Frontmatter');
    expect(frontmatterLinesForTest(state(doc))).toEqual([1, 2, 3]);
  });

  it('handles the smallest possible header', () => {
    const doc = ['---', 'id: abc', '---', '', 'Body.'].join('\n');
    expect(frontmatterLinesForTest(state(doc))).toEqual([1, 2, 3]);
  });

  it('accepts a longer fence, which a stray keystroke makes', () => {
    const doc = ['----', 'id: abc', '----', '', 'Body.'].join('\n');
    expect(nodes(doc)).toContain('Frontmatter');
  });

  it('accepts a list under a key', () => {
    const doc = ['---', 'tags:', '  - work', '  - reading', '---', '', 'Body.'].join('\n');
    expect(frontmatterLinesForTest(state(doc))).toEqual([1, 2, 3, 4, 5]);
  });
});
