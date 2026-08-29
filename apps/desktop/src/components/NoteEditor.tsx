import { createMarkdownEditor, type EditorView, setEditorDoc } from '@open-note/editor';
import { useEffect, useRef } from 'react';

interface NoteEditorProps {
  /** Identifies the open note; a change means "load a different document". */
  path: string;
  doc: string;
  onChange: (doc: string) => void;
}

export function NoteEditor({ path, doc, onChange }: NoteEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Keep the latest callback reachable without rebuilding the editor, which
  // would drop undo history and focus on every keystroke.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const editor = createMarkdownEditor({
      parent: host.current,
      doc,
      placeholder: 'Start writing…',
      onChange: (next) => onChangeRef.current(next),
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
