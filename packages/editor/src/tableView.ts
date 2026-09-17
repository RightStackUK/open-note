import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

import { type Alignment, alignmentsFor } from './tables';
import type { WikiLinkOptions } from './wikilinks';

/**
 * GFM tables, drawn as tables.
 *
 * A table is the one construct whose source is not a readable version of
 * itself: `| a | b |` in a proportional serif, wrapped to the measure, is a
 * paragraph of pipes. So this follows the rule the rest of the editor follows —
 * the table you are in shows its source, every other one shows its rendered
 * form — and `tables.ts`'s commands keep that source padded for when you are.
 *
 * Cells are built from the same syntax tree the rest of the editor decorates,
 * rather than run through a Markdown-to-HTML renderer: a second parser would be
 * a second dialect, and the promise here is narrower than a renderer's anyway —
 * **a cell reads exactly as its line would read off the caret**. Emphasis,
 * strikethrough and code become their elements because those markers are
 * concealed off the active line; `[text](url)` stays as written because that is
 * what the editor shows today. Nothing is invented for tables alone.
 */

/** One run of cell content: an element to wrap, or text to emit. */
export type CellPart =
  | { kind: 'text'; text: string }
  | { kind: 'wikilink'; target: string; label: string }
  | { kind: 'element'; tag: 'strong' | 'em' | 'del' | 'code'; parts: CellPart[] };

export interface CellSpec {
  parts: CellPart[];
  /** Offset of the cell's text from the start of the table. */
  offset: number;
}

export interface TableSpec {
  header: CellSpec[];
  rows: CellSpec[][];
  alignments: Alignment[];
  /** Columns, taken from the widest of the header, the body and the delimiter. */
  columns: number;
}

/**
 * Nodes that become an element, keyed by the name `@lezer/markdown` gives them.
 *
 * Deliberately the same set whose markers `conceal.ts` hides: those are the
 * constructs the editor already presents rather than spells out.
 */
const ELEMENTS: Record<string, 'strong' | 'em' | 'del' | 'code'> = {
  StrongEmphasis: 'strong',
  Emphasis: 'em',
  Strikethrough: 'del',
  InlineCode: 'code',
};

/** Marker nodes that are punctuation, and so are not rendered. */
const MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark']);

/** Same shape as `wikilinks.ts`; a table cell cannot hold an alias (see below). */
const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?\]\]/g;

/**
 * Split a run of plain text into text and wikilinks.
 *
 * An aliased `[[note|label]]` cannot appear in a table cell: GFM splits a row on
 * every unescaped `|`, so the parser has already made that two cells — which is
 * what any other Markdown tool does with it too. So only the unaliased form is
 * matched here, and the brackets are dropped the way they are off the active
 * line.
 */
function splitWikiLinks(text: string): CellPart[] {
  const parts: CellPart[] = [];
  let at = 0;
  WIKILINK_RE.lastIndex = 0;
  for (const match of text.matchAll(WIKILINK_RE)) {
    if (match.index === undefined) continue;
    const target = (match[1] ?? '').trim();
    if (!target) continue;
    if (match.index > at) parts.push({ kind: 'text', text: text.slice(at, match.index) });
    parts.push({ kind: 'wikilink', target, label: target });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ kind: 'text', text: text.slice(at) });
  return parts;
}

/** Build the parts of one cell from the tree between `from` and `to`. */
function cellParts(state: EditorState, node: TreeChild, from: number, to: number): CellPart[] {
  const parts: CellPart[] = [];

  const text = (start: number, end: number) => {
    if (end <= start) return;
    // `\|` is the only way to write a pipe inside a cell, and the backslash is
    // the escape rather than content.
    const raw = state.doc.sliceString(start, end).replace(/\\\|/g, '|');
    parts.push(...splitWikiLinks(raw));
  };

  // Walked child by child rather than with `iterate`, because the nesting has
  // to survive: `**bold *and* italic**` is an `<em>` inside a `<strong>`.
  let at = from;
  let child = node.firstChild;
  while (child) {
    if (child.from >= to) break;
    if (MARKS.has(child.name)) {
      text(at, child.from);
      at = child.to;
      child = child.nextSibling;
      continue;
    }
    const tag = ELEMENTS[child.name];
    if (tag) {
      text(at, child.from);
      parts.push({
        kind: 'element',
        tag,
        parts: cellParts(state, child, child.from, child.to),
      });
      at = child.to;
      child = child.nextSibling;
      continue;
    }
    // Anything else — a link, an image, an HTML tag — is shown as written,
    // because that is how the editor shows it on a line nobody is editing.
    child = child.nextSibling;
  }
  text(at, to);

  return parts;
}

