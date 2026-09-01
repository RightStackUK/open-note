import {
  type Collection,
  collectionTitle,
  type NoteListDensity,
  type NoteListEntry,
  type NoteListSort,
} from '@open-note/core';
import { useCallback, useEffect, useRef, useState } from 'react';

interface NoteListProps {
  entries: NoteListEntry[];
  collection: Collection;
  activePath: string | null;
  sort: NoteListSort;
  descending: boolean;
  density: NoteListDensity;
  showBadges: boolean;
  onSelect: (path: string) => void;
  onCollectionChange: (collection: Collection) => void;
  onSortChange: (sort: NoteListSort) => void;
  onDescendingChange: (descending: boolean) => void;
  /** Right-click on a row, for the same file menu the tree offers. */
  onContext: (path: string, x: number, y: number) => void;
}

/** Row heights, one per density. The virtualiser depends on these being fixed. */
const ROW_HEIGHTS: Record<NoteListDensity, number> = { small: 44, medium: 64, large: 84 };

/** Rows rendered beyond the viewport on each side, so scrolling never flashes. */
const OVERSCAN = 8;

const COLLECTIONS: Collection[] = [{ kind: 'all' }, { kind: 'today' }, { kind: 'untagged' }];

function dateLabel(seconds: number): string {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(date);
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

/**
 * The note list pane: title, excerpt, date, and a badge for attachments.
 *
 * Virtualised from the start — ten thousand notes is a normal vault, and
 * retrofitting windowing into a list with per-row state is much worse than
 * never having per-row state. The window is a plain scroll calculation over
 * fixed row heights; no library carries its weight for that.
 */
export function NoteList({
  entries,
  collection,
  activePath,
  sort,
  descending,
  density,
  showBadges,
  onSelect,
  onCollectionChange,
  onSortChange,
  onDescendingChange,
  onContext,
}: NoteListProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  // A callback ref rather than an effect: the scroller unmounts whenever the
  // list is empty, and an effect that ran once would never observe its
  // replacement — leaving the window maths on a stale viewport height.
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    scroller.current = el;
    if (!el) return;
    observer.current = new ResizeObserver(() => setViewport(el.clientHeight));
    observer.current.observe(el);
    setViewport(el.clientHeight);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  // Jumping collections resets the window; keeping the old offset would show
  // the middle of a list the user has not scrolled.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [collection]);

  const rowHeight = ROW_HEIGHTS[density];
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(entries.length, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);
  const visible = entries.slice(first, last);

  return (
    <div className="note-list">
      <header className="note-list-head">
        <nav className="note-list-collections" aria-label="Collections">
          {COLLECTIONS.map((c) => (
            <button
              key={c.kind}
              type="button"
              className={`chip ${collection.kind === c.kind ? 'is-on' : ''}`}
              onClick={() => onCollectionChange(c)}
            >
              {collectionTitle(c)}
            </button>
          ))}
          {collection.kind === 'tag' && (
            <button
              type="button"
              className="chip is-on"
              title="Click to clear the tag filter"
              onClick={() => onCollectionChange({ kind: 'all' })}
            >
              {collectionTitle(collection)} ×
            </button>
          )}
        </nav>
        <div className="note-list-order">
          <select
            aria-label="Sort notes by"
            value={sort}
            onChange={(e) => onSortChange(e.target.value as NoteListSort)}
          >
            <option value="modified">Modified</option>
            <option value="created">Created</option>
            <option value="title">Title</option>
          </select>
          <button
            type="button"
            className="icon-button"
            title={descending ? 'Newest first — click to flip' : 'Oldest first — click to flip'}
            onClick={() => onDescendingChange(!descending)}
          >
            {descending ? '↓' : '↑'}
          </button>
        </div>
      </header>

      {entries.length === 0 ? (
        <p className="note-list-empty">Nothing in {collectionTitle(collection)}.</p>
      ) : (
        <div
          className="note-list-scroll"
          ref={attachScroller}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          <div style={{ height: entries.length * rowHeight, position: 'relative' }}>
            {visible.map((entry, i) => (
              <button
                type="button"
                key={entry.path}
                className={`note-row is-${density} ${entry.path === activePath ? 'is-active' : ''}`}
                style={{ top: (first + i) * rowHeight, height: rowHeight }}
                onClick={() => onSelect(entry.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContext(entry.path, e.clientX, e.clientY);
                }}
                title={entry.path}
              >
                <span className="note-row-top">
                  <span className="note-row-title">{entry.title}</span>
                  {/* Beside the date, so a small-density row keeps its badge. */}
                  {showBadges && entry.hasAttachments && (
                    <span className="note-row-badge" title="Has attachments">
                      📎
                    </span>
                  )}
                  <span className="note-row-date">{dateLabel(entry.modified)}</span>
                </span>
                {density !== 'small' && (
                  <span className="note-row-excerpt">{entry.excerpt || <em>Empty note</em>}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
