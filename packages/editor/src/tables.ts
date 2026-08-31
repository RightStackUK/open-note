import { type ChangeSpec, EditorSelection, type StateCommand } from '@codemirror/state';

/**
 * GFM table editing.
 *
 * There is no CodeMirror table package, so these are hand-written. Every
 * operation parses the table under the cursor into a grid, transforms the grid,
 * and rewrites the whole table in one dispatch — so re-padding the pipes is not
 * a special case, it is the normal path. That padding is the reason to write
 * these at all: the source has to stay readable in another editor.
 *
 * The table is found by scanning lines rather than by walking the syntax tree.
 * Splitting a row on its unescaped pipes gives the same cell boundaries the
 * parser would, and it keeps these commands working on a bare `EditorState` —
 * which is how they are tested, and what `commands.ts` already assumes.
 */

export type Alignment = 'none' | 'left' | 'center' | 'right';

export interface ParsedTable {
  /** 1-based first and last line the table occupies. */
  firstLine: number;
  lastLine: number;
  /** Header row, then every body row. The delimiter row is not a row. */
  rows: string[][];
  alignments: Alignment[];
}

const DELIMITER_CELL = /^:?-{1,}:?$/;

function looksLikeRow(text: string): boolean {
  return text.includes('|') && text.trim().length > 0;
}

/**
 * Whether the pipe at `i` separates cells.
 *
 * A pipe is escaped only by an *odd* run of backslashes before it: in
 * `x \\| y` the backslashes escape each other, so the pipe is structural. A
 * naive "is the previous character a backslash" test merges two cells there and
 * every later column operation then addresses the wrong data.
 */
function isSeparator(text: string, i: number): boolean {
  if (text[i] !== '|') return false;
  let backslashes = 0;
  for (let n = i - 1; n >= 0 && text[n] === '\\'; n--) backslashes += 1;
  return backslashes % 2 === 0;
}

/** Offsets of every separating pipe in a row, in order. */
function separatorOffsets(text: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (isSeparator(text, i)) offsets.push(i);
  }
  return offsets;
}

