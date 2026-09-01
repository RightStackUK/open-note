/**
 * Tag rewriting: rename and delete, vault-wide operations built note by note.
 *
 * Renaming a parent renames its children with it — `#work` → `#job` carries
 * `#work/urgent` to `#job/urgent`. Code stays untouched, by the same masking
 * rule the indexer reads tags with, and frontmatter `tags:` entries are
 * rewritten too, since `extractTags` counts them.
 */

import { splitFrontmatter } from './parse';

const TAG_TOKEN = /(^|[\s(\[{])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;

/** Regions we must not rewrite: code must stay literal. Mirrors `maskCode`. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const re of [/```[\s\S]*?(?:```|$)/g, /~~~[\s\S]*?(?:~~~|$)/g, /`[^`\n]*`/g]) {
    for (const match of text.matchAll(re)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

function inRanges(ranges: Array<[number, number]>, pos: number): boolean {
  return ranges.some(([from, to]) => pos >= from && pos < to);
}

/** Whether `tag` is `target` or one of its children, case-insensitively. */
function matchesTag(tag: string, target: string): boolean {
  const lower = tag.toLowerCase();
  const wanted = target.toLowerCase();
  return lower === wanted || lower.startsWith(`${wanted}/`);
}

/** `#work/urgent` renamed under `work` → `job` keeps its `/urgent` tail. */
function renamed(tag: string, from: string, to: string): string {
  return `${to}${tag.slice(from.length)}`;
}

export interface TagRewrite {
  text: string;
  /** Occurrences changed, body and frontmatter together. */
  count: number;
}

/**
 * Rewrite frontmatter `tags:` entries, tolerating the common YAML shapes:
 * `tags: [a, b]`, `tags: a`, and the block form's `- a` lines.
 *
 * Processed line by line with a "currently inside the tags block" state, so a
 * dash item under some *other* key — `aliases:`, say — is never touched. A
 * structural guarantee needs a YAML parser; tracking the owning key gets the
 * same answer for every file that round-trips through `splitFrontmatter`.
 */
function rewriteFrontmatterTags(
  source: string,
  transform: (tag: string) => string | null,
): TagRewrite {
  const { bodyOffset } = splitFrontmatter(source);
  if (bodyOffset === 0) return { text: source, count: 0 };

  const head = source.slice(0, bodyOffset);
  let count = 0;
  let inTagsBlock = false;

  const lines = head.split('\n').map((line) => {
    const key = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (key) {
      inTagsBlock = key[1]?.toLowerCase() === 'tags';
      if (!inTagsBlock || key[1]?.toLowerCase() !== 'tags') return line;
      // Inline form: rewrite tag tokens in the value, drop removed ones along
      // with a trailing comma so the list stays a list.
      const value = (key[2] ?? '')
        .replace(/[\p{L}\p{N}][\p{L}\p{N}_/-]*/gu, (token) => {
          const next = transform(token);
          if (next === null) return token;
          count += 1;
          return next;
        })
        .replace(/(?<=\[|,)\s*,/g, '')
        .replace(/,\s*(?=,|\])/g, '')
        .replace(/\[\s*,/, '[');
      return `tags:${line.slice(line.indexOf(':') + 1, line.indexOf(':') + 1).length ? '' : ''} ${value}`.replace(
        /^tags: $/,
        'tags:',
      );
    }

    const dash = /^(\s*-\s+)(.+)$/.exec(line);
    if (dash && inTagsBlock) {
      const raw = (dash[2] ?? '').trim();
      const bare = raw.replace(/^["']|["']$/g, '');
      const next = transform(bare);
      if (next === null) return line;
      count += 1;
      if (next === '') return null; // the whole item goes
      return `${dash[1] ?? ''}${raw.startsWith('"') ? `"${next}"` : next}`;
    }

    // A non-key, non-dash line (or a dash under another key) passes through;
    // only an actual `key:` line changes the block state above.
    return line;
  });

  const rewritten = lines.filter((line): line is string => line !== null).join('\n');
  return { text: rewritten + source.slice(bodyOffset), count };
}

function rewriteBody(source: string, transform: (tag: string) => string | null): TagRewrite {
  const masked = codeRanges(source);
  let out = '';
  let last = 0;
  let count = 0;

  for (const match of source.matchAll(TAG_TOKEN)) {
    const lead = match[1] ?? '';
    const tag = match[2] ?? '';
    const hashAt = match.index + lead.length;
    if (inRanges(masked, hashAt)) continue;
    const next = transform(tag);
    if (next === null) continue;

    out += source.slice(last, hashAt);
    out += next === '' ? '' : `#${next}`;
    last = hashAt + 1 + tag.length;
    // Removal eats one adjacent space — the following one mid-sentence, the
    // preceding one at a line end — so "keep #gone this" reads "keep this".
    // The cleanup happens at the site, never file-wide, because file-wide
    // whitespace collapsing rewrites code blocks and indentation.
    if (next === '') {
      if (source[last] === ' ' && /[\s(]$/.test(out)) last += 1;
      else if (out.endsWith(' ') && (source[last] === '\n' || last >= source.length)) {
        out = out.slice(0, -1);
      }
    }
    count += 1;
  }
  out += source.slice(last);

  return { text: count > 0 ? out : source, count };
}

/** Rename `from` (and its children) to `to` throughout one note. */
export function renameTagInNote(source: string, from: string, to: string): TagRewrite {
  const transform = (tag: string) => (matchesTag(tag, from) ? renamed(tag, from, to) : null);
  const body = rewriteBody(source, transform);
  const withFrontmatter = rewriteFrontmatterTags(body.text, transform);
  return { text: withFrontmatter.text, count: body.count + withFrontmatter.count };
}

/**
 * Remove `tag` (and its children) from one note. Occurrences come out of the
 * prose; the note itself is never deleted — the plan is explicit about that.
 */
export function removeTagFromNote(source: string, tag: string): TagRewrite {
  const transform = (candidate: string) => (matchesTag(candidate, tag) ? '' : null);
  const body = rewriteBody(source, transform);
  const withFrontmatter = rewriteFrontmatterTags(body.text, transform);
  return { text: withFrontmatter.text, count: body.count + withFrontmatter.count };
}

/** The set of tags in `tags` that `target` covers — for the count shown first. */
export function tagFamily(tags: string[], target: string): string[] {
  return tags.filter((tag) => matchesTag(tag, target));
}
