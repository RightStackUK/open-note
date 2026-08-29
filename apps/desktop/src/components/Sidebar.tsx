import { useState } from 'react';
import type { FileKind, VaultFile } from '../api';
import { buildTree, type TreeNode } from '../tree';

interface SidebarProps {
  files: VaultFile[];
  activePath: string | null;
  changedPaths: Set<string>;
  onSelect: (file: VaultFile) => void;
}

/** A glyph per file kind, so the tree reads at a glance. */
function kindIcon(kind: FileKind): string {
  if (kind === 'markdown') return '¶';
  if (kind === 'image') return '▣';
  if (kind === 'drawing') return '◇';
  return '·';
}

function Node({
  node,
  depth,
  activePath,
  changedPaths,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  changedPaths: Set<string>;
  onSelect: (file: VaultFile) => void;
}) {
  const [open, setOpen] = useState(true);
  const indent = { paddingLeft: `${0.5 + depth * 0.75}rem` };

  if (node.type === 'folder') {
    return (
      <li>
        <button
          type="button"
          className="tree-row tree-folder"
          style={indent}
          onClick={() => setOpen((v) => !v)}
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
                onSelect={onSelect}
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
        disabled={!openable}
        title={openable ? file.path : `${file.path} — not a note, cannot be opened`}
      >
        <span className="tree-icon">{kindIcon(file.kind)}</span>
        <span className="tree-name">{file.name}</span>
        {changedPaths.has(file.path) && <span className="tree-dot" aria-label="unsaved changes" />}
      </button>
    </li>
  );
}

export function Sidebar({ files, activePath, changedPaths, onSelect }: SidebarProps) {
  const tree = buildTree(files);

  if (files.length === 0) {
    return <p className="sidebar-empty">This vault has no files yet.</p>;
  }

  return (
    <ul className="tree-list tree-root">
      {tree.map((node) => (
        <Node
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          changedPaths={changedPaths}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
