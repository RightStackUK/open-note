import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { editorCommands } from './commands';

/**
 * Run a command against a document and report what came out.
 *
 * `‸` marks the caret; `«` and `»` delimit a selection. Deliberately not `|`,
 * `[` or `]`: those appear in the markdown being tested — every task line has a
 * `[ ]` in it — and a marker that collides with the fixture is a test that lies.
 */
function run(id: string, input: string): string {
  const selection = parseMarkers(input);
  const state = EditorState.create({ doc: selection.doc, selection: selection.selection });

  let result = state;
  const command = editorCommands[id];
  if (!command) throw new Error(`no such command: ${id}`);

  command({
    state,
    dispatch: (transaction) => {
      result = transaction.state;
    },
  });

  return renderMarkers(result);
}

function parseMarkers(input: string) {
  const selectionMatch = /«([\s\S]*?)»/.exec(input);
  if (selectionMatch) {
    const from = selectionMatch.index;
    const inner = selectionMatch[1] ?? '';
    const doc = input.slice(0, from) + inner + input.slice(from + selectionMatch[0].length);
    return { doc, selection: EditorSelection.single(from, from + inner.length) };
  }
  const caret = input.indexOf('‸');
  if (caret === -1) return { doc: input, selection: EditorSelection.single(0) };
  return { doc: input.replace('‸', ''), selection: EditorSelection.single(caret) };
}

function renderMarkers(state: EditorState): string {
  const doc = state.doc.toString();
  const { from, to } = state.selection.main;
  if (from === to) return `${doc.slice(0, from)}‸${doc.slice(from)}`;
  return `${doc.slice(0, from)}«${doc.slice(from, to)}»${doc.slice(to)}`;
}

/** Just the resulting text, for cases where the caret is not the point. */
function runDoc(id: string, input: string): string {
  return run(id, input).replace(/[‸«»]/g, '');
}

describe('bold', () => {
  it('wraps a selection', () => {
    expect(run('edit.bold', 'make «this» bold')).toBe('make **«this»** bold');
  });

  it('wraps the word under the caret when nothing is selected', () => {
    expect(run('edit.bold', 'make th‸is bold')).toBe('make **«this»** bold');
  });

  it('unwraps when already bold', () => {
    expect(run('edit.bold', 'make **«this»** bold')).toBe('make «this» bold');
  });

  it('unwraps from a caret inside the bold text', () => {
    expect(run('edit.bold', 'make **th‸is** bold')).toBe('make «this» bold');
  });

  it('leaves the caret between the markers with nothing to wrap', () => {
    expect(run('edit.bold', 'a ‸')).toBe('a **‸**');
  });
});

describe('italic', () => {
  it('wraps a selection', () => {
    expect(run('edit.italic', 'make «this» italic')).toBe('make *«this»* italic');
  });

  it('unwraps when already italic', () => {
    expect(run('edit.italic', 'make *«this»* italic')).toBe('make «this» italic');
  });

  it('adds italic to bold rather than eating one of its markers', () => {
    // `**bold**` is not italic-wrapped, so this must not produce `*bold*`.
    expect(runDoc('edit.italic', 'a **«bold»** b')).toBe('a ***bold*** b');
  });

  it('removes italic from bold-italic', () => {
    expect(runDoc('edit.italic', 'a ***«both»*** b')).toBe('a **both** b');
  });
});

describe('inline code', () => {
  it('wraps a selection', () => {
    expect(run('edit.code', 'run «npm» here')).toBe('run `«npm»` here');
  });

  it('unwraps when already code', () => {
    expect(run('edit.code', 'run `«npm»` here')).toBe('run «npm» here');
  });
});

describe('link', () => {
  it('wraps the selection and puts the caret in the URL', () => {
    expect(run('edit.link', 'see «the docs» now')).toBe('see [the docs](‸) now');
  });

  it('puts the caret in the text slot when there is nothing selected', () => {
    // With no text to link, the label is what needs typing first.
    expect(run('edit.link', 'see ‸ now')).toBe('see [‸]() now');
  });
});