/** Split a row on its unescaped pipes, dropping the leading and trailing ones. */
function splitRow(text: string): string[] {
  const cells: string[] = [];
  let start = 0;
  for (const at of separatorOffsets(text)) {
    cells.push(text.slice(start, at));
    start = at + 1;
  }
  cells.push(text.slice(start));

  // A well-formed row is fenced by pipes, which produce an empty cell at each
  // end. Only drop them when they are actually empty, so `a | b` still parses.
  if (cells.length > 1 && cells[0]?.trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]?.trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

function isDelimiterRow(text: string): boolean {
  if (!looksLikeRow(text)) return false;
  const cells = splitRow(text);
  return cells.length > 0 && cells.every((cell) => DELIMITER_CELL.test(cell));
}

function alignmentOf(cell: string): Alignment {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return 'none';
}

/**
 * The table containing `line`, or null when the cursor is not in one.
 *
 * The delimiter row is what anchors the table, not the run of pipe-bearing
 * lines: a paragraph mentioning `a | b` directly above a table is part of that
 * run but is not part of the table, and treating it as the header would leave
 * every table command silently doing nothing.
 */
export function parseTableAt(
  doc: { line(n: number): { text: string }; lines: number },
  line: number,
): ParsedTable | null {
  let top = line;
  while (top > 1 && looksLikeRow(doc.line(top - 1).text)) top -= 1;
  let bottom = line;
  while (bottom < doc.lines && looksLikeRow(doc.line(bottom + 1).text)) bottom += 1;

  // Every delimiter row in the run. Each one is a table, spanning from the
  // header above it to the line before the next table's header.
  const delimiters: number[] = [];
  for (let n = top + 1; n <= bottom; n++) {
    if (isDelimiterRow(doc.line(n).text)) delimiters.push(n);
  }

  for (let i = 0; i < delimiters.length; i++) {
    const delimiter = delimiters[i] as number;
    const first = delimiter - 1;
    const next = delimiters[i + 1];
    // The next table's header is the line above its delimiter, so this table
    // ends two lines before it.
    const last = next === undefined ? bottom : next - 2;
    if (last < delimiter) continue;
    // The cursor may sit on the header, the delimiter, or any body row.
    if (line < first || line > last) continue;

    const alignments = splitRow(doc.line(delimiter).text).map(alignmentOf);
    const rows: string[][] = [splitRow(doc.line(first).text)];
    for (let n = delimiter + 1; n <= last; n++) rows.push(splitRow(doc.line(n).text));

    return { firstLine: first, lastLine: last, rows, alignments };
  }

  return null;
}

/** Display width of a cell; escaped pipes take one column, not two. */
function cellWidth(cell: string): number {
  return cell.replace(/\\\|/g, '|').length;
}

function pad(cell: string, width: number, alignment: Alignment): string {
  const slack = Math.max(0, width - cellWidth(cell));
  if (alignment === 'right') return ' '.repeat(slack) + cell;
  if (alignment === 'center') {
    const left = Math.floor(slack / 2);
    return ' '.repeat(left) + cell + ' '.repeat(slack - left);
  }
  return cell + ' '.repeat(slack);
}

function delimiterCell(width: number, alignment: Alignment): string {
  // Three characters is the shortest delimiter every renderer accepts once an
  // alignment colon is present, so it is the floor for all of them.
  const inner = Math.max(3, width);
  if (alignment === 'center') return `:${'-'.repeat(inner - 2)}:`;
  if (alignment === 'left') return `:${'-'.repeat(inner - 1)}`;
  if (alignment === 'right') return `${'-'.repeat(inner - 1)}:`;
  return '-'.repeat(inner);
}

/** Render a grid back to Markdown with every column padded to one width. */
export function renderTable(table: ParsedTable): string {
  const columns = Math.max(table.alignments.length, ...table.rows.map((row) => row.length));

  const normalised = table.rows.map((row) =>
    Array.from({ length: columns }, (_, i) => row[i] ?? ''),
  );
  const alignments = Array.from<unknown, Alignment>(
    { length: columns },
    (_, i) => table.alignments[i] ?? 'none',
  );

  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(3, ...normalised.map((row) => cellWidth(row[i] ?? ''))),
  );

  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const header = line(
    normalised[0]?.map((c, i) => pad(c, widths[i] ?? 3, alignments[i] ?? 'none')) ?? [],
  );
  const delimiter = line(widths.map((w, i) => delimiterCell(w, alignments[i] ?? 'none')));
  const body = normalised
    .slice(1)
    .map((row) => line(row.map((c, i) => pad(c, widths[i] ?? 3, alignments[i] ?? 'none'))));

  return [header, delimiter, ...body].join('\n');
}

/** Which row and column the cursor sits in, both 0-based over `rows`. */
function cursorCell(
  doc: { line(n: number): { text: string; from: number } },
  table: ParsedTable,
  head: number,
): { row: number; column: number } {
  const lineNumber = docLineNumberAt(doc, table, head);
  // The delimiter row is not addressable, so a cursor on it acts on the header.
  const row = lineNumber <= table.firstLine + 1 ? 0 : lineNumber - table.firstLine - 1;

  const line = doc.line(lineNumber);
  const offset = head - line.from;
  const separators = separatorOffsets(line.text);
  let column = separators.filter((at) => at < offset).length;

  // A leading pipe makes the first cell index 1 rather than 0; a row written
  // without one (`a | b`, which GFM accepts) has no such shift, and assuming it
  // did put every operation one column to the left.
  if (line.text.trimStart().startsWith('|')) column -= 1;

  // A caret past the final pipe would otherwise address a column that does not
  // exist, and adding or aligning "it" would invent one.
  const columns = Math.max(table.alignments.length, ...table.rows.map((r) => r.length));
  return { row, column: Math.min(Math.max(0, column), Math.max(0, columns - 1)) };
}

