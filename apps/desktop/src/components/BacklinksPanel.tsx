import type { Backlink } from '@open-note/core';

interface BacklinksPanelProps {
  path: string;
  backlinks: Backlink[];
  tags: string[];
  /** Notes that mention this note's title without linking to it. */
  mentions: Array<{ path: string; title: string }>;
  onOpen: (path: string) => void;
  onSelectTag: (tag: string) => void;
  /** Turn a mention into a real link, in the mentioning note. */
  onLinkMention: (mentioningPath: string) => void;
}

export function BacklinksPanel({
  path,
  backlinks,
  tags,
  mentions,
  onOpen,
  onSelectTag,
  onLinkMention,
}: BacklinksPanelProps) {
  return (
    <aside className="backlinks">
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
    </aside>
  );
}
