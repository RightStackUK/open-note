import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { htmlToMarkdown, isBareUrl } from '@open-note/core';

/**
 * Paste, properly.
 *
 * Three behaviours, in priority order:
 *
 * 1. A URL pasted onto a selection wraps it as a link — the selection is the
 *    text someone just chose for exactly this.
 * 2. HTML on the clipboard converts to Markdown. Pasting a web page is a daily
 *    action, and raw HTML source in a note is useless to everyone.
 * 3. A bare URL pasted with nothing selected optionally becomes `[Title](url)`
 *    once the page's title arrives — behind a setting that is off by default,
 *    because it is a network request triggered by a keystroke.
 *
 * Everything else falls through to CodeMirror's ordinary paste, including
 * files, which the attachments extension owns.
 */

export interface RichPasteOptions {
  /** Converting pasted HTML to Markdown; the default behaviour. */
  pasteAsMarkdown: () => boolean;
  /** Turning a pasted bare URL into a titled link. Off by default. */
  fetchLinkTitles?: () => boolean;
  /** Resolve a URL to its page title, or null. Injected: the editor has no network. */
  fetchTitle?: (url: string) => Promise<string | null>;
}

export function richPaste(options: RichPasteOptions): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData;
      if (!data) return false;
      // Files are the attachment pipeline's job.
      if (data.files.length > 0) return false;

      const plain = data.getData('text/plain');
      const { from, to } = view.state.selection.main;

      // 1. A URL over a selection makes a link out of it.
      if (from !== to && isBareUrl(plain)) {
        const selected = view.state.doc.sliceString(from, to);
        const insert = `[${selected}](${plain.trim()})`;
        event.preventDefault();
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
          userEvent: 'input.paste',
        });
        return true;
      }

      // 2. HTML becomes Markdown.
      const html = data.getData('text/html');
      if (html && options.pasteAsMarkdown()) {
        // A fragment that is a single inline-ish paste (no block structure)
        // still converts — bold text from a browser should stay bold.
        const markdown = htmlToMarkdown(html);
        if (markdown !== null) {
          event.preventDefault();
          view.dispatch({
            changes: { from, to, insert: markdown },
            selection: { anchor: from + markdown.length },
            userEvent: 'input.paste',
          });
          return true;
        }
      }

      // 3. A bare URL grows a title, later and only if everything cooperates.
      if (from === to && isBareUrl(plain) && options.fetchLinkTitles?.() && options.fetchTitle) {
        const url = plain.trim();
        event.preventDefault();
        view.dispatch({
          changes: { from, to, insert: url },
          selection: { anchor: from + url.length },
          userEvent: 'input.paste',
        });

        void options.fetchTitle(url).then((title) => {
          if (!title) return;
          // The document may have changed while the request ran, so the paste
          // position cannot be trusted. The URL is found again — and only
          // replaced when it occurs exactly once, because with two copies on
          // screen there is no telling which one was this paste.
          const doc = view.state.doc.toString();
          const at = doc.indexOf(url);
          if (at === -1 || doc.indexOf(url, at + 1) !== -1) return;
          const link = `[${title.replace(/[[\]]/g, ' ').trim()}](${url})`;
          view.dispatch({
            changes: { from: at, to: at + url.length, insert: link },
            userEvent: 'input.paste',
          });
        });
        return true;
      }

      return false;
    },
  });
}
