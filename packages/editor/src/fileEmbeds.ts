import { type EditorState, type Extension, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { maskCode } from '@open-note/core';

import type { AttachmentOptions } from './attachments';

/**
 * Non-image attachments and inline drawings.
 *
 * A `[name](file.pdf)` link to a local file renders a chip below its line —
 * filename, size, an icon — and opens in the OS handler (or the app's own
 * preview) on click. A `![[sketch.excalidraw]]` embed renders the drawing
 * itself, which is the half of ROADMAP Phase 4 that matters: a drawing you
 * have to leave the note to see is barely part of the note.
 */

const LINK = /(?<!!)\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^)\s]+))\)/g;
const EMBED = /!\[\[([^\]|#\n]+)\]\]/g;

/** A crafted `%ZZ` must not take the whole editor down with it. */
function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function isLocal(path: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith('//');
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|heic|tiff?)$/i;
const NOTE_EXT = /\.(md|markdown|mdown|mkd)$/i;

function iconFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'pdf') return '⬒';
  if (ext === 'excalidraw') return '◇';
  if (['zip', 'gz', 'tar', '7z', 'rar'].includes(ext)) return '⧉';
  if (['mp3', 'wav', 'flac', 'm4a', 'ogg'].includes(ext)) return '♪';
  if (['mp4', 'mov', 'mkv', 'webm'].includes(ext)) return '▶';
  return '⎘';
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

class FileChipWidget extends WidgetType {
  constructor(
    private readonly path: string,
    private readonly label: string,
    private readonly options: AttachmentOptions,
    /** Captured at decoration time, so a files refresh re-renders the chip. */
    private readonly meta: { size: number; kind: string } | null,
  ) {
    super();
  }

  override eq(other: FileChipWidget) {
    return (
      other.path === this.path &&
      other.label === this.label &&
      other.meta?.size === this.meta?.size &&
      other.meta?.kind === this.meta?.kind
    );
  }

  toDOM() {
    const meta = this.meta;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `cm-file-chip${meta ? '' : ' is-missing'}`;
    chip.title = meta ? `Open ${this.path}` : `${this.path} is not in the vault`;

    const icon = document.createElement('span');
    icon.className = 'cm-file-chip-icon';
    icon.textContent = iconFor(this.path);
    chip.appendChild(icon);

    const name = document.createElement('span');
    name.textContent = this.label || this.path.slice(this.path.lastIndexOf('/') + 1);
    chip.appendChild(name);

    if (meta) {
      const size = document.createElement('span');
      size.className = 'cm-file-chip-size';
      size.textContent = sizeLabel(meta.size);
      chip.appendChild(size);
    }

    chip.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (meta) this.options.openFile?.(this.path);
    });

    return chip;
  }

  override ignoreEvent() {
    return true;
  }
}

class DrawingWidget extends WidgetType {
  constructor(
    private readonly path: string,
    private readonly options: AttachmentOptions,
    /** The file's size at decoration time; an external edit re-renders. */
    private readonly stamp: number,
  ) {
    super();
  }

  override eq(other: DrawingWidget) {
    return other.path === this.path && other.stamp === this.stamp;
  }

  toDOM() {
    const figure = document.createElement('div');
    figure.className = 'cm-drawing-embed';
    figure.textContent = 'Rendering drawing…';
    figure.title = `Open ${this.path} in the canvas`;

    void this.options
      .renderDrawing?.(this.path)
      .then((svg) => {
        if (!figure.isConnected) return;
        if (svg) {
          // Sanitised by the caller, same bargain the diagram blocks make.
          figure.innerHTML = svg;
        } else {
          figure.classList.add('is-missing');
          figure.textContent = `Missing drawing: ${this.path}`;
        }
      })
      .catch(() => {
        if (!figure.isConnected) return;
        figure.classList.add('is-missing');
        figure.textContent = `Could not render ${this.path}`;
      });

    figure.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.options.openFile?.(this.path);
    });

    return figure;
  }

  override ignoreEvent() {
    return true;
  }
}

function decorate(state: EditorState, options: AttachmentOptions): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // Masked, so a link written inside a code fence stays literal text.
  const text = maskCode(state.doc.toString());

  const found: Array<{ at: number; widget: WidgetType }> = [];

  for (const match of text.matchAll(LINK)) {
    const label = match[1] ?? '';
    const target = match[2] ?? match[3] ?? '';
    // Only local non-note, non-image files: notes are wikilinks' business and
    // images already render as images.
    if (!target || !isLocal(target) || NOTE_EXT.test(target) || IMAGE_EXT.test(target)) continue;
    const path = safeDecode(target);
    const meta = options.fileMeta?.(path) ?? null;
    if (/\.excalidraw$/i.test(target)) {
      found.push({
        at: state.doc.lineAt(match.index).to,
        widget: new DrawingWidget(path, options, meta?.size ?? 0),
      });
      continue;
    }
    found.push({
      at: state.doc.lineAt(match.index).to,
      widget: new FileChipWidget(path, label, options, meta),
    });
  }

  for (const match of text.matchAll(EMBED)) {
    const target = (match[1] ?? '').trim();
    if (!/\.excalidraw$/i.test(target)) continue;
    found.push({
      at: state.doc.lineAt(match.index).to,
      widget: new DrawingWidget(target, options, options.fileMeta?.(target)?.size ?? 0),
    });
  }

  for (const { at, widget } of found.sort((a, b) => a.at - b.at)) {
    builder.add(at, at, Decoration.widget({ widget, block: true, side: 1 }));
  }
  return builder.finish();
}

const styles = EditorView.theme({
  '.cm-file-chip': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    margin: '0.25rem 2rem 0.5rem',
    padding: '0.3rem 0.6rem',
    border: '1px solid var(--border, #ddd)',
    borderRadius: '7px',
    background: 'var(--bg-raised, transparent)',
    color: 'var(--fg, inherit)',
    font: 'inherit',
    fontSize: '0.82rem',
    cursor: 'pointer',
  },
  '.cm-file-chip:hover': { borderColor: 'var(--accent, #c2410c)' },
  '.cm-file-chip.is-missing': {
    color: 'var(--muted, #888)',
    cursor: 'default',
    borderStyle: 'dashed',
  },
  '.cm-file-chip-icon': { color: 'var(--muted, #888)' },
  '.cm-file-chip-size': { color: 'var(--muted, #888)', fontSize: '0.72rem' },
  '.cm-drawing-embed': {
    margin: '0.5rem 2rem 0.75rem',
    padding: '0.5rem',
    border: '1px solid var(--border, #ddd)',
    borderRadius: '8px',
    textAlign: 'center',
    cursor: 'pointer',
  },
  '.cm-drawing-embed svg': { maxWidth: '100%', height: 'auto' },
  '.cm-drawing-embed.is-missing': {
    color: 'var(--danger, #b91c1c)',
    fontFamily: 'var(--mono-font, monospace)',
    fontSize: '0.78rem',
    textAlign: 'left',
    cursor: 'default',
  },
});

/** Chips for non-image attachments, and inline `.excalidraw` drawings. */
export function fileEmbeds(options: AttachmentOptions): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => decorate(state, options),
    update: (value, transaction) =>
      transaction.docChanged
        ? decorate(transaction.state, options)
        : value.map(transaction.changes),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [field, styles];
}
