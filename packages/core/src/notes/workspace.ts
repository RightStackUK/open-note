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
 *
 * **Frontmatter comes first, always.** A `---` block is only frontmatter on
 * the very first line, so a tag written above one does not tag the note — it
 * turns the header into body text and the note's own metadata into prose.
 * Notes created with a header are no longer unusual: a template can carry
 * one, and every imported note does.
 */
export function withWorkspaceTag(body: string, workspace: Workspace): string {
  if (!workspace) return body;
  const tag = `#${workspace}`;

  const header = FRONTMATTER_RE.exec(body);
  const block = header?.[0] ?? '';
  // The blank line after a header belongs to the header, not to the body: put
  // the tag above it and the note opens on a gap.
  const gap = block ? (/^(?:\r?\n)*/.exec(body.slice(block.length))?.[0] ?? '') : '';
  const front = block + gap;
  const rest = body.slice(front.length);
  if (inWorkspace([...tagsWrittenIn(rest), ...tagsDeclaredIn(header?.[1] ?? '')], workspace)) {
    return body;
  }

  const nl = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = rest.split(/\r?\n/);
  const heading = lines[0]?.startsWith('#') && !lines[0]?.startsWith('##') ? 1 : 0;
  if (heading === 0) return `${front}${tag}${nl}${nl}${rest}`;

  // After the heading and the blank line that follows it, if there is one.
  const at = lines[1]?.trim() === '' ? 2 : 1;
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  const spacer = after.length > 0 && after[0]?.trim() !== '' ? [''] : [];
  return `${front}${[...before, tag, ...spacer, ...after].join(nl)}`;
}

/** A frontmatter block, which counts only at the very start of the file. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Tags a frontmatter block declares, in any of the shapes the parser accepts.
 *
 * Read from the `tags:` key rather than by scanning the block, because a
 * `title: work notes` must not be mistaken for the `work` workspace: that
 * false positive leaves the note outside the workspace it was made in, which
 * is the failure this whole function exists to prevent.
 */
function tagsDeclaredIn(block: string): string[] {
  const lines = block.split(/\r?\n/);
  const at = lines.findIndex((line) => /^tags?\s*:/.test(line));
  if (at === -1) return [];

  const inline = (lines[at]?.split(':').slice(1).join(':') ?? '').trim().replace(/^\[|\]$/g, '');
  const listed: string[] = [];
  // A YAML list runs until the first line that is not an item.
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!item?.[1]) break;
    listed.push(item[1]);
  }

  return [...inline.split(/[,\s]+/), ...listed]
    .map((tag) =>
      tag
        .replace(/^#/, '')
        .replace(/^["']|["']$/g, '')
        .trim(),
    )
    .filter(Boolean);
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
