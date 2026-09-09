import type { FileIconName } from '../fileIcons';

/**
 * The tree's file-type icons.
 *
 * Drawn as strokes on a 16-unit grid and rendered at about fourteen pixels, so
 * every shape is one silhouette and nothing relies on interior detail — a
 * miniature logo turns to mush at this size. `currentColor` throughout, with
 * the colour set in CSS from the theme's own palette, so an icon set never has
 * to be redrawn per theme and cannot smuggle in a hue no theme approved.
 */
const PATHS: Record<FileIconName | 'folder-open', string[]> = {
  // A page with a folded corner, plus ruled lines: a written note.
  markdown: [
    'M9 1.75H5.25A1.25 1.25 0 0 0 4 3v10a1.25 1.25 0 0 0 1.25 1.25h5.5A1.25 1.25 0 0 0 12 13V4.75L9 1.75Z',
    'M9 1.75V4.75H12',
    'M6 8.5h4',
    'M6 10.75h2.5',
  ],
  // The same page, unruled: something we can list but not say much about.
  file: [
    'M9 1.75H5.25A1.25 1.25 0 0 0 4 3v10a1.25 1.25 0 0 0 1.25 1.25h5.5A1.25 1.25 0 0 0 12 13V4.75L9 1.75Z',
    'M9 1.75V4.75H12',
  ],
  // A frame with a sun and a horizon.
  image: [
    'M2.75 3.5h10.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
    'M3 11 6.25 7.9l2.6 2.35 1.9-1.6L14 11.4',
    'M5.75 6.75a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z',
  ],
  // A pen nib over its stroke.
  drawing: ['M11.4 2.2 13.8 4.6 5.9 12.5l-3.4.9.9-3.4z', 'M9.8 3.8l2.4 2.4'],
  // The page again, with the label strip every PDF viewer puts on its icon.
  pdf: [
    'M9 1.75H5.25A1.25 1.25 0 0 0 4 3v10a1.25 1.25 0 0 0 1.25 1.25h5.5A1.25 1.25 0 0 0 12 13V4.75L9 1.75Z',
    'M9 1.75V4.75H12',
    'M5.5 9.25h5v2.75h-5z',
  ],
  code: ['M5.75 4.25 2 8l3.75 3.75', 'M10.25 4.25 14 8l-3.75 3.75'],
  // Braces: the shape of every config file worth the name.
  data: [
    'M6.4 2.25c-1.45 0-1.9.85-1.9 1.9v1.6c0 1-.55 1.5-1.5 1.5v1.5c.95 0 1.5.5 1.5 1.5v1.6c0 1.05.45 1.9 1.9 1.9',
    'M9.6 2.25c1.45 0 1.9.85 1.9 1.9v1.6c0 1 .55 1.5 1.5 1.5v1.5c-.95 0-1.5.5-1.5 1.5v1.6c0 1.05-.45 1.9-1.9 1.9',
  ],
  shell: [
    'M2.5 2.75h11a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1Z',
    'M4.5 6.25 6.5 8.25 4.5 10.25',
    'M8.5 10.5h3.25',
  ],
  // A globe, for the things a browser renders.
  web: [
    'M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5Z',
    'M1.9 8h12.2',
    'M8 1.75c1.6 1.7 2.5 3.85 2.5 6.25S9.6 12.55 8 14.25C6.4 12.55 5.5 10.4 5.5 8S6.4 3.45 8 1.75Z',
  ],
  // A taped box.
  archive: [
    'M1.9 5.25h12.2v6.75a1.25 1.25 0 0 1-1.25 1.25H3.15A1.25 1.25 0 0 1 1.9 12V5.25Z',
    'M1.9 2.75h12.2v2.5H1.9z',
    'M6.5 8.25h3',
  ],
  folder: [
    'M2 12.25V4.5a1.25 1.25 0 0 1 1.25-1.25h2.6L7.4 5h5.35A1.25 1.25 0 0 1 14 6.25v6a1.25 1.25 0 0 1-1.25 1.25H3.25A1.25 1.25 0 0 1 2 12.25Z',
  ],
  // The same folder tipped open, so the caret is not the only signal.
  'folder-open': [
    'M2 12.5V4.5a1.25 1.25 0 0 1 1.25-1.25h2.6L7.4 5h5.35A1.25 1.25 0 0 1 14 6.25v1.25',
    'M2 12.5l1.75-4.35A1.25 1.25 0 0 1 4.9 7.4h9.15a.85.85 0 0 1 .8 1.15l-1.55 4.05a1.25 1.25 0 0 1-1.17.8H3.25A1.25 1.25 0 0 1 2 12.5Z',
  ],
};

interface FileIconProps {
  name: FileIconName | 'folder-open';
}

export function FileIcon({ name }: FileIconProps) {
  return (
    <svg
      className={`file-icon is-${name}`}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative: the row's own text already names the file, and a screen
      // reader announcing "code icon" before every filename is noise.
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
