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

import { concealMarkdownSyntax } from './conceal';
import { type DiagramOptions, diagramBlocks } from './diagrams';
import { markdownTheme } from './theme';
import { type WikiLinkOptions, wikiLinks } from './wikilinks';

export type { EditorView } from '@codemirror/view';
export { editorCommands, isEditorCommand } from './commands';
export { concealedRangesForTest, concealMarkdownSyntax } from './conceal';
export type { DiagramOptions, DiagramRenderResult } from './diagrams';
export { diagramBlocks } from './diagrams';
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
    concealMarkdownSyntax,
    options.wikiLinks ? wikiLinks(options.wikiLinks) : [],
    options.diagrams ? diagramBlocks(options.diagrams) : [],
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
