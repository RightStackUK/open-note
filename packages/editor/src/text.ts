import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

export interface CreateTextEditorOptions {
  parent: HTMLElement;
  doc?: string;
  /** Vault-relative path. Only the filename is used, to pick a language. */
  filename: string;
  readOnly?: boolean;
  onChange?: (doc: string) => void;
}

/**
 * Chrome for a file that is not a note.
 *
 * Deliberately unlike the note editor: no concealment, no wikilinks, no serif
 * measure. A `.ts` file is code, and code wants line numbers, a monospace face
 * and the full width of the pane.
 */
const textTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', color: 'var(--fg)', backgroundColor: 'var(--bg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--mono-font, ui-monospace, SFMono-Regular, Menlo, monospace)',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': { padding: '1rem 0 40vh', caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted)',
    border: 'none',
    paddingRight: '0.5rem',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--muted) 8%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
});

/**
 * Code colours, drawn from the same custom properties as the rest of the app.
 *
 * Hues are not hard-coded for the same reason the note theme avoids them: the
 * host owns the palette, so light and dark need no second definition here.
 */
export const codeHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: 'var(--accent)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--muted)',
    fontStyle: 'italic',
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--code-literal)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--code-callable)',
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--code-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--code-property)' },
  { tag: [tags.tagName], color: 'var(--accent)' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: 'var(--muted)' },
  { tag: tags.invalid, color: 'var(--danger)' },
  // Markdown and similar prose formats still read as prose inside this editor.
  { tag: tags.heading, fontWeight: '650' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
]);

/** Holds the language, which arrives after the file is already on screen. */
const languageSlot = new Compartment();

/**
 * Find the language for a filename.
 *
 * `@codemirror/language-data` describes every language it knows without loading
 * any of them, and `load()` pulls in just the one — so a vault of Markdown never
 * pays for the parsers it does not use.
 */
export function languageForFilename(filename: string): LanguageDescription | null {
  const name = filename.split('/').pop() ?? filename;
  return LanguageDescription.matchFilename(languages, name);
}

export function createTextEditor(options: CreateTextEditorOptions): EditorView {
  const { parent, doc = '', filename, readOnly = false, onChange } = options;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        rectangularSelection(),
        indentOnInput(),
        bracketMatching(),
        search({ top: true }),
        EditorView.lineWrapping,
        textTheme,
        syntaxHighlighting(codeHighlight),
        languageSlot.of([]),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorState.readOnly.of(readOnly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChange) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });

  // Highlighting arrives a tick late rather than holding the file off screen.
  void languageForFilename(filename)
    ?.load()
    .then((support) => {
      if (view.dom.isConnected) {
        view.dispatch({ effects: languageSlot.reconfigure(support) });
      }
    })
    .catch(() => {
      // A parser that will not load costs colour, not the file.
    });

  return view;
}
