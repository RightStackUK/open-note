import { codeFolding, foldService, syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';

/**
 * Heading folding: a heading folds everything up to the next heading of equal
 * or higher level.
 *
 * Fold state is per-window and not persisted — a fold is a reading posture,
 * not a property of the note, and writing it anywhere would put app state in
 * the file. There is no fold gutter: the commands and the palette are the
 * interface, matching an editor whose gutters are hidden.
 */

const HEADING = /^(#{1,6})\s/;

/** A real heading per the parser — a `# comment` in a code fence is not one. */
function headingLevelAt(state: EditorState, lineFrom: number, lineText: string): number | null {
  const match = HEADING.exec(lineText);
  if (!match) return null;
  const node = syntaxTree(state).resolveInner(lineFrom, 1);
  if (!/^ATXHeading/.test(node.name) && !/^ATXHeading/.test(node.parent?.name ?? '')) return null;
  return (match[1] ?? '#').length;
}

/** The foldable range for the heading on `lineStart`'s line, if any. */
export function headingFoldRange(
  state: EditorState,
  lineStart: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  const level = headingLevelAt(state, line.from, line.text);
  if (level === null) return null;

  let last = line.number;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const next = state.doc.line(n);
    const nextLevel = headingLevelAt(state, next.from, next.text);
    if (nextLevel !== null && nextLevel <= level) break;
    last = n;
  }

  if (last === line.number) return null;
  // The section folds from the end of the heading line, so the heading itself
  // stays visible — a fold you cannot see is a fold you cannot reopen.
  return { from: line.to, to: state.doc.line(last).to };
}

export const headingFolding: Extension = [
  codeFolding({
    placeholderText: '…',
  }),
  foldService.of((state, lineStart) => headingFoldRange(state, lineStart)),
];