interface TreeChild {
  name: string;
  from: number;
  to: number;
  firstChild: TreeChild | null;
  nextSibling: TreeChild | null;
}

/**
 * Read a `Table` node into a spec.
 *
 * Returns null for a table with no delimiter row, which the parser does not
 * produce but a future extension might.
 */
export function tableSpecAt(state: EditorState, table: TreeChild): TableSpec | null {
  let alignments: Alignment[] | null = null;
  const header: CellSpec[] = [];
  const rows: CellSpec[][] = [];

  for (let part = table.firstChild; part; part = part.nextSibling) {
    if (part.name === 'TableDelimiter') {
      // The delimiter *row*, not one of the `|`s between cells: only the row is
      // a direct child of the table.
      alignments = alignmentsFor(state.doc.sliceString(part.from, part.to));
      continue;
    }
    if (part.name !== 'TableHeader' && part.name !== 'TableRow') continue;

    const cells: CellSpec[] = [];
    for (let cell = part.firstChild; cell; cell = cell.nextSibling) {
      if (cell.name !== 'TableCell') continue;
      cells.push({
        parts: cellParts(state, cell, cell.from, cell.to),
        offset: cell.from - table.from,
      });
    }
    if (part.name === 'TableHeader') header.push(...cells);
    else rows.push(cells);
  }

  if (!alignments) return null;

  const columns = Math.max(alignments.length, header.length, ...rows.map((row) => row.length));
  return { header, rows, alignments, columns };
}

function appendParts(into: Node, parts: CellPart[], resolve: (target: string) => string | null) {
  for (const part of parts) {
    if (part.kind === 'text') {
      into.appendChild(document.createTextNode(part.text));
      continue;
    }
    if (part.kind === 'wikilink') {
      // The same class and attribute `wikilinks.ts` gives a link, so it looks
      // and reads identically. The click cannot be left to that extension's
      // handler, though: `ignoreEvent` tells CodeMirror this widget's events
      // are not the editor's business, and that decision covers registered
      // handlers too. The cell below calls the same `onOpen` instead, so what
      // following a link *does* still has one definition.
      const resolved = resolve(part.target);
      const link = document.createElement('span');
      link.className = resolved ? 'cm-wikilink' : 'cm-wikilink cm-wikilink-missing';
      link.setAttribute('data-wikilink', part.target);
      link.title = resolved ? `Open ${resolved}` : `${part.target} — no note with this name yet`;
      link.textContent = part.label;
      into.appendChild(link);
      continue;
    }
    const element = document.createElement(part.tag);
    appendParts(element, part.parts, resolve);
    into.appendChild(element);
  }
}

const ALIGN: Record<Alignment, string> = {
  none: '',
  left: 'left',
  center: 'center',
  right: 'right',
};

/** A rendered table standing in for its source. */
class TableWidget extends WidgetType {
  constructor(
    private readonly spec: TableSpec,
    private readonly source: string,
    private readonly from: number,
    private readonly links: WikiLinkOptions | undefined,
  ) {
    super();
  }

  override eq(other: TableWidget) {
    // Position is part of identity, unlike a diagram's: a click in a cell is
    // turned into a document offset, so two identical tables must not share
    // DOM that would send the caret to the first one.
    return other.source === this.source && other.from === this.from;
  }

