/**
 * Markdown image paths are relative to the note that references them, while the
 * backend speaks in vault-relative paths. These two convert between them.
 */

/** Express `target` (vault-relative) relative to the note at `notePath`. */
export function relativeFrom(notePath: string, target: string): string {
  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
  if (!noteDir) return target;

  const from = noteDir.split('/');
  const to = target.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;

  const up = from.length - shared;
  const down = to.slice(shared);
  return [...Array(up).fill('..'), ...down].join('/');
}

/** Resolve a note-relative `reference` back to a vault-relative path. */
export function resolveAgainst(notePath: string, reference: string): string {
  if (reference.startsWith('/')) return reference.replace(/^\/+/, '');

  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
  const parts = noteDir ? noteDir.split('/') : [];
  for (const segment of reference.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}
