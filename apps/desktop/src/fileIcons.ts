import type { FileKind } from './api';

/**
 * Which icon a row in the tree gets.
 *
 * `FileKind` comes from Rust and answers a different question — what the app
 * can *do* with a file — so it stops at `text` and `other`, and a `.ts`, a
 * `.json` and a `.sh` all land in the same bucket. That is the right answer for
 * "can this be opened in the editor" and the wrong one for "what am I looking
 * at", so the icon is chosen by extension where the kind is too coarse.
 *
 * The set is deliberately families rather than one icon per extension: a
 * hundred logos is a maintenance burden and, at fourteen pixels, indis-
 * tinguishable anyway. What reads at that size is a silhouette and a colour.
 */
export type FileIconName =
  | 'markdown'
  | 'image'
  | 'drawing'
  | 'pdf'
  | 'code'
  | 'data'
  | 'shell'
  | 'web'
  | 'archive'
  | 'file'
  | 'folder';

/** Extension (without the dot) to icon, for what `FileKind` lumps together. */
const BY_EXTENSION: Record<string, FileIconName> = {};

const family = (name: FileIconName, extensions: string[]) => {
  for (const extension of extensions) BY_EXTENSION[extension] = name;
};

family('code', [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'rs',
  'py',
  'go',
  'java',
  'kt',
  'kts',
  'rb',
  'php',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'swift',
  'm',
  'mm',
  'lua',
  'sql',
  'vue',
  'svelte',
  'dart',
  'scala',
  'ex',
  'exs',
  'erl',
  'hs',
  'pl',
  'r',
  'zig',
  'nim',
]);

family('data', [
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'xml',
  'plist',
  'csv',
  'tsv',
  'lock',
  'graphql',
  'gql',
  'proto',
]);

family('shell', ['sh', 'bash', 'zsh', 'fish', 'command', 'bat', 'cmd', 'ps1', 'nu', 'fish']);

family('web', ['html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl']);

family('archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar']);

/**
 * Files whose *name* is the type, extension or not.
 *
 * A repository is full of them, and `Dockerfile` reading as a nameless generic
 * while `docker-compose.yml` gets an icon is exactly the gap the issue is
 * about. Matched case-insensitively on the whole basename.
 */
const BY_NAME: Record<string, FileIconName> = {
  dockerfile: 'code',
  makefile: 'code',
  justfile: 'code',
  rakefile: 'code',
  gemfile: 'code',
  procfile: 'code',
  '.gitignore': 'data',
  '.gitattributes': 'data',
  '.gitmodules': 'data',
  '.editorconfig': 'data',
  '.npmrc': 'data',
  '.nvmrc': 'data',
  '.env': 'data',
  '.dockerignore': 'data',
  license: 'file',
  'license.md': 'markdown',
};

/** The basename of a vault-relative path. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The lowercase extension of a name, or `''` when it has none. */
function extensionOf(name: string): string {
  // A leading dot is the whole name — `.gitignore` has no extension — and a
  // dot at the end has nothing after it to be one.
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * The icon for one row.
 *
 * `FileKind` wins where it is specific, because Rust classified from the same
 * extension lists the reader and the previewer use — disagreeing with it here
 * would mean a file that shows a picture frame and refuses to preview.
 */
export function fileIconName(path: string, kind: FileKind): FileIconName {
  if (kind === 'folder') return 'folder';
  if (kind === 'markdown') return 'markdown';
  if (kind === 'image') return 'image';
  if (kind === 'drawing') return 'drawing';
  if (kind === 'pdf') return 'pdf';

  const name = basename(path);
  const named = BY_NAME[name.toLowerCase()];
  if (named) return named;

  return BY_EXTENSION[extensionOf(name)] ?? 'file';
}
