/**
 * Keeping `[[wikilinks]]` working when a note is renamed.
 *
 * A rename otherwise silently breaks every link pointing at the note. Obsidian,
 * Logseq, Foam and Zettlr all rewrite links on rename, and users of this class
 * of app expect it. It is only acceptable here because the rename and the
 * rewrites land in one commit, so the whole thing is reviewable in history and
 * revertable in one action.
 */

const MD_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;

function stripExtension(path: string): string {
  return path.replace(MD_EXTENSION, '');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Work out what a link should say after a rename, preserving how it was written.
 *
 * Someone who wrote `[[plan]]` wants `[[roadmap]]`, not
 * `[[archive/2026/roadmap]]`. Someone who wrote the folder path meant it, and
 * should keep it. Rewriting every link into the same canonical shape would
 * churn notes the rename did not need to touch.
 */
export function replacementTarget(writtenTarget: string, newPath: string): string {
  const written = writtenTarget.trim();
  const hadExtension = MD_EXTENSION.test(written);
  const hadFolder = written.includes('/');

  const base = hadFolder ? stripExtension(newPath) : stripExtension(basename(newPath));
  return hadExtension ? `${base}${newPath.slice(newPath.lastIndexOf('.'))}` : base;
}

const LINK = /\[\[([^\]|#\n]+)(#[^\]|\n]+)?(\|[^\]\n]+)?\]\]/g;

export interface LinkRewrite {
  text: string;
  count: number;
}

/**
 * Rewrite every link whose target `matches`, leaving aliases and heading
 * fragments untouched.
 *
 * `matches` is supplied by the caller because deciding whether `[[plan]]` refers
 * to the note being renamed needs the whole vault index — the same resolution
 * rules links use everywhere else, rather than a second, subtly different guess.
 */
export function rewriteLinks(
  source: string,
  matches: (target: string) => boolean,
  newPath: string,
): LinkRewrite {
  let count = 0;

  const text = source.replace(LINK, (whole, rawTarget, heading, alias) => {
    const target = String(rawTarget);
    if (!matches(target.trim())) return whole;
    count += 1;
    return `[[${replacementTarget(target, newPath)}${heading ?? ''}${alias ?? ''}]]`;
  });

  return { text, count };
}
