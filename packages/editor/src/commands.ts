import { moveLineDown, moveLineUp } from '@codemirror/commands';
import { foldAll, foldCode, unfoldAll, unfoldCode } from '@codemirror/language';
import { type ChangeSpec, EditorSelection, type StateCommand } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { localIsoDate } from '@open-note/core';

import { renumberFootnotes } from './footnotes';
import { tableCommands } from './tables';
import { sortCompletedTasksAt, taskListAround } from './tasks';

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

const ORDERED_PREFIX = /^(\s*)(\d+)([.)])([ \t]+)/;
const QUOTE_PREFIX = /^(\s*)(>[ \t]?)/;

type BlockKind = 'list' | 'orderedList' | 'quote';

function blockPrefixMatch(text: string, kind: BlockKind): RegExpExecArray | null {
  if (kind === 'orderedList') return ORDERED_PREFIX.exec(text);
  if (kind === 'quote') return QUOTE_PREFIX.exec(text);
  return LIST_PREFIX.exec(text);
}

/** Which of the three block types, if any, a line is currently marked as. */
function currentBlockKind(text: string): BlockKind | null {
  if (ORDERED_PREFIX.test(text)) return 'orderedList';
  if (LIST_PREFIX.test(text)) return 'list';
  if (QUOTE_PREFIX.test(text)) return 'quote';
  return null;
}

/**
 * Toggle list, ordered list or quote on every selected line.
 *
 * Converting from one of these block types to another replaces the marker
 * rather than stacking a second one in front of it, and re-applying the type a
 * line already has clears it — the same two rules `setHeading` follows.
 * Numbering an ordered list is always assigned fresh, so pasted or stale
 * numbers are never carried over.
 */
function toggleBlock(kind: BlockKind): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = [];
    let ordinal = 0;

    for (const number of selectedLines(state)) {
      const line = state.doc.line(number);
      const current = currentBlockKind(line.text);
      const indent = /^\s*/.exec(line.text)?.[0] ?? '';

      if (current === kind) {
        const existing = blockPrefixMatch(line.text, kind);
        changes.push({
          from: line.from + indent.length,
          to: line.from + (existing?.[0].length ?? indent.length),
          insert: '',
        });
        continue;
      }

      const existing = current ? blockPrefixMatch(line.text, current) : null;
      const to = line.from + (existing?.[0].length ?? indent.length);
      const marker = kind === 'list' ? '- ' : kind === 'quote' ? '> ' : `${++ordinal}. `;
      changes.push({ from: line.from + indent.length, to, insert: marker });
    }

    return applyLineChanges(state, dispatch, changes, `input.${kind}`);
  };
}

const CODE_FENCE = /^(\s*)(`{3,}|~{3,})/;

/**
 * Wrap the selection in a fenced code block, caret on the info string so a
 * language can be typed straight away. Applying it again when the selection
 * already sits inside a fence removes that fence instead.
 *
 * Unlike the inline and line commands this acts on the main selection only: a
 * fence is a block, and there is no sensible reading of "wrap five separate
 * cursors in one code block". The caret lands on the info string, which is a
 * single position, so multiple carets could not be preserved anyway.
 */
const codeBlock: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const startLine = state.doc.lineAt(range.from);
  const endLine = state.doc.lineAt(range.to);
  const before = startLine.number > 1 ? state.doc.line(startLine.number - 1) : null;
  const after = endLine.number < state.doc.lines ? state.doc.line(endLine.number + 1) : null;

  // Both fences must use the same character, and the closing one must be at
  // least as long as the opening one — that is what actually pairs them in
  // CommonMark. Accepting any two fence-looking lines meant a `~~~` above and
  // an unrelated ``` below were treated as a pair and both deleted.
  const openFence = before ? CODE_FENCE.exec(before.text)?.[2] : undefined;
  const closeFence = after ? CODE_FENCE.exec(after.text)?.[2] : undefined;
  const paired =
    openFence !== undefined &&
    closeFence !== undefined &&
    openFence[0] === closeFence[0] &&
    closeFence.length >= openFence.length;

  if (before && after && paired) {
    const changes: ChangeSpec[] = [
      { from: before.from, to: before.to + 1, insert: '' },
      { from: after.from - 1, to: after.to, insert: '' },
    ];
    const shift = before.to + 1 - before.from;
    dispatch(
      state.update({
        changes,
        selection: EditorSelection.range(range.from - shift, range.to - shift),
        scrollIntoView: true,
        userEvent: 'input.codeBlock',
      }),
    );
    return true;
  }

  const fence = '```';
  const changes: ChangeSpec[] = [
    { from: startLine.from, to: startLine.from, insert: `${fence}\n` },
    { from: endLine.to, to: endLine.to, insert: `\n${fence}` },
  ];
  dispatch(
    state.update({
      changes,
      selection: EditorSelection.cursor(startLine.from + fence.length),
      scrollIntoView: true,
      userEvent: 'input.codeBlock',
    }),
  );
  return true;
};

