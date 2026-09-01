import { useEffect, useRef, useState } from 'react';

export interface ContextTarget {
  /** Vault-relative path; the empty string means the vault root. */
  path: string;
  kind: 'file' | 'folder' | 'root';
  x: number;
  y: number;
}

interface ContextMenuProps {
  target: ContextTarget;
  onNewNote: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  /** Bulk export of a folder (or the vault root). */
  onExportFolder: (folder: string, mode: 'files' | 'merged') => void;
  onReveal: (path: string) => void;
  onOpenWith: (path: string) => void;
  /** Move into (or back out of) the archive folder. */
  onArchive: (path: string) => void;
  isArchived: (path: string) => boolean;
  /** Merge every note under a folder into one. */
  onMergeFolder: (folder: string) => void;
  onClose: () => void;
}

/** The folder an action should happen in, given what was right-clicked. */
function parentOf(target: ContextTarget): string {
  if (target.kind === 'folder') return target.path;
  if (target.kind === 'root') return '';
  const slash = target.path.lastIndexOf('/');
  return slash === -1 ? '' : target.path.slice(0, slash);
}

export function ContextMenu({
  target,
  onNewNote,
  onNewFolder,
  onRename,
  onDelete,
  onExportFolder,
  onReveal,
  onOpenWith,
  onArchive,
  isArchived,
  onMergeFolder,
  onClose,
}: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Capture, so a click anywhere closes the menu before it does anything else.
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const parent = parentOf(target);
  const isRoot = target.kind === 'root';

  return (
    <div
      ref={menu}
      className="context-menu"
      // Positioned at the pointer, clamped so it cannot open off-screen.
      style={{
        left: Math.min(target.x, window.innerWidth - 200),
        top: Math.min(target.y, window.innerHeight - 160),
      }}
      role="menu"
    >
      <button type="button" onClick={() => onNewNote(parent)}>
        New note{parent ? ` in ${parent.split('/').pop()}` : ''}
      </button>
      <button type="button" onClick={() => onNewFolder(parent)}>
        New folder
      </button>
      {target.kind !== 'file' && (
        <>
          <button type="button" onClick={() => onExportFolder(parent, 'files')}>
            Export notes as HTML…
          </button>
          <button type="button" onClick={() => onExportFolder(parent, 'merged')}>
            Export as one HTML file…
          </button>
          <button type="button" onClick={() => onMergeFolder(parent)}>
            Merge notes into one…
          </button>
        </>
      )}
      {target.kind === 'file' && /\.(md|markdown|mdown|mkd)$/i.test(target.path) && (
        <button type="button" onClick={() => onArchive(target.path)}>
          {isArchived(target.path) ? 'Unarchive' : 'Archive'}
        </button>
      )}
      {!isRoot && (
        <>
          <hr />
          <button type="button" onClick={() => onReveal(target.path)}>
            Reveal in file manager
          </button>
          {target.kind === 'file' && (
            <button type="button" onClick={() => onOpenWith(target.path)}>
              Open in default app
            </button>
          )}
          <hr />
          <button type="button" onClick={() => onRename(target.path)}>
            Rename…
          </button>
          <button type="button" className="danger" onClick={() => onDelete(target.path)}>
            Delete…
          </button>
        </>
      )}
    </div>
  );
}

interface PromptProps {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  hint?: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

/** A single-field dialog, for naming a new note, folder, or a rename. */
export function Prompt({
  title,
  label,
  initial = '',
  confirmLabel = 'Create',
  hint,
  onConfirm,
  onClose,
}: PromptProps) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    // Select the name but not the extension, which is what a rename usually wants.
    const dot = initial.lastIndexOf('.');
    if (dot > 0) input.current?.setSelectionRange(0, dot);
    else input.current?.select();
  }, [initial]);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="prompt" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <label className="clone-field">
          <span>{label}</span>
          <input
            ref={input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onClose();
            }}
          />
        </label>
        {hint && <p className="muted-note">{hint}</p>}
        <div className="clone-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={submit} disabled={!value.trim()}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ConfirmDeleteProps {
  path: string;
  /** Whether git has this path in a commit. */
  tracked: boolean | null;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Deleting is permanent — there is no trash.
 *
 * For a committed note git history is the way back, and the dialog says so. For
 * one that has never been committed there is no way back at all, and saying that
 * plainly is the whole difference between a safe delete and a lost note.
 */
interface ConfirmActionProps {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}

/** A yes/no question, for actions whose weight the user should hear first. */
export function ConfirmAction({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: ConfirmActionProps) {
  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="prompt" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p className="muted-note">{body}</p>
        <div className="prompt-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDelete({ path, tracked, onConfirm, onClose }: ConfirmDeleteProps) {
  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="prompt" role="dialog" aria-modal="true" aria-label="Delete">
        <h2>Delete {path.split('/').pop()}?</h2>
        <p className="muted-note">
          <code>{path}</code>
        </p>

        {tracked === null ? (
          <p className="muted-note">Checking whether this is saved in git…</p>
        ) : tracked ? (
          <p className="muted-note">
            This is committed, so you can bring it back from the note's history or with{' '}
            <code>git revert</code>.
          </p>
        ) : (
          <p className="error">
            This has never been committed, so there is nothing in git to restore from. Deleting it
            cannot be undone.
          </p>
        )}

        <div className="clone-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary danger-button" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