function docLineNumberAt(
  doc: { line(n: number): { text: string; from: number } },
  table: ParsedTable,
  head: number,
): number {
  for (let n = table.firstLine; n <= table.lastLine; n++) {
    const line = doc.line(n);
    if (head >= line.from && head <= line.from + line.text.length) return n;
  }
  return table.firstLine;
}

/**
 * Rewrite the table under the cursor.
 *
 * `transform` mutates the grid in place and returns which cell the caret should
 * end up in, or null to leave it where the text moved it.
 */
function tableCommand(
  transform: (
    table: ParsedTable,
    at: { row: number; column: number },
  ) => { row: number; column: number } | null | false,
): StateCommand {
  return ({ state, dispatch }) => {
    const head = state.selection.main.head;
    const table = parseTableAt(state.doc, state.doc.lineAt(head).number);
    if (!table) return false;

    const at = cursorCell(state.doc, table, head);
    const target = transform(table, at);
    if (target === false) return true;

    const rendered = renderTable(table);
    const from = state.doc.line(table.firstLine).from;
    const to = state.doc.line(table.lastLine).to;
    if (state.doc.sliceString(from, to) === rendered && target === null) return true;

    // The caret is placed by re-measuring the rendered text rather than by
    // mapping the change: a whole-table rewrite maps every position to the same
    // place, which is not where any particular cell ended up.
    const selection = target
      ? EditorSelection.cursor(from + caretOffsetFor(rendered, target))
      : EditorSelection.cursor(Math.min(head, from + rendered.length));

    const changes: ChangeSpec = { from, to, insert: rendered };
    dispatch(state.update({ changes, selection, scrollIntoView: true, userEvent: 'input.table' }));
    return true;
  };
}

/** Offset into rendered table text of the start of a cell's content. */
function caretOffsetFor(rendered: string, at: { row: number; column: number }): number {
  const lines = rendered.split('\n');
  // Row 0 is the header; row 1 onwards skips the delimiter line.
  const lineIndex = at.row === 0 ? 0 : at.row + 1;
  const line = lines[Math.min(lineIndex, lines.length - 1)] ?? '';
  const before = lines.slice(0, Math.min(lineIndex, lines.length - 1));
  const lineStart = before.reduce((sum, l) => sum + l.length + 1, 0);

  // `renderTable` always writes a leading pipe, so the cell at `column` starts
  // just after separator number `column + 1`.
  const separators = separatorOffsets(line);
  const pipe = separators[at.column];
  if (pipe === undefined) return lineStart + line.length;

  // Land on the cell's text, past the pipe and its padding space.
  let offset = pipe + 1;
  while (offset < line.length && line[offset] === ' ') offset += 1;
  return lineStart + offset;
}

const EMPTY_TABLE = ['|     |     |', '| --- | --- |', '|     |     |'].join('\n');

/**
 * Insert a fresh 2×2 table, caret in the first header cell.
 *
 * Deliberately small: growing a table is one keystroke once the commands below
 * exist, and a dialog asking for dimensions is a dialog in the way of typing.
 */
const insertTable: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  const atLineStart = line.text.trim() === '';
  const prefix = atLineStart ? '' : '\n\n';
  const from = atLineStart ? line.from : line.to;
  const to = atLineStart ? line.to : line.to;

  dispatch(
    state.update({
      changes: { from, to, insert: `${prefix}${EMPTY_TABLE}` },
      selection: EditorSelection.cursor(from + prefix.length + 2),
      scrollIntoView: true,
      userEvent: 'input.table',
    }),
  );
  return true;
};

function emptyRow(columns: number): string[] {
  return Array.from({ length: columns }, () => '');
}