  override toDOM(view: EditorView) {
    const container = document.createElement('div');
    container.className = 'cm-table-block';

    const table = document.createElement('table');
    table.className = 'cm-table';

    const cell = (spec: CellSpec | undefined, column: number, head: boolean) => {
      const element = document.createElement(head ? 'th' : 'td');
      const align = ALIGN[this.spec.alignments[column] ?? 'none'];
      if (align) element.style.textAlign = align;
      if (spec) {
        appendParts(element, spec.parts, (target) => this.links?.resolve(target) ?? null);
        // Clicking a cell puts the caret in that cell's text, which is what
        // makes the rendered form editable at all: the source appears with the
        // caret already where it was clicked, rather than at the top of the
        // table.
        element.addEventListener('mousedown', (event) => {
          if (event.button !== 0) return;
          // A click on a wikilink means "go there" rather than "edit here".
          const link = (event.target as HTMLElement | null)?.closest?.('.cm-wikilink');
          const target = link?.getAttribute('data-wikilink');
          if (this.links && target) {
            event.preventDefault();
            this.links.onOpen(target, this.links.resolve(target), { alt: event.altKey });
            return;
          }
          event.preventDefault();
          view.dispatch({
            selection: { anchor: this.from + spec.offset },
            scrollIntoView: true,
          });
          view.focus();
        });
      }
      return element;
    };

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (let column = 0; column < this.spec.columns; column++) {
      headRow.appendChild(cell(this.spec.header[column], column, true));
    }
    head.appendChild(headRow);
    table.appendChild(head);

    if (this.spec.rows.length > 0) {
      const body = document.createElement('tbody');
      for (const row of this.spec.rows) {
        const tr = document.createElement('tr');
        for (let column = 0; column < this.spec.columns; column++) {
          tr.appendChild(cell(row[column], column, false));
        }
        body.appendChild(tr);
      }
      table.appendChild(body);
    }

    container.appendChild(table);
    return container;
  }

  /** The cells handle their own clicks; CodeMirror must not also act on them. */
  override ignoreEvent() {
    return true;
  }
}

export interface TableViewOptions {
  /**
   * The same options `wikiLinks` takes. A cell can hold a `[[link]]`, and a
   * rendered table must not be the one place in the note where following one
   * does nothing. Absent leaves cell links as plain text.
   */
  links?: WikiLinkOptions;
}

/**
 * Render GFM tables in place, except the one the selection is in.
 *
 * Block decorations must come from a `StateField` rather than a `ViewPlugin`,
 * for the reason `diagrams.ts` records.
 */
export function renderedTables(options: TableViewOptions = {}): Extension {
  const build = (state: EditorState): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();

    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name !== 'Table') return;

        // Editing the table means seeing its source.
        const touched = state.selection.ranges.some(
          (range) => range.to >= node.from && range.from <= node.to,
        );
        if (touched) return;

        // A table indented into a list item or a blockquote does not start at
        // the beginning of its line, and a block decoration would swallow the
        // `>` or the bullet that puts it there.
        const line = state.doc.lineAt(node.from);
        if (line.from !== node.from) return;

        const spec = tableSpecAt(state, node.node as unknown as TreeChild);
        if (!spec) return;

        builder.add(
          node.from,
          node.to,
          Decoration.replace({
            widget: new TableWidget(
              spec,
              state.doc.sliceString(node.from, node.to),
              node.from,
              options.links,
            ),
            block: true,
          }),
        );
      },
    });

    return builder.finish();
  };

  const field = StateField.define<DecorationSet>({
    create: (state) => build(state),
    update: (decorations, transaction) => {
      if (transaction.docChanged || transaction.selection) return build(transaction.state);
      return decorations.map(transaction.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return [field, tableStyles];
}

const tableStyles = EditorView.theme({
  // Scrolls rather than reflows: a table of twelve columns is data, and
  // squeezing it into the measure would make every cell one word wide.
  '.cm-table-block': {
    margin: '0.9rem 0',
    padding: '0 2rem',
    overflowX: 'auto',
  },
  '.cm-table': {
    borderCollapse: 'collapse',
    // Fills the measure and wraps long prose, rather than laying out to its
    // content width and scrolling: most cells in a real note are sentences, and
    // a table that scrolls by default hides its own right-hand column.
    width: '100%',
    fontSize: '0.88em',
    lineHeight: '1.45',
    // `.cm-content` sets `overflow-wrap: anywhere` for line wrapping, which in a
    // narrow column breaks words mid-letter: `Monorepo` came out as `Mo nor
    // epo`. A column may be as wide as its longest word.
    overflowWrap: 'normal',
    wordBreak: 'normal',
  },
  '.cm-table th, .cm-table td': {
    border: '1px solid var(--border, #ddd)',
    padding: '0.3rem 0.6rem',
    textAlign: 'left',
    verticalAlign: 'top',
  },
  '.cm-table th': {
    background: 'var(--bg-raised, transparent)',
    fontWeight: '650',
  },
  '.cm-table code': {
    fontFamily: 'var(--mono-font, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: '0.9em',
    background: 'var(--code-bg, transparent)',
    borderRadius: '3px',
    padding: '0.1em 0.3em',
  },
  '.cm-table del': {
    color: 'var(--muted, #666)',
  },
});
