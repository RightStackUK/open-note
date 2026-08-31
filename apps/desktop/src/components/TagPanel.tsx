import type { TagCount } from '@open-note/core';
import { useState } from 'react';

interface TagPanelProps {
  tags: TagCount[];
  /** Notes carrying the selected tag, resolved by the caller. */
  notesForTag: (tag: string) => Array<{ path: string; title: string }>;
  onOpen: (path: string) => void;
  onClose: () => void;
  initialTag?: string | null;
}

/**
 * Every tag in the vault, and what carries it.
 *
 * This replaces running a full-text search for the tag word, which also matched
 * the word in ordinary prose and so was quietly wrong.
 */
export function TagPanel({ tags, notesForTag, onOpen, onClose, initialTag }: TagPanelProps) {
  const [selected, setSelected] = useState<string | null>(initialTag ?? null);
  const [filter, setFilter] = useState('');

  const needle = filter.trim().toLowerCase();
  const visible = needle ? tags.filter((t) => t.tag.toLowerCase().includes(needle)) : tags;
  const notes = selected ? notesForTag(selected) : [];

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
          <input
            className="tag-filter"
            value={filter}
            placeholder="Filter tags…"
            onChange={(e) => setFilter(e.target.value)}
          />

          <div className="tag-cloud">
            {visible.map(({ tag, count }) => (
              <button
                key={tag}
                type="button"
                className={`tag ${selected === tag ? 'is-selected' : ''}`}
                onClick={() => setSelected(selected === tag ? null : tag)}
              >
                #{tag}
                <span className="tag-count">{count}</span>
              </button>
            ))}
            {visible.length === 0 && <p className="muted-note">No tag matches “{filter}”.</p>}
          </div>

          {selected && (
            <section className="tag-notes">
              <h3>
                #{selected} <span className="count">{notes.length}</span>
              </h3>
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
