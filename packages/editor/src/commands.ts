import { type ChangeSpec, EditorSelection, type StateCommand } from '@codemirror/state';

/**
 * The editing commands the command palette and keymap advertise.
 *
 * These live here rather than in the app so they can be tested against an
 * `EditorState` directly, and so the app keeps a single keyboard dispatcher:
 * registering them in CodeMirror's own keymap as well would mean two
 * dispatchers racing for the same binding.
 */

/** How many consecutive `ch` sit immediately before `pos`. */
function runBefore(text: string, pos: number, ch: string): number {
  let n = 0;
  while (pos - n - 1 >= 0 && text[pos - n - 1] === ch) n += 1;
  return n;
}

/** How many consecutive `ch` sit immediately at and after `pos`. */
function runAfter(text: string, pos: number, ch: string): number {
  let n = 0;
  while (pos + n < text.length && text[pos + n] === ch) n += 1;
  return n;
}

const WORD_CHAR = /[\p{L}\p{N}_'-]/u;

/** The word under the caret, or an empty range when there is none. */
function wordAt(text: string, pos: number): { from: number; to: number } {
  let from = pos;
  let to = pos;
  while (from > 0 && WORD_CHAR.test(text[from - 1] ?? '')) from -= 1;
  while (to < text.length && WORD_CHAR.test(text[to] ?? '')) to += 1;
  return { from, to };
}

/**
 * Decide whether a span is already wrapped in `marker`.
 *
 * Run lengths matter: `**bold**` is not italic-wrapped, so toggling italic on it
 * should produce `***bold***` rather than quietly turning it into `*bold*`.
 */
function isWrapped(text: string, from: number, to: number, marker: string): boolean {
  const ch = marker[0] as string;
  const before = runBefore(text, from, ch);
  const after = runAfter(text, to, ch);
  if (marker.length >= 2) return before >= marker.length && after >= marker.length;
  // Single-character markers: an odd run means this level is applied.
  if (ch === '`') return before >= 1 && after >= 1;
  return before % 2 === 1 && after % 2 === 1;
}

/** Toggle an inline marker such as `**`, `*` or a backtick. */
function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const text = state.doc.toString();

    const transaction = state.changeByRange((range) => {
      let { from, to } = range;
      if (from === to) {
        // No selection: act on the word under the caret.
        const word = wordAt(text, from);
        from = word.from;
        to = word.to;
      }

      if (isWrapped(text, from, to, marker)) {
        const changes: ChangeSpec[] = [
          { from: from - marker.length, to: from, insert: '' },
          { from: to, to: to + marker.length, insert: '' },
        ];
        return {
          changes,
          range: EditorSelection.range(from - marker.length, to - marker.length),
        };
      }

      const changes: ChangeSpec[] = [
        { from, to: from, insert: marker },
        { from: to, to, insert: marker },
      ];
      // An empty span leaves the caret between the markers, ready to type.
      return {
        changes,
        range:
          from === to
            ? EditorSelection.cursor(from + marker.length)
            : EditorSelection.range(from + marker.length, to + marker.length),
      };
    });

    dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

/**
 * Wrap the selection in a link, leaving the caret where the user must type next.
 *
 * With a selection that is the URL slot; without one it is the link text, since
 * there is nothing to link yet.
 */
/** `caretWithinClose` is how far into `close` the caret should land. */
function insertLink(open: string, close: string, caretWithinClose: number): StateCommand {
  return ({ state, dispatch }) => {
    const transaction = state.changeByRange((range) => {
      const selected = state.doc.sliceString(range.from, range.to);
      const insert = `${open}${selected}${close}`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(
          selected
            ? range.from + open.length + selected.length + caretWithinClose
            : range.from + open.length,
        ),
      };
    });
    dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input.link' }));
    return true;
  };
}

