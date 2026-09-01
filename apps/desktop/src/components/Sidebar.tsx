import { useMemo, useState } from 'react';
import type { FileKind, VaultFile } from '../api';
import { buildTree, type TreeNode } from '../tree';

interface SidebarProps {
  files: VaultFile[];
  activePath: string | null;
  changedPaths: Set<string>;
  onSelect: (file: VaultFile) => void;
  /** Vault-relative paths shown in a pinned section above the tree. */
  pinned?: string[];
  /** Right-click on a row, or on the empty space below the tree. */
  onContext: (path: string, kind: 'file' | 'folder' | 'root', x: number, y: number) => void;
  /** Create at the vault root, from the header buttons. */
  onNewNote: () => void;
  onNewFolder: () => void;
  /** Move an entry by dragging it onto a folder. */
  onMove: (from: string, toFolder: string) => void;
}

/** A glyph per file kind, so the tree reads at a glance. */
function kindIcon(kind: FileKind): string {
  if (kind === 'markdown') return '¶';
  if (kind === 'image') return '▣';
  if (kind === 'drawing') return '◇';
  if (kind === 'pdf') return '⬒';
  if (kind === 'text') return '‹›';
  return '·';
}

/**
 * What to show for a file.
 *
 * `.md` is on every other row, so it carries no information and only costs
 * width — the same call Obsidian and Notion make. Other extensions stay,
 * because there the type is the point.
 */
function displayName(file: VaultFile): string {
  const name = file.name || file.path.slice(file.path.lastIndexOf('/') + 1);
  return file.kind === 'markdown' ? name.replace(/\.md$/i, '') : name;
}

function Node({
  node,
  depth,
  activePath,
  changedPaths,
  collapsed,
  onToggleFolder,
  onSelect,
  onContext,
  onMove,
  dropTarget,
  setDropTarget,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  changedPaths: Set<string>;
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
  onSelect: (file: VaultFile) => void;
  onContext: SidebarProps['onContext'];
  onMove: SidebarProps['onMove'];
  dropTarget: string | null;
  setDropTarget: (path: string | null) => void;
}) {
  const indent = { paddingLeft: `${0.5 + depth * 0.75}rem` };

  if (node.type === 'folder') {
    const open = !collapsed.has(node.path);
    return (
      <li>
        <button
          type="button"
          className={`tree-row tree-folder ${dropTarget === node.path ? 'is-drop' : ''}`}
          style={indent}
          onClick={() => onToggleFolder(node.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onContext(node.path, 'folder', e.clientX, e.clientY);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(node.path);
          }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(null);
            const from = e.dataTransfer.getData('text/open-note-path');
            if (from) onMove(from, node.path);
          }}
          aria-expanded={open}
        >
          <span className="tree-caret">{open ? '▾' : '▸'}</span>
          <span className="tree-name">{node.name}</span>
        </button>
        {open && (
          <ul className="tree-list">
            {node.children.map((child) => (
              <Node
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                changedPaths={changedPaths}
                collapsed={collapsed}
                onToggleFolder={onToggleFolder}
                onSelect={onSelect}
                onContext={onContext}
                onMove={onMove}
                dropTarget={dropTarget}
                setDropTarget={setDropTarget}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const { file } = node;
  // Non-markdown files are shown but never opened in the editor — the tree stays
  // honest about what the repo contains without pretending to be an IDE.
  const openable = file.kind !== 'other';

  return (
    <li>
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/open-note-path', file.path);
          e.dataTransfer.effectAllowed = 'move';
        }}
        className={[
          'tree-row',
          'tree-file',
          activePath === file.path ? 'is-active' : '',
          openable ? '' : 'is-inert',
          changedPaths.has(file.path) ? 'is-changed' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={indent}
        onClick={() => openable && onSelect(file)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContext(file.path, 'file', e.clientX, e.clientY);
        }}
        title={openable ? file.path : `${file.path} — not a text file, cannot be opened`}
      >
        <span className="tree-icon">{kindIcon(file.kind)}</span>
        <span className="tree-name">{displayName(file)}</span>
        {changedPaths.has(file.path) && <span className="tree-dot" aria-label="unsaved changes" />}
      </button>
    </li>
  );
}

export function Sidebar({
  files,
  activePath,
  changedPaths,
  onSelect,
  onContext,
  onNewNote,
  onNewFolder,
  onMove,
  pinned = [],
}: SidebarProps) {
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(
    () => (needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files),
    [files, needle],
  );
  const tree = useMemo(() => buildTree(visible), [visible]);

  const toggleFolder = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  // Only pins that still exist; a deleted note should not linger in the list.
  const pinnedFiles = pinned
    .map((path) => files.find((file) => file.path === path))
    .filter((file): file is VaultFile => Boolean(file));

  // Right-clicking the empty area below the tree targets the vault root, which
  // is how you make a note or folder at the top level.
  const rootContext = (e: React.MouseEvent) => {
    e.preventDefault();
    onContext('', 'root', e.clientX, e.clientY);
  };

  const header = (
    <div className="sidebar-tools">
      <input
        className="sidebar-filter"
        type="search"
        value={filter}
        placeholder="Filter notes…"
        aria-label="Filter notes by name"
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setFilter('');
        }}
      />
      <button type="button" className="icon-button" title="New note (⌘N)" onClick={onNewNote}>
        ＋
      </button>
      <button
        type="button"
        className="icon-button"
        title="New folder (⇧⌘N)"
        onClick={onNewFolder}
        aria-label="New folder"
      >
        ⊞
      </button>
    </div>
  );

  return (
    <div
      className="tree-root-area"
      onContextMenu={rootContext}
      onDragOver={(e) => {
        e.preventDefault();
        setDropTarget('');
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropTarget(null);
        const from = e.dataTransfer.getData('text/open-note-path');
        if (from) onMove(from, '');
      }}
    >
      {header}

      {files.length === 0 ? (
        <p className="sidebar-empty">
          This vault has no notes yet. Press ＋ above, or right-click here.
        </p>
      ) : (
        <>
          {pinnedFiles.length > 0 && !needle && (
            <section className="pinned">
              <h3>Pinned</h3>
              <ul className="tree-list">
                {pinnedFiles.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={`tree-row tree-file ${activePath === file.path ? 'is-active' : ''}`}
                      onClick={() => onSelect(file)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onContext(file.path, 'file', e.clientX, e.clientY);
                      }}
                      title={file.path}
                    >
                      <span className="tree-icon">★</span>
                      <span className="tree-name">{displayName(file)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {visible.length === 0 ? (
            <p className="sidebar-empty">No note matches “{filter.trim()}”.</p>
          ) : (
            <ul className="tree-list tree-root">
              {tree.map((node) => (
                <Node
                  key={node.path}
                  node={node}
                  depth={0}
                  activePath={activePath}
                  changedPaths={changedPaths}
                  // A filtered tree is a set of answers, so it is always open.
                  collapsed={needle ? EMPTY : collapsed}
                  onToggleFolder={toggleFolder}
                  onSelect={onSelect}
                  onContext={onContext}
                  onMove={onMove}
                  dropTarget={dropTarget}
                  setDropTarget={setDropTarget}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

const EMPTY: Set<string> = new Set();
