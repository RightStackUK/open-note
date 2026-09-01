import { splitFrontmatter } from '@open-note/core';
import { knownLanguages, renderDiagram } from '@open-note/diagrams';
import {
  type AttachmentOptions,
  type CompletionOptions,
  createMarkdownEditor,
  type EditorView,
  editorCommands,
  setEditorDoc,
} from '@open-note/editor';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

interface NoteEditorProps {
  /** Identifies the open note; a change means "load a different document". */
  path: string;
  doc: string;
  onChange: (doc: string) => void;
  /** Resolve a `[[wikilink]]` target to a note path. */
  resolveLink: (target: string) => string | null;
  /** Follow a link; `path` is null when the target has no note yet. */
  onFollowLink: (target: string, path: string | null) => void;
  /** Colour scheme, so rendered diagrams match the app. */
  dark: boolean;
  /** Storing pasted/dropped files and resolving local ones for display. */
  attachments: AttachmentOptions;
  /** Paths whose embeds are collapsed; a per-window reading posture. */
  collapsedEmbeds: Set<string>;
  /** Bumped when the file listing or image display changes, to repaint chips. */
  attachmentsStamp: unknown;
  /** `readOnly: true` frontmatter, honoured. Changing it remounts via the key. */
  readOnly: boolean;
  /** OS spell checker. Changing it remounts via the key too. */
  spellcheck: boolean;
  /** Move a task to the bottom of its list when it is ticked. */
  sortTodosOnCompletion: boolean;
  /** Vault data and the on/off switch for `[[`, `#` and `:` completion. */
  completion: CompletionOptions;
  /** Conceal Markdown syntax on every line, not just off the active one. */
  concealEverywhere: boolean;
  /** HTML→Markdown paste, URL wrapping, and the optional title lookup. */
  paste: {
    asMarkdown: boolean;
    fetchTitles: boolean;
    fetchTitle: (url: string) => Promise<string | null>;
  };
}

export interface NoteEditorHandle {
  /** Run an `edit.*` command. Returns false when the id is unknown. */
  runCommand: (id: string) => boolean;
  /** Put the caret on a 1-based line and scroll it into view. */
  goToLine: (line: number) => void;
  /** The current selection: its bounds and the text inside it. */
  selection: () => { from: number; to: number; text: string };
  /**
   * Replace `from`–`to`, but only if it still contains `expected`.
   *
   * The caller may have awaited IO since reading the selection, and a blind
   * replace would then cut text the user typed in the meantime. Returns whether
   * the replacement happened.
   */
  replaceRangeIfUnchanged: (from: number, to: number, expected: string, text: string) => boolean;
  /** Replace the selection with `text`, caret after it. For explicit pastes. */
  insertAtSelection: (text: string) => void;
  /** Insert a `#tag` line at the top or the bottom of the note. */
  insertTag: (tag: string, at: 'top' | 'bottom') => void;
  /** Scroll position and caret, for the navigation history. */
  captureView: () => { scroll: number; anchor: number };
  /** Put the reading position back, after navigating here through history. */
  restoreView: (view: { scroll: number; anchor: number }) => void;
}

