import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { calloutLinesForTest } from './callouts';
import { editorCommands } from './commands';
import { headingFoldRange } from './folding';
import { footnoteTokensForTest, renumberFootnotes } from './footnotes';
import { inlineStyleSpansForTest } from './inlineStyles';
import { mathSpansForTest } from './math';

/** `‸` marks the caret, as everywhere else in this package. */
function state(input: string): EditorState {
  const caret = input.indexOf('‸');
  const doc = caret === -1 ? input : input.replace('‸', '');
  return EditorState.create({
    doc,
    selection: EditorSelection.single(caret === -1 ? doc.length : caret),
    extensions: [markdown({ base: markdownLanguage, codeLanguages: [] })],
  });
}

describe('callouts', () => {
  it('recognises the five GitHub kinds, case-insensitively', () => {
    for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION', 'note']) {
      const lines = calloutLinesForTest(state(`> [!${kind}]\n> body\n\ntail‸`));
      expect(lines.get(1)).toBe(kind.toLowerCase());
      expect(lines.get(2)).toBe(kind.toLowerCase());
    }
  });

  it('leaves an ordinary blockquote alone', () => {
    expect(calloutLinesForTest(state('> just a quote\n\ntail‸')).size).toBe(0);
  });

  it('leaves a non-alert bracket alone', () => {
    expect(calloutLinesForTest(state('> [!TODO] not a github alert\n\ntail‸')).size).toBe(0);
  });
});

describe('math', () => {
  it('finds inline and block math off the active line', () => {
    const spans = mathSpansForTest(state('a $x^2$ b\n\n$$\\int_0^1 x\\,dx$$\n\ntail‸'));
    expect(spans).toHaveLength(2);
    expect(spans.map(([, , display]) => display)).toEqual(expect.arrayContaining([true, false]));
  });

  it('shows the source on the active line', () => {
    expect(mathSpansForTest(state('a $x^‸2$ b'))).toHaveLength(0);
  });

  it('does not mistake money for math', () => {
    expect(mathSpansForTest(state('lunch was $5 and dinner $10\n\ntail‸'))).toHaveLength(0);
  });

  it('does not read $$x$$ as two inline dollars', () => {
    const spans = mathSpansForTest(state('$$x$$\n\ntail‸'));
    expect(spans).toHaveLength(1);
    expect(spans[0]?.[2]).toBe(true);
  });

  it('accepts an escaped dollar inside block math', () => {
    const spans = mathSpansForTest(state('$$\\text{Cost: \\$5}$$\n\ntail‸'));
    expect(spans).toHaveLength(1);
  });

  it('treats a plain arithmetic span as math', () => {
    expect(mathSpansForTest(state('so $1+2$ then\n\ntail‸'))).toHaveLength(1);
  });

  it('ignores math inside code', () => {
    expect(mathSpansForTest(state('`$x$`\n\ntail‸'))).toHaveLength(0);
    expect(mathSpansForTest(state('```\n$x$\n```\n\ntail‸'))).toHaveLength(0);
  });
});

describe('footnotes', () => {
  it('separates references from definitions', () => {
    const tokens = footnoteTokensForTest(
      state('a[^1] and b[^note]\n\n[^1]: first\n[^note]: second'),
    );
    expect(tokens.references.map((r) => r.id)).toEqual(['1', 'note']);
    expect(tokens.definitions.get('1')?.text).toBe('first');
    expect(tokens.definitions.get('note')?.text).toBe('second');
  });

  it('renumbers an orphan definition out of the way of a referenced one', () => {
    // `[^2]` is referenced and becomes `[^1]`; the orphan `[^1]` definition
    // must move rather than collide with it.
    const before = state('used[^2]\n\n[^1]: orphan\n[^2]: used');
    let after = before;
    renumberFootnotes({
      state: before,
      dispatch: (tr) => {
        after = tr.state;
      },
    });
    expect(after.doc.toString()).toBe('used[^1]\n\n[^2]: orphan\n[^1]: used');
  });

  it('ignores definitions inside code blocks', () => {
    const tokens = footnoteTokensForTest(state('a[^1]\n\n```\n[^1]: not real\n```\n\n[^1]: real'));
    expect(tokens.definitions.get('1')?.text).toBe('real');
  });

  it('renumbers numeric footnotes into document order, leaving names alone', () => {
    const before = state('a[^3] b[^note] c[^1]\n\n[^3]: three\n[^1]: one\n[^note]: named');
    let after = before;
    renumberFootnotes({
      state: before,
      dispatch: (tr) => {
        after = tr.state;
      },
    });
    expect(after.doc.toString()).toBe(
      'a[^1] b[^note] c[^2]\n\n[^1]: three\n[^2]: one\n[^note]: named',
    );
  });

  it('is exposed through the command table', () => {
    expect(editorCommands['edit.renumberFootnotes']).toBeTypeOf('function');
  });
});