/** Insert a thematic break, leaving the caret on a fresh line after it. */
const lineSeparator: StateCommand = ({ state, dispatch }) => {
  const transaction = state.changeByRange((range) => {
    const insert = '\n---\n\n';
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
  dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input.lineSeparator' }));
  return true;
};

const INDENT_UNIT = '  ';

/** Does this line start a list item or a task? */
function startsListItem(text: string): boolean {
  return LIST_PREFIX.test(text) || ORDERED_PREFIX.test(text);
}

/**
 * The selected lines, plus the continuation lines of any list item among them.
 *
 * A list item is its marker line and the wrapped lines beneath it, so indenting
 * only the marker line detaches the rest of the item from it. Indent has to
 * move the whole item, which is what §1.2 of the plan asks for and what makes
 * the operation reversible.
 */
function linesToIndent(state: Parameters<StateCommand>[0]['state']): number[] {
  const selected = new Set(selectedLines(state));

  for (const number of [...selected]) {
    const line = state.doc.line(number);
    if (!startsListItem(line.text)) continue;
    const indent = (/^\s*/.exec(line.text)?.[0] ?? '').length;

    // Continuations are the more-indented, non-blank, non-item lines below.
    for (let n = number + 1; n <= state.doc.lines; n++) {
      const next = state.doc.line(n);
      if (next.text.trim() === '') break;
      const nextIndent = (/^\s*/.exec(next.text)?.[0] ?? '').length;
      if (nextIndent <= indent) break;
      if (startsListItem(next.text)) break;
      selected.add(n);
    }
  }

  return [...selected].sort((a, b) => a - b);
}

/**
 * Shift every selected line one indent step, taking list continuation lines
 * with their item. The change touches only leading whitespace, so a bullet and
 * its text always move together.
 */
function shiftIndent(delta: 1 | -1): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = [];

    for (const number of linesToIndent(state)) {
      const line = state.doc.line(number);
      if (delta > 0) {
        changes.push({ from: line.from, to: line.from, insert: INDENT_UNIT });
        continue;
      }
      const removable = line.text.startsWith(INDENT_UNIT)
        ? INDENT_UNIT.length
        : line.text.startsWith('\t')
          ? 1
          : runAfter(line.text, 0, ' ');
      if (removable > 0) changes.push({ from: line.from, to: line.from + removable, insert: '' });
    }

    return applyLineChanges(state, dispatch, changes, delta > 0 ? 'input.indent' : 'input.outdent');
  };
}

/** `HH:MM` in local time, to match `localIsoDate`'s local-time date. */
function isoTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Insert the current date and/or time at the caret.
 *
 * Locale forms go through `Intl.DateTimeFormat`; the ISO forms take an
 * explicit formatter so they can reuse `localIsoDate` rather than a second
 * date-formatting implementation.
 */
function insertNow(
  options: Intl.DateTimeFormatOptions,
  format?: (date: Date) => string,
): StateCommand {
  return ({ state, dispatch }) => {
    const text = format
      ? format(new Date())
      : new Intl.DateTimeFormat(undefined, options).format(new Date());
    const transaction = state.changeByRange((range) => ({
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.cursor(range.from + text.length),
    }));
    dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input.insert' }));
    return true;
  };
}

/**
 * Set every task in the cursor's list to done or not done.
 *
 * Scoped to the contiguous run of task lines around the cursor, not the whole
 * note, so a note with more than one list only ever affects the one you are in.
 */
