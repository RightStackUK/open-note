/**
 * A workspace: the whole app scoped to one tag.
 *
 * Keeping work and personal notes apart inside a single vault, without the
 * weight of opening a second one. While a workspace is active, every view,
 * every search and every new note stays inside it.
 *
 * **One predicate, in one place.** That is the entire point of this module.
 * The risk with a scope is not that it is hard to apply but that it is easy to
 * apply in seven places and forget the eighth — and a view that leaks notes
 * from outside a scope it promised to respect is worse than not having the
 * feature, because the promise was the only thing being sold. Every surface
 * calls `inWorkspace`; none of them re-derives what "inside" means.
 *
 * Nested tags are inside their parent: a workspace of `work` contains
 * `#work/clients`, because a tag hierarchy that did not nest here would make
 * `#work/clients` notes invisible in the workspace they obviously belong to.
 */

import { noteHasTag } from './tags';

/** A tag without its `#`, or `null` for the whole vault. */
export type Workspace = string | null;

/**
 * Whether a note belongs to the active workspace.
 *
 * `null` means no workspace, and everything belongs — so every call site can
 * pass the current value unconditionally instead of branching first, which is
 * how a surface ends up forgetting to branch at all.
 */
export function inWorkspace(tags: string[], workspace: Workspace): boolean {
  if (!workspace) return true;
  return noteHasTag(tags, workspace, true);
}

/**
 * Normalise what the user picked.
 *
 * `#work`, `work` and ` work ` are one workspace; empty is no workspace. The
 * stored value is bare and lowercase so that what is written down and what is
 * compared cannot drift apart.
 */
export function normaliseWorkspace(raw: string | null | undefined): Workspace {
  if (typeof raw !== 'string') return null;
  const tag = raw
    .trim()
    .replace(/^#+/, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
  return tag || null;
}

/** How a workspace is written when the app shows it back to you. */
export function workspaceLabel(workspace: Workspace): string {
  return workspace ? `#${workspace}` : '';
}

/**
 * Put the workspace's tag into a new note's body.
 *
 * A note created inside a workspace has to belong to it, or the app would
 * create a note into a view that immediately hides it — which reads as the
 * note not having been created.
 *
 * The tag goes after the heading rather than above it: the first line of a
 * note is its title, and a note that opens on a tag line has been given a
 * worse first line by a feature the writer did not ask about. A body that
 * already carries the tag is left alone.
 */
export function withWorkspaceTag(body: string, workspace: Workspace): string {
  if (!workspace) return body;
  const tag = `#${workspace}`;
  if (inWorkspace(tagsWrittenIn(body), workspace)) return body;

  const nl = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  const heading = lines[0]?.startsWith('#') && !lines[0]?.startsWith('##') ? 1 : 0;
  if (heading === 0) return `${tag}${nl}${nl}${body}`;

  // After the heading and the blank line that follows it, if there is one.
  const at = lines[1]?.trim() === '' ? 2 : 1;
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  const spacer = after.length > 0 && after[0]?.trim() !== '' ? [''] : [];
  return [...before, tag, ...spacer, ...after].join(nl);
}

/**
 * The tags a plain body already carries.
 *
 * Deliberately crude — enough to answer "is the workspace tag already here?"
 * without pulling the note parser into this module. A false negative writes a
 * tag that was already there; a false positive would leave a note outside the
 * workspace it was made in, which is the worse failure.
 */
function tagsWrittenIn(body: string): string[] {
  return [...body.matchAll(/(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu)].map((m) => m[1] ?? '');
}