describe('highlight and underline', () => {
  it('marks ==highlight== spans', () => {
    const spans = inlineStyleSpansForTest(state('some ==marked== text\n\ntail‸'));
    expect(spans).toEqual([[7, 13, 'cm-highlight']]);
  });

  it('marks <u>underline</u> spans, across lines too', () => {
    const spans = inlineStyleSpansForTest(state('some <u>held</u> text\n\ntail‸'));
    expect(spans).toEqual([[8, 12, 'cm-underline']]);
    expect(inlineStyleSpansForTest(state('<u>two\nlines</u>\n\ntail‸'))).toHaveLength(1);
  });

  it('never emits a zero-length mark for an empty pair', () => {
    // `edit.underline` on whitespace leaves `<u></u>` in the text; a
    // zero-length mark decoration throws inside CodeMirror.
    expect(inlineStyleSpansForTest(state('a <u></u> b\n\ntail‸'))).toHaveLength(0);
    expect(inlineStyleSpansForTest(state('a ==== b\n\ntail‸'))).toHaveLength(0);
  });

  it('ignores both inside code', () => {
    expect(inlineStyleSpansForTest(state('`==x==` and `<u>y</u>`\n\ntail‸'))).toHaveLength(0);
  });

  it('toggles highlight and underline through the commands', () => {
    const run = (id: string, doc: string, from: number, to: number) => {
      const start = EditorState.create({ doc, selection: EditorSelection.single(from, to) });
      let result = start;
      editorCommands[id]?.({
        state: start,
        dispatch: (tr) => {
          result = tr.state;
        },
      });
      return result.doc.toString();
    };

    expect(run('edit.highlight', 'mark this', 5, 9)).toBe('mark ==this==');
    expect(run('edit.highlight', 'mark ==this==', 7, 11)).toBe('mark this');
    expect(run('edit.underline', 'hold this', 5, 9)).toBe('hold <u>this</u>');
    expect(run('edit.underline', 'hold <u>this</u>', 8, 12)).toBe('hold this');
  });
});

describe('heading folding', () => {
  const doc = ['# One', 'a', 'b', '## Two', 'c', '# Three', 'd'].join('\n');

  it('folds a section up to the next heading of equal or higher level', () => {
    const s = state(doc);
    const range = headingFoldRange(s, s.doc.line(1).from);
    // `# One` folds everything through `c` — `## Two` is deeper, `# Three` ends it.
    expect(range).toEqual({ from: s.doc.line(1).to, to: s.doc.line(5).to });
  });

  it('folds a subsection only to its own extent', () => {
    const s = state(doc);
    const range = headingFoldRange(s, s.doc.line(4).from);
    expect(range).toEqual({ from: s.doc.line(4).to, to: s.doc.line(5).to });
  });

  it('returns null for a heading with nothing under it', () => {
    const s = state('# Alone');
    expect(headingFoldRange(s, 0)).toBeNull();
  });

  it('returns null for a plain line', () => {
    const s = state(doc);
    expect(headingFoldRange(s, s.doc.line(2).from)).toBeNull();
  });

  it('does not fold a fake heading inside a code fence', () => {
    const s = state('```\n# comment\ncode\n```\nprose');
    expect(headingFoldRange(s, s.doc.line(2).from)).toBeNull();
  });

  it('does not end a real section at a fake heading in code', () => {
    const s = state('# Real\n```\n# fake\n```\ntail');
    const range = headingFoldRange(s, 0);
    expect(range?.to).toBe(s.doc.line(5).to);
  });
});
