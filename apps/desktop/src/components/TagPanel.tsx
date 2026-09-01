import { searchEmoji, type TagCount } from '@open-note/core';
import { useMemo, useState } from 'react';

interface TagPanelProps {
  tags: TagCount[];
  /** Notes carrying the selected tag, resolved by the caller. */
  notesForTag: (tag: string) => Array<{ path: string; title: string }>;
  /** Distinct notes per tag family — a note with parent and child counts once. */
  familyCounts: Map<string, number>;
  pinnedTags: string[];
  tagIcons: Record<string, string>;
  sort: 'name' | 'count';
  onSortChange: (sort: 'name' | 'count') => void;
  onTogglePin: (tag: string) => void;
  onSetIcon: (tag: string, icon: string | null) => void;
  /** Rename `tag` and its children everywhere; the count is shown first. */
  onRename: (tag: string, noteCount: number) => void;
  /** Remove `tag` and its children from every note; never deletes notes. */
  onDelete: (tag: string, noteCount: number) => void;
  onOpen: (path: string) => void;
  /** Show the tag's notes in the list pane. */
  onShowInList: (tag: string) => void;
  onClose: () => void;
  initialTag?: string | null;
}

interface TagNode {
  /** Full tag path, `work/urgent`. */
  tag: string;
  /** Leaf name, `urgent`. */
  name: string;
  /** Notes carrying exactly this tag. */
  own: number;
  /** Notes carrying this tag or any child. */
  total: number;
  children: TagNode[];
}

/** `#a/b/c` parses; this is where the hierarchy finally renders. */
function buildTagTree(tags: TagCount[], familyCounts: Map<string, number>): TagNode[] {
  const roots: TagNode[] = [];
  const byPath = new Map<string, TagNode>();

  const nodeFor = (path: string): TagNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf('/');
    const node: TagNode = {
      tag: path,
      name: path.slice(slash + 1),
      own: 0,
      total: 0,
      children: [],
    };
    byPath.set(path, node);
    if (slash === -1) roots.push(node);
    else nodeFor(path.slice(0, slash)).children.push(node);
    return node;
  };

  for (const { tag, count } of tags) {
    nodeFor(tag).own = count;
  }
  // The total is what selecting the node would list — distinct notes across
  // the family, supplied by the index. Summing children here would count a
  // note carrying both parent and child twice.
  const fill = (node: TagNode) => {
    node.total = familyCounts.get(node.tag) ?? node.own;
    for (const child of node.children) fill(child);
  };
  for (const root of roots) fill(root);
  return roots;
}

function sortTree(nodes: TagNode[], sort: 'name' | 'count'): TagNode[] {
  const sorted = [...nodes].sort((a, b) =>
    sort === 'count'
      ? b.total - a.total || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name),
  );
  for (const node of sorted) node.children = sortTree(node.children, sort);
  return sorted;
}