function setAllTasksDone(done: boolean): StateCommand {
  return ({ state, dispatch }) => {
    const range = taskListAround(state, state.selection.main.head);
    if (!range) return true;

    const { first, last } = range;
    const changes: ChangeSpec[] = [];
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      const match = TASK_PREFIX.exec(line.text);
      if (!match) continue;
      const mark = match[3] ?? ' ';
      const wantsX = done ? mark.toLowerCase() !== 'x' : mark !== ' ';
      if (!wantsX) continue;
      const box = line.from + match[0].indexOf('[') + 1;
      changes.push({ from: box, to: box + 1, insert: done ? 'x' : ' ' });
    }

    return applyLineChanges(state, dispatch, changes, 'input.taskAll');
  };
}

/**
 * Move every completed task in the cursor's list to the bottom.
 *
 * The reordering itself lives in `tasks.ts` because the automatic sort needs
 * exactly the same rule, and two implementations of "which list is this" would
 * eventually disagree.
 */
const moveCompletedToBottom: StateCommand = ({ state, dispatch }) => {
  const changes = sortCompletedTasksAt(state, state.selection.main.head);
  if (!changes) return true;
  dispatch(state.update({ changes, userEvent: 'input.taskSort' }));
  return true;
};

/**
 * Toggle `<u>…</u>` around the selection or the word under the caret.
 *
 * `<u>` and not `~text~`: the HTML renders everywhere Markdown allows inline
 * HTML, while the tilde collides with strikethrough and shows literally on the
 * forge — the plan records the decision.
 */
const toggleUnderline: StateCommand = ({ state, dispatch }) => {
  const text = state.doc.toString();
  const transaction = state.changeByRange((range) => {
    let { from, to } = range;
    if (from === to) {
      const word = wordAt(text, from);
      from = word.from;
      to = word.to;
    }

    const before = text.slice(Math.max(0, from - 3), from);
    const after = text.slice(to, to + 4);
    if (before === '<u>' && after === '</u>') {
      return {
        changes: [
          { from: from - 3, to: from, insert: '' },
          { from: to, to: to + 4, insert: '' },
        ],
        range: EditorSelection.range(from - 3, to - 3),
      };
    }

    return {
      changes: [
        { from, to: from, insert: '<u>' },
        { from: to, to, insert: '</u>' },
      ],
      range:
        from === to ? EditorSelection.cursor(from + 3) : EditorSelection.range(from + 3, to + 3),
    };
  });
  dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input.format' }));
  return true;
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
  'edit.heading4': setHeading(4),
  'edit.heading5': setHeading(5),
  'edit.heading6': setHeading(6),
  'edit.paragraph': setHeading(0),
  'edit.list': toggleBlock('list'),
  'edit.orderedList': toggleBlock('orderedList'),
  'edit.quote': toggleBlock('quote'),
  'edit.codeBlock': codeBlock,
  'edit.lineSeparator': lineSeparator,
  'edit.moveLineUp': moveLineUp,
  'edit.moveLineDown': moveLineDown,
  'edit.indentLine': shiftIndent(1),
  'edit.outdentLine': shiftIndent(-1),
  'insert.date': insertNow({ dateStyle: 'medium' }),
  'insert.dateIso': insertNow({}, (d) => localIsoDate(d)),
  'insert.dateTime': insertNow({ dateStyle: 'medium', timeStyle: 'short' }),
  'insert.dateTimeIso': insertNow({}, (d) => `${localIsoDate(d)} ${isoTime(d)}`),
  'insert.time': insertNow({ timeStyle: 'short' }),
  'insert.timeIso': insertNow({}, (d) => isoTime(d)),
  'task.markAllComplete': setAllTasksDone(true),
  'task.markAllIncomplete': setAllTasksDone(false),
  'task.moveCompletedToBottom': moveCompletedToBottom,
  'edit.highlight': toggleWrap('=='),
  'edit.underline': toggleUnderline,
  'edit.renumberFootnotes': renumberFootnotes,
  // Folding needs the fold service's state, which lives on the view — these
  // are view commands the dispatcher happens to reach through the same table.
  // On the bare EditorState the tests use they simply find nothing to fold.
  'view.foldHeading': (target) => foldCode(target as EditorView),
  'view.unfoldHeading': (target) => unfoldCode(target as EditorView),
  'view.foldAll': (target) => foldAll(target as EditorView),
  'view.unfoldAll': (target) => unfoldAll(target as EditorView),
  ...tableCommands,
};

export function isEditorCommand(id: string): boolean {
  return id in editorCommands;
}
