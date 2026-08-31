import { type EditorState, type Extension, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

export interface AttachmentOptions {
  /**
   * Store a file and return the vault-relative path to reference it by.
   * Rejecting is fine; the paste is simply not handled.
   */
  store: (file: File) => Promise<string>;
  /** Resolve a relative image path to something the webview can display. */
  resolveImage: (path: string) => Promise<string | null>;
}

/** Files we will take from a paste or a drop. */
function imageFiles(list: FileList | null | undefined): File[] {
  if (!list) return [];
  return [...list].filter((file) => file.type.startsWith('image/'));
}

/**
 * Accept pasted and dropped images.
 *
 * Only images: taking arbitrary files would quietly copy anything the clipboard
 * happened to hold into the user's repository.
 */
export function attachmentPaste(options: AttachmentOptions): Extension {
  const insert = async (view: EditorView, files: File[]) => {
    for (const file of files) {
      try {
        const path = await options.store(file);
        const alt = file.name.replace(/\.[^.]+$/, '') || 'image';
        const markdown = `![${alt}](${path})`;
        const at = view.state.selection.main;
        view.dispatch({
          changes: { from: at.from, to: at.to, insert: markdown },
          selection: { anchor: at.from + markdown.length },
          userEvent: 'input.paste',
        });
      } catch {
        // Storing failed; leave the document untouched rather than inserting a
        // link to a file that is not there.
      }
    }
  };

  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = imageFiles(event.clipboardData?.files);
      if (files.length === 0) return false;
      event.preventDefault();
      void insert(view, files);
      return true;
    },
    drop(event, view) {
      const files = imageFiles(event.dataTransfer?.files);
      if (files.length === 0) return false;
      event.preventDefault();
      void insert(view, files);
      return true;
    },
  });
}

const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;

/** Remote images are left as text: an editor should not fetch from the network. */
function isLocal(path: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith('//');
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly path: string,
    private readonly alt: string,
    private readonly resolve: AttachmentOptions['resolveImage'],
  ) {
    super();
  }

  override eq(other: ImageWidget) {
    return other.path === this.path && other.alt === this.alt;
  }

  override toDOM() {
    const figure = document.createElement('div');
    figure.className = 'cm-image';

    const image = document.createElement('img');
    image.alt = this.alt;
    figure.appendChild(image);

    void this.resolve(this.path)
      .then((src) => {
        if (!figure.isConnected) return;
        if (src) {
          image.src = src;
          return;
        }
        figure.classList.add('is-missing');
        figure.textContent = `Missing image: ${this.path}`;
      })
      .catch(() => {
        if (!figure.isConnected) return;
        figure.classList.add('is-missing');
        figure.textContent = `Could not load ${this.path}`;
      });

    return figure;
  }

  override ignoreEvent() {
    return true;
  }
}

/**
 * Render local images below the line that references them.
 *
 * Drawn as a widget after the line rather than replacing the markdown, so the
 * link text stays editable — pasting an image you then cannot see is worse than
 * not pasting it, but so is one you cannot get rid of.
 */
export function inlineImages(options: AttachmentOptions): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => decorate(state, options),
    update: (value, transaction) =>
      transaction.docChanged
        ? decorate(transaction.state, options)
        : value.map(transaction.changes),
    provide: (f) => EditorView.decorations.from(f),
  });

  return [field, imageStyles];
}

function decorate(state: EditorState, options: AttachmentOptions): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = state.doc.toString();

  // Widgets must be added in document order or the range set rejects them.
  const found: Array<{ at: number; widget: ImageWidget }> = [];
  IMAGE.lastIndex = 0;
  for (const match of text.matchAll(IMAGE)) {
    if (match.index === undefined) continue;
    const alt = match[1] ?? '';
    const path = match[2] ?? '';
    if (!path || !isLocal(path)) continue;
    found.push({
      at: state.doc.lineAt(match.index).to,
      widget: new ImageWidget(path, alt, options.resolveImage),
    });
  }

  for (const { at, widget } of found.sort((a, b) => a.at - b.at)) {
    builder.add(at, at, Decoration.widget({ widget, block: true, side: 1 }));
  }
  return builder.finish();
}

const imageStyles = EditorView.theme({
  '.cm-image': {
    margin: '0.5rem 0 0.75rem',
    padding: '0 2rem',
    textAlign: 'center',
  },
  '.cm-image img': {
    maxWidth: '100%',
    maxHeight: '24rem',
    borderRadius: '6px',
    border: '1px solid var(--border, #ddd)',
  },
  '.cm-image.is-missing': {
    color: 'var(--danger, #b91c1c)',
    fontFamily: 'var(--mono-font, monospace)',
    fontSize: '0.78rem',
    textAlign: 'left',
  },
});
