import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * Typography and chrome.
 *
 * Colours are CSS custom properties rather than literals so the host app owns
 * the palette and light/dark switching happens without rebuilding the editor.
 */
export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--note-font-size, 16px)',
    color: 'var(--fg)',
    backgroundColor: 'var(--bg)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--note-font, ui-serif, Georgia, Cambria, serif)',
    lineHeight: 'var(--note-line-height, 1.7)',
    overflow: 'auto',
  },
  // A comfortable measure, centred, the way a writing app should read. All the
  // typography settings land through these variables, so changing one reflows
  // the text without rebuilding the editor.
  '.cm-content': {
    padding: '3rem 0 40vh',
    maxWidth: 'var(--note-line-width, 46rem)',
    margin: '0 auto',
    caretColor: 'var(--accent)',
  },
  '.cm-line': {
    padding: '0 2rem var(--note-paragraph-spacing, 0)',
    textIndent: 'var(--note-paragraph-indent, 0)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-gutters': { display: 'none' },
  '.cm-placeholder': { color: 'var(--muted)', fontStyle: 'italic' },
});

/** Heading tag paired with its size, in `em` relative to the base note size. */
const HEADING_STEPS: Array<[typeof tags.heading1, number]> = [
  [tags.heading1, 1.7],
  [tags.heading2, 1.42],
  [tags.heading3, 1.22],
  [tags.heading4, 1.08],
  [tags.heading5, 1],
  [tags.heading6, 1],
];

const headingStyles = HEADING_STEPS.map(([tag, size], i) => ({
  tag,
  fontSize: `${size}em`,
  fontWeight: i < 3 ? '650' : '600',
  lineHeight: '1.3',
  fontFamily: 'var(--heading-font, var(--ui-font, ui-sans-serif, system-ui, sans-serif))',
  letterSpacing: '-0.015em',
}));

export const markdownHighlight = HighlightStyle.define([
  ...headingStyles,
  { tag: tags.strong, fontWeight: '680', color: 'var(--fg)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--muted)' },
  {
    tag: tags.monospace,
    fontFamily: 'var(--mono-font, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: '0.9em',
    backgroundColor: 'var(--code-bg)',
    borderRadius: '3px',
    padding: '0.1em 0.3em',
  },
  { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--fg)' },
  // Syntax markers stay visible on the active line; muting them keeps the
  // prose dominant rather than the punctuation.
  { tag: tags.processingInstruction, color: 'var(--muted)', fontWeight: '400' },
  { tag: tags.contentSeparator, color: 'var(--muted)' },
]);

export const markdownTheme = [editorTheme, syntaxHighlighting(markdownHighlight)];