/** Insert a row below or above the cursor's row. */
function addRow(offset: 0 | 1): StateCommand {
  return tableCommand((table, at) => {
    const columns = Math.max(table.alignments.length, ...table.rows.map((r) => r.length));
    // A row above the header would become the header, so the header always
    // keeps its place and "above" means "at the top of the body".
    const index = Math.max(1, at.row + offset);
    table.rows.splice(index, 0, emptyRow(columns));
    return { row: index, column: at.column };
  });
}

/** Insert a column after or before the cursor's column. */
function addColumn(offset: 0 | 1): StateCommand {
  return tableCommand((table, at) => {
    const index = at.column + offset;
    for (const row of table.rows) row.splice(index, 0, '');
    table.alignments.splice(index, 0, 'none');
    return { row: at.row, column: index };
  });
}

/** Swap the cursor's row with its neighbour. The header never moves. */
function moveRow(delta: -1 | 1): StateCommand {
  return tableCommand((table, at) => {
    const from = at.row;
    const to = from + delta;
    if (from < 1 || to < 1 || to >= table.rows.length) return false;
    const moved = table.rows[from] as string[];
    table.rows[from] = table.rows[to] as string[];
    table.rows[to] = moved;
    return { row: to, column: at.column };
  });
}

/** Swap the cursor's column with its neighbour, alignment included. */
function moveColumn(delta: -1 | 1): StateCommand {
  return tableCommand((table, at) => {
    const from = at.column;
    const to = from + delta;
    const columns = Math.max(table.alignments.length, ...table.rows.map((r) => r.length));
    if (to < 0 || to >= columns) return false;

    for (const row of table.rows) {
      const moved = row[from] ?? '';
      row[from] = row[to] ?? '';
      row[to] = moved;
    }
    const movedAlignment = table.alignments[from] ?? 'none';
    table.alignments[from] = table.alignments[to] ?? 'none';
    table.alignments[to] = movedAlignment;

    return { row: at.row, column: to };
  });
}

/**
 * Delete the cursor's row. The header cannot be deleted: a table without one
 * does not parse as a table, so deleting it would silently destroy the rest.
 */
const deleteRow: StateCommand = tableCommand((table, at) => {
  if (at.row < 1) return false;
  table.rows.splice(at.row, 1);
  return { row: Math.min(at.row, table.rows.length - 1), column: at.column };
});

/** Delete the cursor's column, or the whole table when it is the last one. */
const deleteColumn: StateCommand = tableCommand((table, at) => {
  const columns = Math.max(table.alignments.length, ...table.rows.map((r) => r.length));
  if (columns <= 1) return false;
  for (const row of table.rows) row.splice(at.column, 1);
  table.alignments.splice(at.column, 1);
  return { row: at.row, column: Math.min(at.column, columns - 2) };
});

/**
 * Cycle the cursor column's alignment: none → left → center → right → none.
 *
 * A cycle rather than four commands, because four alignment commands is four
 * palette entries for one decision.
 */
const alignColumn: StateCommand = tableCommand((table, at) => {
  const order: Alignment[] = ['none', 'left', 'center', 'right'];
  const current = table.alignments[at.column] ?? 'none';
  const next = order[(order.indexOf(current) + 1) % order.length] as Alignment;
  table.alignments[at.column] = next;
  return { row: at.row, column: at.column };
});

export const tableCommands: Record<string, StateCommand> = {
  'table.insert': insertTable,
  'table.addRow': addRow(1),
  'table.addRowAbove': addRow(0),
  'table.addColumn': addColumn(1),
  'table.addColumnBefore': addColumn(0),
  'table.moveRowUp': moveRow(-1),
  'table.moveRowDown': moveRow(1),
  'table.moveColumnLeft': moveColumn(-1),
  'table.moveColumnRight': moveColumn(1),
  'table.deleteRow': deleteRow,
  'table.deleteColumn': deleteColumn,
  'table.alignColumn': alignColumn,
};
