import { knownLanguages, renderDiagram } from '@open-note/diagrams';
import { createMarkdownEditor, type EditorView, setEditorDoc } from '@open-note/editor';
import { useEffect, useRef } from 'react';

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
}

export function NoteEditor({
  path,
  doc,
  onChange,
  resolveLink,
  onFollowLink,
  dark,
}: NoteEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Keep the latest callback reachable without rebuilding the editor, which
  // would drop undo history and focus on every keystroke.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const linkRef = useRef({ resolveLink, onFollowLink });
  linkRef.current = { resolveLink, onFollowLink };

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
      diagrams: {
        languages: knownLanguages(),
        dark,
        render: (language, source, id) => renderDiagram(language, source, { dark, id }),
      },
    });
    view.current = editor;
    editor.focus();
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Built once. Document swaps are handled below so the view survives.
  }, []);

  // Switching notes replaces the document in place rather than remounting.
  useEffect(() => {
    if (view.current) {
      setEditorDoc(view.current, doc);
      view.current.focus();
    }
    // `doc` is deliberately not a dependency: reacting to it would fight the
    // user's own typing, since every keystroke produces a new doc value.
  }, [path]);

  return <div className="editor" ref={host} />;
}
