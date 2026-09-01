import { syntaxTree } from '@codemirror/language';
import {
  type ChangeSpec,
  type EditorState,
  type Extension,
  type Range,
  type StateCommand,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  WidgetType,
} from '@codemirror/view';

/**
 * Footnotes: `[^1]` references and `[^1]: …` definitions.
 *
 * References conceal to a superscript off the active line, hovering one shows
 * its definition, and `renumberFootnotes` rewrites numeric footnotes into
 * document order. The syntax renders natively on github.com.
 */

/** A reference anywhere in prose. Definitions are the same token at line start. */
const REFERENCE = /\[\^([^\]\s]+)\]/g;
const DEFINITION = /^\[\^([^\]\s]+)\]:\s*(.*)$/;

function inCode(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node.parent) {
    if (
      node.name === 'FencedCode' ||
      node.name === 'CodeBlock' ||
      node.name === 'InlineCode' ||
      node.name === 'CodeText'
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

/** Every footnote token in the document, split into references and definitions. */
function footnoteTokens(state: EditorState) {
  const references: Array<{ from: number; to: number; id: string }> = [];
  const definitions = new Map<string, { line: number; text: string }>();

  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const definition = DEFINITION.exec(line.text);
    if (definition && !inCode(state, line.from)) {
      const id = definition[1] ?? '';
      if (!definitions.has(id)) definitions.set(id, { line: n, text: definition[2] ?? '' });
      continue;
    }
    for (const match of line.text.matchAll(REFERENCE)) {
      const from = line.from + match.index;
      if (inCode(state, from)) continue;
      references.push({ from, to: from + match[0].length, id: match[1] ?? '' });
    }
  }

  return { references, definitions };
}

class SuperscriptWidget extends WidgetType {
  constructor(readonly id: string) {
    super();
  }

  override eq(other: SuperscriptWidget) {
    return other.id === this.id;
  }

  toDOM() {
    const el = document.createElement('sup');
    el.className = 'cm-footnote-ref';
    el.textContent = this.id;
    return el;
  }
}

function build(state: EditorState): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }

  const { references, definitions } = footnoteTokens(state);
  for (const reference of references) {
    if (activeLines.has(state.doc.lineAt(reference.from).number)) continue;
    decorations.push(
      Decoration.replace({ widget: new SuperscriptWidget(reference.id) }).range(
        reference.from,
        reference.to,
      ),
    );
  }

  // Definition markers get a quiet style, never concealment: the definition
  // line is the footnote's home and hiding its label would orphan the text.
  for (const [, definition] of definitions) {
    const line = state.doc.line(definition.line);
    decorations.push(Decoration.line({ class: 'cm-footnote-definition' }).range(line.from));
  }

  return Decoration.set(decorations, true);
}

const footnoteField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (decorations, transaction) => {
    if (transaction.docChanged || transaction.selection) return build(transaction.state);
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Hovering a reference shows the definition it points at. */
const footnotePreview = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  for (const match of line.text.matchAll(REFERENCE)) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (pos < from || pos > to) continue;
    if (DEFINITION.test(line.text)) return null;

    const { definitions } = footnoteTokens(view.state);
    const definition = definitions.get(match[1] ?? '');
    if (!definition) return null;

    return {
      pos: from,
      end: to,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-footnote-preview';
        dom.textContent = definition.text || '(empty footnote)';
        return { dom };
      },
    };
  }
  return null;
});

const footnoteStyles = EditorView.theme({
  '.cm-footnote-ref': {
    color: 'var(--accent)',
    fontSize: '0.75em',
    cursor: 'default',
  },
  '.cm-footnote-definition': {
    color: 'var(--muted)',
    fontSize: '0.9em',
  },
  '.cm-footnote-preview': {
    maxWidth: '28rem',
    padding: '0.4rem 0.6rem',
    fontSize: '0.85em',
  },
});

export const footnotes: Extension = [footnoteField, footnotePreview, footnoteStyles];

/**
 * Rewrite numeric footnotes into document order: the first reference becomes
 * `[^1]`, its definition follows it, and so on.
 *
 * Named footnotes (`[^caveat]`) are left exactly alone — a name is a choice,
 * and renumbering is for the numbers that drifted as notes were added and
 * removed above them.
 */
export const renumberFootnotes: StateCommand = ({ state, dispatch }) => {
  const { references, definitions } = footnoteTokens(state);

  const next = new Map<string, string>();
  let counter = 0;
  for (const reference of references) {
    if (!/^\d+$/.test(reference.id) || next.has(reference.id)) continue;
    counter += 1;
    next.set(reference.id, String(counter));
  }
  // Orphan numeric definitions renumber too, onto the numbers after the
  // referenced ones — leaving one at `[^1]` while a referenced footnote is
  // renumbered onto `1` would mint two definitions with the same id.
  for (const id of definitions.keys()) {
    if (!/^\d+$/.test(id) || next.has(id)) continue;
    counter += 1;
    next.set(id, String(counter));
  }

  const changes: ChangeSpec[] = [];
  for (const reference of references) {
    const to = next.get(reference.id);
    if (to === undefined || to === reference.id) continue;
    changes.push({
      from: reference.from + 2,
      to: reference.to - 1,
      insert: to,
    });
  }
  for (const [id, definition] of definitions) {
    const to = next.get(id);
    if (to === undefined || to === id) continue;
    const line = state.doc.line(definition.line);
    changes.push({ from: line.from + 2, to: line.from + 2 + id.length, insert: to });
  }

  if (changes.length === 0) return true;
  dispatch(state.update({ changes, userEvent: 'input.renumber' }));
  return true;
};

/** Exposed for tests. */
export function footnoteTokensForTest(state: EditorState) {
  return footnoteTokens(state);
}