/** Every line the selection touches, as line numbers. */
function selectedLines(state: Parameters<StateCommand>[0]['state']): number[] {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

const HEADING_PREFIX = /^(\s*)(#{1,6}[ \t]+)?/;

/**
 * Apply a set of line changes and keep the caret with its text.
 *
 * These commands edit only a line's prefix rather than rewriting the line, so
 * the caret stays where the user left it. Mapping with `assoc: 1` keeps a caret
 * sitting exactly at an insertion point after the inserted text, which is what
 * "turn this empty line into a task" should feel like.
 */
function applyLineChanges(
  state: Parameters<StateCommand>[0]['state'],
  dispatch: Parameters<StateCommand>[0]['dispatch'],
  changes: ChangeSpec[],
  userEvent: string,
): boolean {
  if (changes.length === 0) return true;
  const changeSet = state.changes(changes);
  dispatch(
    state.update({
      changes: changeSet,
      selection: state.selection.map(changeSet, 1),
      scrollIntoView: true,
      userEvent,
    }),
  );
  return true;
}

/**
 * Set the heading level of every selected line.
 *
 * An existing heading is replaced rather than stacked, and applying the level a
 * line already has removes it — so the same shortcut turns a heading back into
 * a paragraph.
 */
function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = [];

    for (const number of selectedLines(state)) {
      const line = state.doc.line(number);
      const match = HEADING_PREFIX.exec(line.text);
      const indent = match?.[1] ?? '';
      const marker = match?.[2] ?? '';
      const current = marker ? marker.trimEnd().length : 0;

      // Toggling the level a line already has clears it.
      const next = current === level ? 0 : level;
      const replacement = next === 0 ? '' : `${'#'.repeat(next)} `;
      if (replacement === marker) continue;

      changes.push({
        from: line.from + indent.length,
        to: line.from + indent.length + marker.length,
        insert: replacement,
      });
    }

    return applyLineChanges(state, dispatch, changes, 'input.heading');
  };
}

/** `- [x] ` and friends: indent, then the whole task marker. */
const TASK_PREFIX = /^(\s*)([-*+][ \t]+\[([ xX])\][ \t]?)/;
/** `- ` and friends: indent, then the bullet. */
const LIST_PREFIX = /^(\s*)([-*+][ \t]+)/;

/**
 * Cycle a line through plain text, an open task and a completed task.
 *
 * A three-state cycle rather than a done/not-done toggle, so the same shortcut
 * both creates a task and gets rid of one. Anything else leaves no way back out
 * with the keyboard.
 */
const toggleTask: StateCommand = ({ state, dispatch }) => {
  const changes: ChangeSpec[] = [];

  for (const number of selectedLines(state)) {
    const line = state.doc.line(number);

    const task = TASK_PREFIX.exec(line.text);
    if (task) {
      const indent = task[1] ?? '';
      const marker = task[2] ?? '';
      const mark = task[3] ?? ' ';
      if (mark.toLowerCase() === 'x') {
        // Completed: drop the whole marker, back to plain text.
        changes.push({
          from: line.from + indent.length,
          to: line.from + indent.length + marker.length,
          insert: '',
        });
      } else {
        // Tick just the box, leaving everything else untouched.
        const box = line.text.indexOf('[', indent.length) + 1;
        changes.push({ from: line.from + box, to: line.from + box + 1, insert: 'x' });
      }
      continue;
    }

    const item = LIST_PREFIX.exec(line.text);
    if (item) {
      const at = line.from + (item[1] ?? '').length + (item[2] ?? '').length;
      changes.push({ from: at, to: at, insert: '[ ] ' });
      continue;
    }

    // Plain text, including an empty line.
    const indent = /^\s*/.exec(line.text)?.[0] ?? '';
    const at = line.from + indent.length;
    changes.push({ from: at, to: at, insert: '- [ ] ' });
  }

  return applyLineChanges(state, dispatch, changes, 'input.task');
};

/**
 * Command implementations, keyed by the ids in `@open-note/core`'s registry.
 *
 * The app looks commands up here; anything missing is a command that claims to
 * exist and does nothing, which is what this module was written to stop.
 */
export const editorCommands: Record<string, StateCommand> = {
  'edit.bold': toggleWrap('**'),
  'edit.italic': toggleWrap('*'),
  'edit.code': toggleWrap('`'),
  'edit.link': insertLink('[', ']()', 2),
  'edit.wikilink': insertLink('[[', ']]', 2),
  'edit.task': toggleTask,
  'edit.heading1': setHeading(1),
  'edit.heading2': setHeading(2),
  'edit.heading3': setHeading(3),
  'edit.paragraph': setHeading(0),
};

export function isEditorCommand(id: string): boolean {
  return id in editorCommands;
}
