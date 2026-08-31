import { knownLanguages, renderDiagram } from '@open-note/diagrams';
import {
  type AttachmentOptions,
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
  /** Storing pasted images and resolving local ones for display. */
  attachments: AttachmentOptions;
}

export interface NoteEditorHandle {
  /** Run an `edit.*` command. Returns false when the id is unknown. */
  runCommand: (id: string) => boolean;
  /** Put the caret on a 1-based line and scroll it into view. */
  goToLine: (line: number) => void;
}

export const NoteEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(function NoteEditor(
  { path, doc, onChange, resolveLink, onFollowLink, dark, attachments },
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

  useEffect(() => {
    if (!host.current) return;
    const editor = createMarkdownEditor({
      parent: host.current,
      doc,
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
    }),
    [],
  );

  return <div className="editor" ref={host} />;
});