describe('note link', () => {
  it('wraps the selection', () => {
    expect(runDoc('edit.wikilink', 'see «Research» now')).toBe('see [[Research]] now');
  });

  it('leaves the caret inside empty brackets', () => {
    expect(run('edit.wikilink', 'see ‸ now')).toBe('see [[‸]] now');
  });
});

describe('headings', () => {
  it('makes a paragraph into a heading', () => {
    expect(run('edit.heading1', 'Ti‸tle')).toBe('# Ti‸tle');
  });

  it('replaces an existing level rather than stacking', () => {
    expect(run('edit.heading2', '# Ti‸tle')).toBe('## Ti‸tle');
  });

  it('removes the heading when applying the level it already has', () => {
    expect(run('edit.heading1', '# Ti‸tle')).toBe('Ti‸tle');
  });

  it('clears any heading with the paragraph command', () => {
    expect(run('edit.paragraph', '### Ti‸tle')).toBe('Ti‸tle');
  });

  it('leaves a paragraph alone with the paragraph command', () => {
    expect(run('edit.paragraph', 'Ti‸tle')).toBe('Ti‸tle');
  });

  it('applies to every line of a selection', () => {
    expect(runDoc('edit.heading2', '«one\ntwo»')).toBe('## one\n## two');
  });

  it('preserves indentation', () => {
    expect(run('edit.heading1', '  Ti‸tle')).toBe('  # Ti‸tle');
  });

  it('does not stack when going from h1 to h3', () => {
    expect(runDoc('edit.heading3', '# Title')).toBe('### Title');
  });
});

describe('task', () => {
  it('turns a plain line into a task', () => {
    expect(run('edit.task', 'buy mil‸k')).toBe('- [ ] buy mil‸k');
  });

  it('turns a list item into a task, keeping the bullet', () => {
    expect(runDoc('edit.task', '* buy milk')).toBe('* [ ] buy milk');
  });

  it('completes an open task', () => {
    expect(runDoc('edit.task', '- [ ] buy milk')).toBe('- [x] buy milk');
  });

  it('clears a completed task back to plain text', () => {
    // A three-state cycle, so the same shortcut can also undo a task.
    expect(runDoc('edit.task', '- [x] buy milk')).toBe('buy milk');
  });

  it('accepts an uppercase X', () => {
    expect(runDoc('edit.task', '- [X] buy milk')).toBe('buy milk');
  });

  it('preserves indentation on a nested task', () => {
    expect(runDoc('edit.task', '  - [ ] subtask')).toBe('  - [x] subtask');
  });

  it('applies to every line of a selection', () => {
    expect(runDoc('edit.task', '«one\ntwo»')).toBe('- [ ] one\n- [ ] two');
  });

  it('turns an empty line into an empty task', () => {
    expect(run('edit.task', '‸')).toBe('- [ ] ‸');
  });

  it('leaves the rest of a task line untouched when ticking it', () => {
    expect(runDoc('edit.task', '- [ ] ship it due:2026-09-15 #work')).toBe(
      '- [x] ship it due:2026-09-15 #work',
    );
  });
});

describe('the command table', () => {
  it('implements every edit command the registry declares', () => {
    // The registry is the app's advertised surface; a gap here is a shortcut
    // that does nothing, which is what this whole module exists to prevent.
    const declared = [
      'edit.bold',
      'edit.italic',
      'edit.code',
      'edit.link',
      'edit.wikilink',
      'edit.task',
      'edit.heading1',
      'edit.heading2',
      'edit.heading3',
      'edit.paragraph',
    ];
    for (const id of declared) {
      expect(editorCommands[id], `missing implementation for ${id}`).toBeTypeOf('function');
    }
  });
});
