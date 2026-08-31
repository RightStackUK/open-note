import { createTextEditor, type EditorView } from '@open-note/editor';
import { useEffect, useRef } from 'react';

interface TextEditorProps {
  /** Vault-relative path; the filename picks the language. */
  path: string;
  doc: string;
  onChange: (doc: string) => void;
}

/**
 * The editor for files that are not notes.
 *
 * A vault is an ordinary Git repository, so it holds scratch `.txt` files,
 * config and the odd script. Listing those but refusing to open them made the
 * app less useful than the editor the user already had open beside it.
 *
 * Remounted per file rather than swapped in place, because the language is fixed
 * when the view is built — a `.ts` and a `.toml` are not the same editor.
 */
export function TextEditor({ path, doc, onChange }: TextEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    let view: EditorView | null = createTextEditor({
      parent: host.current,
      doc,
      filename: path,
      onChange: (next) => onChangeRef.current(next),
    });
    view.focus();
    return () => {
      view?.destroy();
      view = null;
    };
    // `doc` is deliberately excluded: reacting to it would rebuild the editor on
    // every keystroke. The caller remounts by key when the file changes.
  }, [path]);

  return <div className="editor text-editor" ref={host} />;
}
