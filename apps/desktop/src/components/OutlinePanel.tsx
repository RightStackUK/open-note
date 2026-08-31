import type { Heading } from '@open-note/core';

interface OutlinePanelProps {
  headings: Heading[];
  words: number;
  characters: number;
  onGoToLine: (line: number) => void;
  onClose: () => void;
}

export function OutlinePanel({
  headings,
  words,
  characters,
  onGoToLine,
  onClose,
}: OutlinePanelProps) {
  // Normalise so a note starting at h2 is not indented for no reason.
  const shallowest = headings.reduce((min, h) => Math.min(min, h.level), 6);

  return (
    <aside className="settings outline">
      <header className="settings-head">
        <h2>Outline</h2>
        <button type="button" className="dismiss" onClick={onClose} aria-label="Close outline">
          ×
        </button>
      </header>

      <p className="muted-note word-count">
        {words.toLocaleString()} word{words === 1 ? '' : 's'} · {characters.toLocaleString()}{' '}
        characters
      </p>

      {headings.length === 0 ? (
        <p className="muted-note">
          No headings yet. Start a line with <code>#</code> to build an outline.
        </p>
      ) : (
        <ul className="outline-list">
          {headings.map((heading) => (
            <li key={`${heading.line}:${heading.text}`}>
              <button
                type="button"
                style={{ paddingLeft: `${0.4 + (heading.level - shallowest) * 0.85}rem` }}
                className={`outline-item is-h${heading.level}`}
                onClick={() => onGoToLine(heading.line)}
              >
                {heading.text || <em>Untitled</em>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
