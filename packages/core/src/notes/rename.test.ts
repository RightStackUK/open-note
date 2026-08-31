import { describe, expect, it } from 'vitest';

import { replacementTarget, rewriteLinks } from './rename';

/** Matches the way a vault index would resolve links to the renamed note. */
const pointsAtPlan = (target: string) =>
  ['plan', 'Plan', 'notes/plan', 'notes/plan.md'].includes(target);

describe('replacementTarget', () => {
  it('keeps a bare name bare', () => {
    // `[[plan]]` should become `[[roadmap]]`, not the full path.
    expect(replacementTarget('plan', 'notes/roadmap.md')).toBe('roadmap');
  });

  it('keeps a folder path when the link had one', () => {
    expect(replacementTarget('notes/plan', 'archive/roadmap.md')).toBe('archive/roadmap');
  });

  it('keeps an explicit extension', () => {
    expect(replacementTarget('notes/plan.md', 'archive/roadmap.md')).toBe('archive/roadmap.md');
  });

  it('drops the extension when the link had none', () => {
    expect(replacementTarget('plan', 'roadmap.md')).toBe('roadmap');
  });
});

describe('rewriteLinks', () => {
  it('rewrites a plain link', () => {
    const out = rewriteLinks('see [[plan]] here', pointsAtPlan, 'roadmap.md');
    expect(out.text).toBe('see [[roadmap]] here');
    expect(out.count).toBe(1);
  });

  it('preserves an alias', () => {
    expect(rewriteLinks('[[plan|the plan]]', pointsAtPlan, 'roadmap.md').text).toBe(
      '[[roadmap|the plan]]',
    );
  });

  it('preserves a heading fragment', () => {
    expect(rewriteLinks('[[plan#Scope]]', pointsAtPlan, 'roadmap.md').text).toBe(
      '[[roadmap#Scope]]',
    );
  });

  it('preserves a heading and an alias together', () => {
    expect(rewriteLinks('[[plan#Scope|scope]]', pointsAtPlan, 'roadmap.md').text).toBe(
      '[[roadmap#Scope|scope]]',
    );
  });

  it('rewrites several links and counts them', () => {
    const out = rewriteLinks('[[plan]] and [[notes/plan]]', pointsAtPlan, 'notes/roadmap.md');
    expect(out.text).toBe('[[roadmap]] and [[notes/roadmap]]');
    expect(out.count).toBe(2);
  });

  it('drops the folder from a path link when the note moves to the root', () => {
    // `[[notes/plan]]` cannot stay folder-qualified once the note is no longer
    // in a folder; keeping the shape would produce a link to nowhere.
    const out = rewriteLinks('[[notes/plan]]', pointsAtPlan, 'roadmap.md');
    expect(out.text).toBe('[[roadmap]]');
  });

  it('leaves links to other notes alone', () => {
    const out = rewriteLinks('[[plan]] and [[other]]', pointsAtPlan, 'roadmap.md');
    expect(out.text).toBe('[[roadmap]] and [[other]]');
    expect(out.count).toBe(1);
  });

  it('reports nothing changed when no link matches', () => {
    const out = rewriteLinks('[[other]] only', pointsAtPlan, 'roadmap.md');
    expect(out.text).toBe('[[other]] only');
    expect(out.count).toBe(0);
  });

  it('leaves prose that merely mentions the name untouched', () => {
    // Only real links are rewritten, never the word in a sentence.
    const out = rewriteLinks('the plan is ready', pointsAtPlan, 'roadmap.md');
    expect(out.count).toBe(0);
  });

  it('tolerates surrounding whitespace in the target', () => {
    expect(rewriteLinks('[[ plan ]]', pointsAtPlan, 'roadmap.md').count).toBe(1);
  });

  it('does not touch a document with no links', () => {
    const source = '# Heading\n\nJust prose.';
    expect(rewriteLinks(source, pointsAtPlan, 'roadmap.md')).toEqual({ text: source, count: 0 });
  });
});
