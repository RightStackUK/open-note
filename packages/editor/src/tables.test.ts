import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { parseTableAt, renderTable, tableCommands } from './tables';

/**
 * `‸` marks the caret, as in `commands.test.ts`. `|` cannot be a marker here
 * for obvious reasons, which is why that convention exists in the first place.
 */
function run(id: string, input: string): string {
  const caret = input.indexOf('‸');
  const doc = caret === -1 ? input : input.replace('‸', '');
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(caret === -1 ? 0 : caret),
  });

  const command = tableCommands[id];
  if (!command) throw new Error(`no such command: ${id}`);

  let result = state;
  command({
    state,
    dispatch: (transaction) => {
      result = transaction.state;
    },
  });

  const text = result.doc.toString();
  const { head } = result.selection.main;
  return `${text.slice(0, head)}‸${text.slice(head)}`;
}

function runDoc(id: string, input: string): string {
  return run(id, input).replace('‸', '');
}

const TABLE = ['| a   | b   |', '| --- | --- |', '| 1   | 2   |'].join('\n');

describe('parseTableAt', () => {
  it('finds the table around a line', () => {
    const state = EditorState.create({ doc: TABLE });
    const table = parseTableAt(state.doc, 1);
    expect(table?.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(table?.alignments).toEqual(['none', 'none']);
  });

  it('reads alignment colons', () => {
    const state = EditorState.create({
      doc: ['| a | b | c |', '| :- | :-: | -: |', '| 1 | 2 | 3 |'].join('\n'),
    });
    expect(parseTableAt(state.doc, 1)?.alignments).toEqual(['left', 'center', 'right']);
  });

  it('rejects pipes without a delimiter row', () => {
    const state = EditorState.create({ doc: '| a | b |\n| 1 | 2 |' });
    expect(parseTableAt(state.doc, 1)).toBeNull();
  });

  it('is not confused by prose containing a pipe just above the table', () => {
    // The delimiter row anchors the table, not the run of pipe-bearing lines:
    // treating the paragraph as the header made every table command a no-op.
    const state = EditorState.create({
      doc: ['costs | more', '| a | b |', '| - | - |', '| 1 | 2 |'].join('\n'),
    });
    const table = parseTableAt(state.doc, 3);
    expect(table?.firstLine).toBe(2);
    expect(table?.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('finds the table from the header row', () => {
    const state = EditorState.create({ doc: TABLE });
    expect(parseTableAt(state.doc, 1)?.firstLine).toBe(1);
  });

  it('finds the table from the delimiter row', () => {
    const state = EditorState.create({ doc: TABLE });
    expect(parseTableAt(state.doc, 2)?.firstLine).toBe(1);
  });

  it('picks the table the cursor is in when two are adjacent', () => {
    const state = EditorState.create({
      doc: ['| a | b |', '| - | - |', '| 1 | 2 |', '| c | d |', '| - | - |', '| 3 | 4 |'].join(
        '\n',
      ),
    });
    expect(parseTableAt(state.doc, 3)?.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseTableAt(state.doc, 6)?.rows).toEqual([
      ['c', 'd'],
      ['3', '4'],
    ]);
  });

  it('treats a pipe line directly below the body as a row, as GFM does', () => {
    // GFM breaks a table at a blank line, not at a line that looks like prose,
    // so this really is the last row and rewriting it is correct.
    const state = EditorState.create({
      doc: ['| a | b |', '| - | - |', '| 1 | 2 |', 'trailing | prose'].join('\n'),
    });
    expect(parseTableAt(state.doc, 4)?.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['trailing', 'prose'],
    ]);
  });

  it('stops at a blank line below the table', () => {
    const state = EditorState.create({
      doc: ['| a | b |', '| - | - |', '| 1 | 2 |', '', 'after | it'].join('\n'),
    });
    expect(parseTableAt(state.doc, 1)?.lastLine).toBe(3);
  });

  it('keeps an escaped pipe inside a cell', () => {
    const state = EditorState.create({
      doc: ['| a | b |', '| - | - |', String.raw`| x \| y | 2 |`].join('\n'),
    });
    expect(parseTableAt(state.doc, 1)?.rows[1]).toEqual([String.raw`x \| y`, '2']);
  });
});

describe('renderTable', () => {
  it('pads every column to one width', () => {
    const rendered = renderTable({
      firstLine: 1,
      lastLine: 3,
      rows: [
        ['name', 'x'],
        ['a', 'longer'],
      ],
      alignments: ['none', 'none'],
    });
    expect(rendered).toBe(
      ['| name | x      |', '| ---- | ------ |', '| a    | longer |'].join('\n'),
    );
  });

  it('keeps the delimiter at least three dashes wide', () => {
    const rendered = renderTable({
      firstLine: 1,
      lastLine: 3,
      rows: [['a'], ['b']],
      alignments: ['none'],
    });
    expect(rendered).toContain('| --- |');
  });

  it('writes alignment colons back out', () => {
    const rendered = renderTable({
      firstLine: 1,
      lastLine: 3,
      rows: [['a', 'b', 'c']],
      alignments: ['left', 'center', 'right'],
    });
    // The colon is part of the column's width, so a 3-wide column stays 3 wide.
    expect(rendered.split('\n')[1]).toBe('| :-- | :-: | --: |');
  });
});

describe('insert table', () => {
  it('inserts an empty table on a blank line', () => {
    expect(runDoc('table.insert', '‸')).toBe(
      ['|     |     |', '| --- | --- |', '|     |     |'].join('\n'),
    );
  });

  it('inserts below existing text rather than inside it', () => {
    expect(runDoc('table.insert', 'prose‸')).toBe(
      ['prose', '', '|     |     |', '| --- | --- |', '|     |     |'].join('\n'),
    );
  });
});

describe('rows', () => {
  it('adds a row below the cursor row', () => {
    expect(runDoc('table.addRow', '| a   | b   |\n| --- | --- |\n| ‸1   | 2   |')).toBe(
      ['| a   | b   |', '| --- | --- |', '| 1   | 2   |', '|     |     |'].join('\n'),
    );
  });

  it('adds a row above the cursor row', () => {
    expect(runDoc('table.addRowAbove', '| a   | b   |\n| --- | --- |\n| ‸1   | 2   |')).toBe(
      ['| a   | b   |', '| --- | --- |', '|     |     |', '| 1   | 2   |'].join('\n'),
    );
  });

  it('adds the first body row when the cursor is on the header', () => {
    // "Above the header" would make the new row the header, so it cannot mean that.
    expect(runDoc('table.addRowAbove', '| ‸a   | b   |\n| --- | --- |\n| 1   | 2   |')).toBe(
      ['| a   | b   |', '| --- | --- |', '|     |     |', '| 1   | 2   |'].join('\n'),
    );
  });

  it('deletes the cursor row', () => {
    expect(runDoc('table.deleteRow', '| a | b |\n| - | - |\n| 1 | 2 |\n| ‸3 | 4 |')).toBe(
      ['| a   | b   |', '| --- | --- |', '| 1   | 2   |'].join('\n'),
    );
  });

  it('refuses to delete the header row', () => {
    const input = '| ‸a | b |\n| - | - |\n| 1 | 2 |';
    expect(runDoc('table.deleteRow', input)).toBe(input.replace('‸', ''));
  });

  it('moves a row down', () => {
    expect(runDoc('table.moveRowDown', '| a | b |\n| - | - |\n| ‸1 | 2 |\n| 3 | 4 |')).toBe(
      ['| a   | b   |', '| --- | --- |', '| 3   | 4   |', '| 1   | 2   |'].join('\n'),
    );
  });

  it('moves a row up', () => {
    expect(runDoc('table.moveRowUp', '| a | b |\n| - | - |\n| 1 | 2 |\n| ‸3 | 4 |')).toBe(
      ['| a   | b   |', '| --- | --- |', '| 3   | 4   |', '| 1   | 2   |'].join('\n'),
    );
  });

  it('will not move the top body row above the header', () => {
    const input = '| a | b |\n| - | - |\n| ‸1 | 2 |';
    expect(runDoc('table.moveRowUp', input)).toBe(input.replace('‸', ''));
  });
});

describe('columns', () => {
  it('adds a column after the cursor column', () => {
    expect(runDoc('table.addColumn', '| ‸a | b |\n| - | - |\n| 1 | 2 |')).toBe(
      ['| a   |     | b   |', '| --- | --- | --- |', '| 1   |     | 2   |'].join('\n'),
    );
  });

  it('adds a column before the cursor column', () => {
    expect(runDoc('table.addColumnBefore', '| ‸a | b |\n| - | - |\n| 1 | 2 |')).toBe(
      ['|     | a   | b   |', '| --- | --- | --- |', '|     | 1   | 2   |'].join('\n'),
    );
  });

  it('deletes the cursor column', () => {
    expect(runDoc('table.deleteColumn', '| a | ‸b |\n| - | - |\n| 1 | 2 |')).toBe(
      ['| a   |', '| --- |', '| 1   |'].join('\n'),
    );
  });

  it('refuses to delete the last remaining column', () => {
    const input = '| ‸a |\n| - |\n| 1 |';
    expect(runDoc('table.deleteColumn', input)).toBe(input.replace('‸', ''));
  });

  it('moves a column right, alignment with it', () => {
    // `a` was left-aligned and `b` right-aligned; both travel with their column.
    expect(runDoc('table.moveColumnRight', '| ‸a | b |\n| :- | -: |\n| 1 | 2 |')).toBe(
      ['|   b | a   |', '| --: | :-- |', '|   2 | 1   |'].join('\n'),
    );
  });

  it('will not move the first column left', () => {
    // A refused move leaves the source untouched rather than reformatting it.
    const input = '| ‸a | b |\n| - | - |\n| 1 | 2 |';
    expect(runDoc('table.moveColumnLeft', input)).toBe(input.replace('‸', ''));
  });
});

describe('alignment', () => {
  it('cycles none, left, center, right and back', () => {
    const delimiterOf = (doc: string) => doc.split('\n')[1];
    let doc = '| ‸a | b |\n| - | - |\n| 1 | 2 |';
    doc = runDoc('table.alignColumn', doc);
    expect(delimiterOf(doc)).toBe('| :-- | --- |');
    doc = runDoc('table.alignColumn', `| ‸${doc.slice(2)}`);
    expect(delimiterOf(doc)).toBe('| :-: | --- |');
    doc = runDoc('table.alignColumn', `| ‸${doc.slice(2)}`);
    expect(delimiterOf(doc)).toBe('| --: | --- |');
    doc = runDoc('table.alignColumn', `| ‸${doc.slice(2)}`);
    expect(delimiterOf(doc)).toBe('| --- | --- |');
  });
});

describe('rows written without fencing pipes', () => {
  // GFM accepts `a | b`, and assuming a leading pipe put every operation one
  // column to the left of where the caret actually was.
  const bare = 'a | b\n- | -\n1 | 2';

  it('deletes the column the caret is really in', () => {
    expect(runDoc('table.deleteColumn', 'a | ‸b\n- | -\n1 | 2')).toBe(
      ['| a   |', '| --- |', '| 1   |'].join('\n'),
    );
  });

  it('deletes the first column from a caret in it', () => {
    expect(runDoc('table.deleteColumn', '‸a | b\n- | -\n1 | 2')).toBe(
      ['| b   |', '| --- |', '| 2   |'].join('\n'),
    );
  });

  it('parses as two columns', () => {
    const state = EditorState.create({ doc: bare });
    expect(parseTableAt(state.doc, 1)?.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('a caret past the final pipe', () => {
  it('does not invent a column', () => {
    // The caret sits after the closing pipe; clamping keeps it on the last
    // real column instead of aligning a third one into existence.
    const result = runDoc('table.alignColumn', '| a | b |‸\n| - | - |\n| 1 | 2 |');
    // Still two columns, and the last real one is what got aligned.
    expect(result.split('\n')[1]).toBe('| --- | :-- |');
  });
});

describe('escaped pipes', () => {
  it('treats a pipe after two backslashes as structural, as GFM does', () => {
    // `\\` escapes itself, so the pipe that follows separates cells.
    const state = EditorState.create({
      doc: ['| a | b |', '| - | - |', '| x \\\\| y | z |'].join('\n'),
    });
    expect(parseTableAt(state.doc, 3)?.rows[1]).toEqual(['x \\\\', 'y', 'z']);
  });

  it('treats a pipe after one backslash as escaped', () => {
    const state = EditorState.create({
      doc: ['| a | b |', '| - | - |', '| x \\| y | z |'].join('\n'),
    });
    expect(parseTableAt(state.doc, 3)?.rows[1]).toEqual(['x \\| y', 'z']);
  });
});

describe('outside a table', () => {
  it('does nothing when the cursor is in prose', () => {
    expect(runDoc('table.addRow', 'just pro‸se')).toBe('just prose');
  });
});
