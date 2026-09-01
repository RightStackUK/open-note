import type { Backlink, Heading, NoteStats } from '@open-note/core';

export type InfoTab = 'stats' | 'outline' | 'backlinks';

interface InfoPanelProps {
  path: string;
  tab: InfoTab;
  onTabChange: (tab: InfoTab) => void;
  stats: NoteStats;
  /** Epoch seconds; null when the note has never been committed. */
  created: number | null;
  /** Epoch seconds; 0 when unknown. */
  modified: number;
  headings: Heading[];
  onGoToLine: (line: number) => void;
  backlinks: Backlink[];
  tags: string[];
  mentions: Array<{ path: string; title: string }>;
  onOpen: (path: string) => void;
  onSelectTag: (tag: string) => void;
  onLinkMention: (mentioningPath: string) => void;
  onClose: () => void;
}

const TABS: Array<{ id: InfoTab; label: string }> = [
  { id: 'stats', label: 'Statistics' },
  { id: 'outline', label: 'Outline' },
  { id: 'backlinks', label: 'Backlinks' },
];

function dateLabel(seconds: number | null): string {
  if (!seconds) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(seconds * 1000),
  );
}

/**
 * One panel for one note's three facets: statistics, outline, backlinks.
 *
 * A consolidation, not a feature — three separate panels showing three views
 * of the same note was more chrome and three things to learn.
 */
export function InfoPanel({
  path,
  tab,
  onTabChange,
  stats,
  created,
  modified,
  headings,
  onGoToLine,
  backlinks,
  tags,
  mentions,
  onOpen,
  onSelectTag,
  onLinkMention,
  onClose,
}: InfoPanelProps) {
  const shallowest = headings.reduce((min, h) => Math.min(min, h.level), 6);

  return (
    <aside className="backlinks info-panel">
      <header className="info-tabs">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`info-tab ${tab === id ? 'is-on' : ''}`}
            onClick={() => onTabChange(id)}
          >
            {label}
          </button>
        ))}
        <button type="button" className="dismiss" onClick={onClose} aria-label="Close info">
          ×
        </button>
      </header>

      {tab === 'stats' && (
        <section>
          <dl className="info-stats">
            <dt>Words</dt>
            <dd>{stats.words.toLocaleString()}</dd>
            <dt>Characters</dt>
            <dd>{stats.characters.toLocaleString()}</dd>
            <dt>Paragraphs</dt>
            <dd>{stats.paragraphs.toLocaleString()}</dd>
            <dt>Reading time</dt>
            <dd>~{stats.readMinutes} min</dd>
            <dt>Created</dt>
            <dd title="From the first commit that added this file">{dateLabel(created)}</dd>
            <dt>Modified</dt>
            <dd>{dateLabel(modified || null)}</dd>
          </dl>
          {!created && (
            <p className="muted-note">
              Created date arrives with the first commit — this note has not been committed yet.
            </p>
          )}
        </section>
      )}

      {tab === 'outline' &&
        (headings.length === 0 ? (
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
        ))}

      {tab === 'backlinks' && (
        <>
          {tags.length > 0 && (
            <section>
              <h3>Tags</h3>
              <div className="tag-row">
                {tags.map((tag) => (
                  <button key={tag} type="button" className="tag" onClick={() => onSelectTag(tag)}>
                    #{tag}
                  </button>
                ))}
              </div>
            </section>
          )}

          <section>
            <h3>
              Linked from <span className="count">{backlinks.length}</span>
            </h3>
            {backlinks.length === 0 ? (
              <p className="muted-note">
                No other note links to {path.slice(path.lastIndexOf('/') + 1)} yet.
              </p>
            ) : (
              <ul className="backlink-list">
                {backlinks.map((link) => (
                  <li key={link.from}>
                    <button type="button" onClick={() => onOpen(link.from)}>
                      <span className="backlink-title">{link.fromTitle}</span>
                      {link.alias && <span className="backlink-alias">“{link.alias}”</span>}
                      <span className="backlink-path">{link.from}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {mentions.length > 0 && (
            <section>
              <h3>
                Mentioned by <span className="count">{mentions.length}</span>
              </h3>
              <ul className="backlink-list">
                {mentions.map((mention) => (
                  <li key={mention.path} className="mention-row">
                    <button type="button" onClick={() => onOpen(mention.path)}>
                      <span className="backlink-title">{mention.title}</span>
                      <span className="backlink-path">{mention.path}</span>
                    </button>
                    <button
                      type="button"
                      className="mention-link"
                      title="Turn the mention into a [[wikilink]]"
                      onClick={() => onLinkMention(mention.path)}
                    >
                      Link it
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
