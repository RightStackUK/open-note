import { type CommandDefinition, formatBinding, type SearchHit } from '@open-note/core';
import { useEffect, useRef, useState } from 'react';

export type PaletteMode = 'commands' | 'notes' | 'search' | 'tags';

export interface PaletteItem {
  id: string;
  title: string;
  /** Secondary line: a path, a snippet, or a category. */
  detail?: string;
  /** Right-aligned hint, typically a keyboard shortcut. */
  hint?: string;
  /** Set apart from the matches — currently "create the note you just typed". */
  isAction?: boolean;
}

interface PaletteProps {
  mode: PaletteMode;
  query: string;
  items: PaletteItem[];
  onQueryChange: (query: string) => void;
  onChoose: (id: string) => void;
  onClose: () => void;
}

const PLACEHOLDERS: Record<PaletteMode, string> = {
  commands: 'Type a command…',
  notes: 'Go to note…',
  search: 'Search every note…',
  tags: 'Go to tag…',
};

/**
 * One overlay serving the command palette, the quick switcher and full-text
 * search. They differ only in what fills the list, and sharing the shell keeps
 * their keyboard behaviour identical — which is what makes them feel fast.
 */
export function Palette({ mode, query, items, onQueryChange, onChoose, onClose }: PaletteProps) {
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => input.current?.focus(), [mode]);
  // A changed result set invalidates the old cursor position.
  useEffect(() => setActive(0), [items]);

  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = items[active];
      if (chosen) onChoose(chosen.id);
    }
  };

  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label={PLACEHOLDERS[mode]}>
        <input
          ref={input}
          className="palette-input"
          value={query}
          placeholder={PLACEHOLDERS[mode]}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {items.length === 0 ? (
          <p className="palette-empty">
            {query.trim() ? 'Nothing matches.' : 'Start typing to search.'}
          </p>
        ) : (
          <ul className="palette-list" ref={listRef}>
            {items.map((item, i) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={[
                    'palette-item',
                    i === active ? 'is-active' : '',
                    item.isAction ? 'is-action' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onMouseMove={() => setActive(i)}
                  onClick={() => onChoose(item.id)}
                >
                  <span className="palette-title">{item.title}</span>
                  {item.detail && <span className="palette-detail">{item.detail}</span>}
                  {item.hint && <kbd className="palette-hint">{item.hint}</kbd>}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* The palette is the fastest path through the app, so it teaches its
            own keys rather than leaving them to the shortcuts panel. */}
        <footer className="palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> {mode === 'commands' ? 'run' : 'open'}
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          {items.length > 0 && (
            <span className="palette-count">
              {items.length} result{items.length === 1 ? '' : 's'}
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}

/** Turn commands into palette rows, showing each one's current shortcut. */
export function commandItems(
  commands: CommandDefinition[],
  byCommand: Map<string, string>,
  platform: 'mac' | 'other',
): PaletteItem[] {
  return commands.map((command) => {
    const binding = byCommand.get(command.id);
    return {
      id: command.id,
      title: command.title,
      detail: command.category,
      hint: binding ? formatBinding(binding, platform) : undefined,
    };
  });
}

export function searchItems(hits: SearchHit[]): PaletteItem[] {
  return hits.map((hit) => ({ id: hit.path, title: hit.title, detail: hit.snippet || hit.path }));
}

export function noteItems(notes: Array<{ path: string; title: string }>): PaletteItem[] {
  return notes.map((note) => ({ id: note.path, title: note.title, detail: note.path }));
}
