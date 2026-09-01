import { type EditorState, type Extension, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { maskCode } from '@open-note/core';

export interface AttachmentOptions {
  /**
   * Store a file and return the vault-relative path to reference it by.
   * Rejecting is fine; the paste is simply not handled.
   */
  store: (file: File) => Promise<string>;
  /** Resolve a relative image path to something the webview can display. */
  resolveImage: (path: string) => Promise<string | null>;
  /** Size and kind of a vault file, for the chip a non-image renders as. */
  fileMeta?: (path: string) => { size: number; kind: string } | null;
  /** Open a vault file in its handler — the OS's, or the app's own preview. */
  openFile?: (path: string) => void;
  /** Render an `.excalidraw` file to sanitised SVG, for inline drawings. */
  renderDrawing?: (path: string) => Promise<string | null>;
  /** Full-width images, or contained thumbnails. */
  display?: () => 'full' | 'thumbnail';
  /** Per-embed collapse; keyed by path, a per-window reading posture. */
  isCollapsed?: (path: string) => boolean;
  toggleCollapsed?: (path: string) => void;
}

/** Files we will take from a paste or a drop. */
function imageFiles(list: FileList | null | undefined): File[] {
  if (!list) return [];
  return [...list].filter((file) => file.type.startsWith('image/'));
}

/** A destination with spaces needs CommonMark's `<…>` form to stay a link. */
function markdownDestination(path: string): string {
  return /[\s()]/.test(path) ? `<${path}>` : path;
}

/** Square brackets in a label would end it early. */
function markdownLabel(text: string): string {
  return text.replace(/([[\]])/g, '\\$1');
}

/** The Markdown a stored attachment is referenced by. */
export function attachmentMarkdown(file: File, path: string): string {
  if (file.type.startsWith('image/')) {
    const alt = markdownLabel(file.name.replace(/\.[^.]+$/, '') || 'image');
    return `![${alt}](${markdownDestination(path)})`;
  }
  // A non-image is a link, which still renders as one on the forge.
  return `[${markdownLabel(file.name)}](${markdownDestination(path)})`;
}

/**
 * Accept pasted images, and dropped files of any kind.
 *
 * Paste stays images-only — the clipboard holding a file is almost always an
 * accident, and quietly copying whatever it held into the repository is the
 * kind of surprise a vault does not want. A drop is deliberate.
 */
export function attachmentPaste(options: AttachmentOptions): Extension {
  const insert = async (view: EditorView, files: File[], dropAt: number | null) => {
    // Storing is slow for a big file, and the caret may have moved on — or to
    // another note entirely. The insertion point is fixed at hand-off time and
    // clamped, never read back from wherever the selection is by then.
    let at = dropAt ?? view.state.selection.main.from;
    for (const file of files) {
      try {
        const path = await options.store(file);
        const markdown = attachmentMarkdown(file, path);
        const from = Math.min(at, view.state.doc.length);
        view.dispatch({
          changes: { from, to: from, insert: markdown },
          selection: { anchor: from + markdown.length },
          userEvent: 'input.paste',
        });
        at = from + markdown.length;
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
      void insert(view, files, null);
      return true;
    },
    drop(event, view) {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return false;
      event.preventDefault();
      // Where the file landed, as every editor does.
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos !== null) view.dispatch({ selection: { anchor: pos } });
      void insert(view, files, pos);
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
    private readonly options: AttachmentOptions,
    private readonly collapsed: boolean,
    private readonly thumbnail: boolean,
  ) {
    super();
  }

  private get resolve() {
    return this.options.resolveImage;
  }

  override eq(other: ImageWidget) {
    return (
      other.path === this.path &&
      other.alt === this.alt &&
      other.collapsed === this.collapsed &&
      other.thumbnail === this.thumbnail
    );
  }

  override toDOM() {
    const figure = document.createElement('div');
    figure.className = `cm-image${this.thumbnail ? ' is-thumbnail' : ''}`;

    if (this.options.toggleCollapsed) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'cm-image-toggle';
      toggle.textContent = this.collapsed ? `▸ ${this.alt || this.path}` : '▾';
      toggle.title = this.collapsed ? 'Show the image' : 'Collapse the image';
      toggle.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.options.toggleCollapsed?.(this.path);
      });
      figure.appendChild(toggle);
    }

    if (this.collapsed) return figure;

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
    // Selection changes rebuild too: the collapse and display callbacks are
    // read at build time, and the app nudges the editor with an empty
    // transaction when they flip.
    update: (value, transaction) =>
      transaction.docChanged || transaction.selection
        ? decorate(transaction.state, options)
        : value.map(transaction.changes),
    provide: (f) => EditorView.decorations.from(f),
  });

  return [field, imageStyles];
}

function decorate(state: EditorState, options: AttachmentOptions): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // Masked, so image syntax inside a code fence stays literal text.
  const text = maskCode(state.doc.toString());

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
      widget: new ImageWidget(
        path,
        alt,
        options,
        options.isCollapsed?.(path) ?? false,
        (options.display?.() ?? 'full') === 'thumbnail',
      ),
    });
  }

  for (const { at, widget } of found.sort((a, b) => a.at - b.at)) {
    builder.add(at, at, Decoration.widget({ widget, block: true, side: 1 }));
  }
  return builder.finish();
}

const imageStyles = EditorView.theme({
  '.cm-image': {
    position: 'relative',
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
  '.cm-image.is-thumbnail img': {
    maxWidth: '14rem',
    maxHeight: '10rem',
  },
  '.cm-image-toggle': {
    position: 'absolute',
    top: '0.15rem',
    right: '2.2rem',
    padding: '0 0.35rem',
    border: '1px solid var(--border, #ddd)',
    borderRadius: '4px',
    background: 'var(--bg, #fff)',
    color: 'var(--muted, #666)',
    font: 'inherit',
    fontSize: '0.68rem',
    cursor: 'pointer',
    opacity: '0.6',
  },
  '.cm-image-toggle:hover': { opacity: '1' },
  '.cm-image.is-missing': {
    color: 'var(--danger, #b91c1c)',
    fontFamily: 'var(--mono-font, monospace)',
    fontSize: '0.78rem',
    textAlign: 'left',
  },
});
