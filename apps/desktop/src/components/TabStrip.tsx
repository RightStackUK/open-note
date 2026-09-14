import type { FileIconName } from '../fileIcons';
import { FileIcon } from './FileIcon';

export interface TabItem {
  /** Vault-relative path; also the tooltip, since the label is only the name. */
  path: string;
  title: string;
  icon: FileIconName;
  /** Text typed into it that is not on disk yet. */
  dirty: boolean;
}

interface TabStripProps {
  tabs: TabItem[];
  active: number;
  onSelect: (index: number) => void;
  onClose: (index: number) => void;
  /** The `+`: opens the note switcher, which is how you get a note into a tab. */
  onNew: () => void;
}

/**
 * One pane's open notes.
 *
 * It replaces the note's name in the pane header rather than sitting above it:
 * the active tab already says what is open, and two rows saying the same thing
 * is the chrome this feature was most at risk of adding.
 *
 * Middle-click closes, which is the convention everywhere else tabs exist, and
 * is why the row is `<div>`s rather than `<button>`s with an inner close
 * button — a button inside a button is invalid, and the close affordance has to
 * be clickable on its own.
 */
export function TabStrip({ tabs, active, onSelect, onClose, onNew }: TabStripProps) {
  return (
    <div className="tab-strip" role="tablist">
      {tabs.map((tab, index) => (
        <div
          key={tab.path}
          role="tab"
          tabIndex={0}
          aria-selected={index === active}
          className={`tab ${index === active ? 'is-active' : ''} ${tab.dirty ? 'is-dirty' : ''}`}
          title={tab.path}
          onClick={() => onSelect(index)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(index);
            }
          }}
          onAuxClick={(e) => {
            // Button 1 is the middle one; `onAuxClick` is the only event that
            // reports it without also firing for right-click.
            if (e.button !== 1) return;
            e.preventDefault();
            onClose(index);
          }}
        >
          <FileIcon name={tab.icon} />
          <span className="tab-title">{tab.title}</span>
          {/* The dot and the × occupy the same place: an unsaved tab says so
              until you point at it, and then offers the close instead. */}
          <span className="tab-dot" aria-hidden={!tab.dirty} />
          <button
            type="button"
            className="tab-close"
            aria-label={`Close ${tab.title}`}
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(index);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="tab-new" title="Open a note in a new tab" onClick={onNew}>
        ＋
      </button>
    </div>
  );
}