export const NoteEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(function NoteEditor(
  {
    path,
    doc,
    onChange,
    resolveLink,
    onFollowLink,
    dark,
    attachments,
    sortTodosOnCompletion,
    completion,
    concealEverywhere,
    collapsedEmbeds,
    attachmentsStamp,
    readOnly,
    spellcheck,
    paste,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const editorView = useRef<EditorView | null>(null);
  // Keep the latest callback reachable without rebuilding the editor, which
  // would drop undo history and focus on every keystroke.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const linkRef = useRef({ resolveLink, onFollowLink });
  linkRef.current = { resolveLink, onFollowLink };
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const sortTodosRef = useRef(sortTodosOnCompletion);
  sortTodosRef.current = sortTodosOnCompletion;
  const completionRef = useRef(completion);
  completionRef.current = completion;
  const concealRef = useRef(concealEverywhere);
  concealRef.current = concealEverywhere;
  const pasteRef = useRef(paste);
  pasteRef.current = paste;

  // The conceal, image and chip plugins only recompute on an update, so an
  // idle editor would otherwise keep showing the old state until the next
  // keystroke. A dispatch that re-sets the selection is the cheapest
  // transaction their `docChanged || selection` checks actually notice — a
  // truly empty one is invisible to them.
  const nudge = () => {
    const view = editorView.current;
    if (view) view.dispatch({ selection: view.state.selection });
  };
  // The dependency values are triggers, not inputs: `nudge` reads nothing.
  useEffect(nudge, [concealEverywhere, collapsedEmbeds, attachmentsStamp]);

  useEffect(() => {
    if (!host.current) return;
    const editor = createMarkdownEditor({
      parent: host.current,
      doc,
      readOnly,
      spellcheck,
      placeholder: 'Start writing…',
      onChange: (next) => onChangeRef.current(next),
      // Read through refs so the editor is never rebuilt when the index changes.
      wikiLinks: {
        resolve: (target) => linkRef.current.resolveLink(target),
        onOpen: (target, resolved) => linkRef.current.onFollowLink(target, resolved),
      },
      // Read through a ref so the editor is not rebuilt when settings change.
      attachments: {
        store: (file) => attachmentsRef.current.store(file),
        resolveImage: (path) => attachmentsRef.current.resolveImage(path),
        fileMeta: (path) => attachmentsRef.current.fileMeta?.(path) ?? null,
        openFile: (path) => attachmentsRef.current.openFile?.(path),
        renderDrawing: (path) =>
          attachmentsRef.current.renderDrawing?.(path) ?? Promise.resolve(null),
        display: () => attachmentsRef.current.display?.() ?? 'full',
        isCollapsed: (path) => attachmentsRef.current.isCollapsed?.(path) ?? false,
        toggleCollapsed: (path) => attachmentsRef.current.toggleCollapsed?.(path),
      },
      // Read through a ref so toggling the setting does not rebuild the editor.
      sortTodosOnCompletion: () => sortTodosRef.current,
      concealEverywhere: () => concealRef.current,
      paste: {
        pasteAsMarkdown: () => pasteRef.current.asMarkdown,
        fetchLinkTitles: () => pasteRef.current.fetchTitles,
        fetchTitle: (url) => pasteRef.current.fetchTitle(url),
      },
      // Likewise: the sources read the index at query time, so a note added
      // since the editor mounted is offered without rebuilding anything.
      completion: {
        notes: () => completionRef.current.notes(),
        tags: () => completionRef.current.tags(),
        recency: () => completionRef.current.recency?.() ?? new Map(),
        enabled: () => completionRef.current.enabled?.() ?? true,
      },
      diagrams: {
        languages: knownLanguages(),
        dark,
        render: (language, source, id) => renderDiagram(language, source, { dark, id }),
      },
    });
    editorView.current = editor;
    editor.focus();
    return () => {
      editor.destroy();
      editorView.current = null;
    };
    // Built once. Document swaps are handled below so the view survives.
  }, []);

  // Switching notes replaces the document in place rather than remounting.
  useEffect(() => {
    if (editorView.current) {
      setEditorDoc(editorView.current, doc);
      editorView.current.focus();
    }
    // `doc` is deliberately not a dependency: reacting to it would fight the
    // user's own typing, since every keystroke produces a new doc value.
  }, [path]);

  useImperativeHandle(
    ref,
    () => ({
      runCommand(id: string) {
        const view = editorView.current;
        const command = editorCommands[id];
        if (!view || !command) return false;
        // The editor must have focus for the caret to be where the user expects.
        view.focus();
        return command(view);
      },
      goToLine(line: number) {
        const view = editorView.current;
        if (!view) return;
        // Clamp: the outline can lag the document by a keystroke.
        const target = Math.max(1, Math.min(line, view.state.doc.lines));
        const { from } = view.state.doc.line(target);
        view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
        view.focus();
      },
      selection() {
        const view = editorView.current;
        if (!view) return { from: 0, to: 0, text: '' };
        const { from, to } = view.state.selection.main;
        return { from, to, text: view.state.doc.sliceString(from, to) };
      },
      captureView() {
        const view = editorView.current;
        if (!view) return { scroll: 0, anchor: 0 };
        return { scroll: view.scrollDOM.scrollTop, anchor: view.state.selection.main.anchor };
      },
      restoreView(saved: { scroll: number; anchor: number }) {
        const view = editorView.current;
        if (!view) return;
        const anchor = Math.min(saved.anchor, view.state.doc.length);
        view.dispatch({ selection: { anchor } });
        // After layout, or the height is not there to scroll to yet.
        view.requestMeasure({
          read: () => {},
          write: () => {
            view.scrollDOM.scrollTop = saved.scroll;
          },
        });
        view.focus();
      },
      insertAtSelection(text: string) {
        const view = editorView.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          scrollIntoView: true,
          userEvent: 'input.paste',
        });
        view.focus();
      },
      insertTag(tag: string, at: 'top' | 'bottom') {
        const view = editorView.current;
        if (!view) return;
        const doc = view.state.doc.toString();
        const line = `#${tag.replace(/^#+/, '')}`;

        if (at === 'bottom') {
          const insert = doc.length === 0 ? line : doc.endsWith('\n') ? `${line}\n` : `\n\n${line}`;
          view.dispatch({ changes: { from: doc.length, to: doc.length, insert } });
          return;
        }

        // Top means below the frontmatter when there is one: a tag line above
        // the `---` would corrupt the YAML block. `splitFrontmatter` is the
        // parser's own reading of where it ends, so the two cannot disagree.
        const from = splitFrontmatter(doc).bodyOffset;
        view.dispatch({ changes: { from, to: from, insert: `${line}\n\n` } });
      },
      replaceRangeIfUnchanged(from: number, to: number, expected: string, text: string) {
        const view = editorView.current;
        if (!view) return false;
        if (to > view.state.doc.length) return false;
        if (view.state.doc.sliceString(from, to) !== expected) return false;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          scrollIntoView: true,
        });
        view.focus();
        return true;
      },
    }),
    [],
  );

  return <div className="editor" ref={host} />;
});
