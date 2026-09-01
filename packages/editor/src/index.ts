import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder as placeholderExt,
  rectangularSelection,
} from '@codemirror/view';

import { type AttachmentOptions, attachmentPaste, inlineImages } from './attachments';
import { type CompletionOptions, noteCompletion } from './completion';
import { concealMarkdown } from './conceal';
import { type DiagramOptions, diagramBlocks } from './diagrams';
import { autoSortCompletedTasks, taskCheckboxes } from './tasks';
import { markdownTheme } from './theme';
import { type WikiLinkOptions, wikiLinks } from './wikilinks';

export type { EditorView } from '@codemirror/view';
export type { AttachmentOptions } from './attachments';
export { attachmentPaste, inlineImages } from './attachments';
export { editorCommands, isEditorCommand } from './commands';
export type { CompletionNote, CompletionOptions } from './completion';
export { noteCompletion } from './completion';
export type { ConcealOptions } from './conceal';
export { concealedRangesForTest, concealMarkdown, concealMarkdownSyntax } from './conceal';
export type { DiagramOptions, DiagramRenderResult } from './diagrams';
export { diagramBlocks } from './diagrams';
export type { Alignment, ParsedTable } from './tables';
export { parseTableAt, renderTable, tableCommands } from './tables';
export {
  autoSortCompletedTasks,
  sortCompletedTasksAt,
  taskCheckboxes,
  taskListAround,
  toggleTaskAt,
} from './tasks';
export type { CreateTextEditorOptions } from './text';
export { codeHighlight, createTextEditor, languageForFilename } from './text';
export { editorTheme, markdownHighlight, markdownTheme } from './theme';
export type { WikiLinkOptions } from './wikilinks';
export { wikiLinks } from './wikilinks';

export interface CreateEditorOptions {
  parent: HTMLElement;
  doc?: string;
  placeholder?: string;
  readOnly?: boolean;
  /** Fired on every document change; the caller decides when to persist. */
  onChange?: (doc: string) => void;
  /** Extra extensions, appended last so they can override defaults. */
  extensions?: Extension[];
  /** Enables clickable `[[wikilinks]]` when provided. */
  wikiLinks?: WikiLinkOptions;
  /** Renders fenced diagram blocks in place when provided. */
  diagrams?: DiagramOptions;
  /** Accepts pasted images and renders local ones inline when provided. */
  attachments?: AttachmentOptions;
  /**
   * Move a task to the bottom of its list when it is completed.
   *
   * A callback rather than a boolean so the setting can change without
   * rebuilding the editor, which would drop undo history and focus.
   */
  sortTodosOnCompletion?: () => boolean;
  /** Enables `[[`, `#` and `:` completion when provided. */
  completion?: CompletionOptions;
  /** Conceal Markdown syntax on every line, not just off the active one. */
  concealEverywhere?: () => boolean;
}

export function markdownEditorExtensions(options: CreateEditorOptions = { parent: null as never }) {
  return [
    history(),
    drawSelection(),
    rectangularSelection(),
    highlightActiveLine(),
    indentOnInput(),
    bracketMatching(),
    // `markdownLanguage` (rather than the default) enables GFM: task lists,
    // tables and strikethrough all parse.
    markdown({ base: markdownLanguage, codeLanguages: [] }),
    // In-note find and replace. `searchKeymap` alone does nothing: its commands
    // need this extension's state to open a panel at all.
    search({ top: true }),
    EditorView.lineWrapping,
    markdownTheme,
    concealMarkdown({ everywhere: options.concealEverywhere }),
    taskCheckboxes,
    options.sortTodosOnCompletion ? autoSortCompletedTasks(options.sortTodosOnCompletion) : [],
    options.wikiLinks ? wikiLinks(options.wikiLinks) : [],
    options.diagrams ? diagramBlocks(options.diagrams) : [],
    options.attachments
      ? [attachmentPaste(options.attachments), inlineImages(options.attachments)]
      : [],
    // Before the keymaps below, so an open completion panel gets Escape and the
    // arrow keys before the editor's own bindings claim them.
    options.completion ? noteCompletion(options.completion) : [],
    // markdownKeymap comes first so its Enter wins over the default one:
    // that is what continues a list instead of just breaking the line.
    keymap.of([
      ...markdownKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    options.placeholder ? placeholderExt(options.placeholder) : [],
  ];
}

export function createMarkdownEditor(options: CreateEditorOptions): EditorView {
  const { parent, doc = '', readOnly = false, onChange, extensions = [] } = options;

  const state = EditorState.create({
    doc,
    extensions: [
      markdownEditorExtensions(options),
      EditorState.readOnly.of(readOnly),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && onChange) onChange(update.state.doc.toString());
      }),
      ...extensions,
    ],
  });

  return new EditorView({ state, parent });
}

/**
 * Replace the whole document without discarding the editor.
 *
 * Used when switching notes and when an external change lands. The undo history
 * is intentionally left intact: the alternative is recreating the view, which
 * loses scroll position and focus on every note switch.
 */
export function setEditorDoc(view: EditorView, doc: string) {
  if (view.state.doc.toString() === doc) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: doc },
    selection: { anchor: Math.min(view.state.selection.main.anchor, doc.length) },
  });
}