function TagRow({
  node,
  depth,
  collapsed,
  onToggle,
  selected,
  onSelect,
  icons,
  pinned,
}: {
  node: TagNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (tag: string) => void;
  selected: string | null;
  onSelect: (tag: string) => void;
  icons: Record<string, string>;
  pinned: Set<string>;
}) {
  const open = !collapsed.has(node.tag);
  return (
    <li>
      <div
        className={`tag-tree-row ${selected === node.tag ? 'is-selected' : ''}`}
        style={{ paddingLeft: `${depth * 0.85}rem` }}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            className="tag-tree-caret"
            aria-expanded={open}
            onClick={() => onToggle(node.tag)}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="tag-tree-caret" />
        )}
        <button type="button" className="tag-tree-name" onClick={() => onSelect(node.tag)}>
          <span className="tag-tree-icon">{icons[node.tag] ?? '#'}</span>
          {node.name}
          {pinned.has(node.tag) && <span title="Pinned"> ★</span>}
          <span className="tag-count">{node.total}</span>
        </button>
      </div>
      {open && node.children.length > 0 && (
        <ul className="tag-tree">
          {node.children.map((child) => (
            <TagRow
              key={child.tag}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              selected={selected}
              onSelect={onSelect}
              icons={icons}
              pinned={pinned}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The tag browser: a collapsible tree over `#a/b/c`, sortable, with pins,
 * icons, and the management verbs — rename and delete, both vault-wide and
 * both announced with the number of notes they will touch.
 */
export function TagPanel({
  tags,
  notesForTag,
  familyCounts,
  pinnedTags,
  tagIcons,
  sort,
  onSortChange,
  onTogglePin,
  onSetIcon,
  onRename,
  onDelete,
  onOpen,
  onShowInList,
  onClose,
  initialTag,
}: TagPanelProps) {
  const [selected, setSelected] = useState<string | null>(initialTag ?? null);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [pickingIcon, setPickingIcon] = useState(false);
  const [iconQuery, setIconQuery] = useState('');

  const needle = filter.trim().toLowerCase();
  const visible = needle ? tags.filter((t) => t.tag.toLowerCase().includes(needle)) : tags;
  const tree = useMemo(
    () => sortTree(buildTagTree(visible, familyCounts), sort),
    [visible, familyCounts, sort],
  );
  const pinnedSet = useMemo(() => new Set(pinnedTags), [pinnedTags]);
  const pinnedVisible = pinnedTags.filter((tag) => tags.some((t) => t.tag === tag));

  const notes = selected ? notesForTag(selected) : [];

  const toggle = (tag: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(tag)) next.add(tag);
      return next;
    });

  const allParents = useMemo(() => {
    const parents = new Set<string>();
    const walk = (nodes: TagNode[]) => {
      for (const node of nodes) {
        if (node.children.length > 0) {
          parents.add(node.tag);
          walk(node.children);
        }
      }
    };
    walk(tree);
    return parents;
  }, [tree]);

  return (
    <aside className="settings tags-panel">
      <header className="settings-head">
        <h2>Tags</h2>
        <button type="button" className="dismiss" onClick={onClose} aria-label="Close tags">
          ×
        </button>
      </header>

      {tags.length === 0 ? (
        <p className="muted-note">
          No tags yet. Write <code>#something</code> in a note, or add a <code>tags:</code> list to
          its frontmatter.
        </p>
      ) : (
        <>
          <div className="tag-tools">
            <input
              className="tag-filter"
              value={filter}
              placeholder="Filter tags…"
              onChange={(e) => setFilter(e.target.value)}
            />
            <select
              aria-label="Sort tags"
              value={sort}
              onChange={(e) => onSortChange(e.target.value as 'name' | 'count')}
            >
              <option value="count">By count</option>
              <option value="name">By name</option>
            </select>
            <button
              type="button"
              className="icon-button"
              title="Expand all"
              onClick={() => setCollapsed(new Set())}
            >
              ⊞
            </button>
            <button
              type="button"
              className="icon-button"
              title="Collapse all"
              onClick={() => setCollapsed(new Set(allParents))}
            >
              ⊟
            </button>
          </div>

          {pinnedVisible.length > 0 && !needle && (
            <div className="tag-row tag-pinned-row">
              {pinnedVisible.map((tag) => (
                <button key={tag} type="button" className="tag" onClick={() => setSelected(tag)}>
                  {tagIcons[tag] ?? '★'} {tag}
                </button>
              ))}
            </div>
          )}

          <ul className="tag-tree tag-tree-root">
            {tree.map((node) => (
              <TagRow
                key={node.tag}
                node={node}
                depth={0}
                collapsed={needle ? new Set() : collapsed}
                onToggle={toggle}
                selected={selected}
                onSelect={(tag) => setSelected(selected === tag ? null : tag)}
                icons={tagIcons}
                pinned={pinnedSet}
              />
            ))}
          </ul>
          {visible.length === 0 && <p className="muted-note">No tag matches “{filter}”.</p>}

          {selected && (
            <section className="tag-notes">
              <h3>
                {tagIcons[selected] ?? '#'}
                {selected} <span className="count">{notes.length}</span>
              </h3>

              <div className="tag-actions">
                <button type="button" onClick={() => onShowInList(selected)}>
                  Show in list
                </button>
                <button type="button" onClick={() => onTogglePin(selected)}>
                  {pinnedSet.has(selected) ? 'Unpin' : 'Pin'}
                </button>
                <button type="button" onClick={() => setPickingIcon((v) => !v)}>
                  Icon…
                </button>
                <button type="button" onClick={() => onRename(selected, notes.length)}>
                  Rename…
                </button>
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => onDelete(selected, notes.length)}
                >
                  Delete…
                </button>
              </div>

              {pickingIcon && (
                <div className="tag-icon-picker">
                  <input
                    value={iconQuery}
                    placeholder="Search emoji…"
                    onChange={(e) => setIconQuery(e.target.value)}
                  />
                  <div className="tag-icon-grid">
                    {tagIcons[selected] && (
                      <button
                        type="button"
                        title="Remove icon"
                        onClick={() => {
                          onSetIcon(selected, null);
                          setPickingIcon(false);
                        }}
                      >
                        ∅
                      </button>
                    )}
                    {searchEmoji(iconQuery, 24).map((emoji) => (
                      <button
                        key={emoji.shortcode}
                        type="button"
                        title={`:${emoji.shortcode}:`}
                        onClick={() => {
                          onSetIcon(selected, emoji.char);
                          setPickingIcon(false);
                        }}
                      >
                        {emoji.char}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <ul className="backlink-list">
                {notes.map((note) => (
                  <li key={note.path}>
                    <button type="button" onClick={() => onOpen(note.path)}>
                      <span className="backlink-title">{note.title}</span>
                      <span className="backlink-path">{note.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </aside>
  );
}
