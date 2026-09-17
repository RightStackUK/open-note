import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { beforeAll, describe, expect, it } from 'vitest';

import { markdownEditorExtensions } from './index';

beforeAll(() => {
  Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0 }) as DOMRect;
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
});

function mount(dark: boolean) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc: 'hello',
      extensions: [markdownEditorExtensions({ parent, dark })],
    }),
    parent,
  });
}

/** Every rule that paints `.cm-selectionBackground`, most specific last. */
function selectionRules() {
  const rules: Array<{ specificity: number; selector: string; background: string }> = [];
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules ?? [])) {
      const style = rule as CSSStyleRule;
      for (const selector of (style.selectorText ?? '').split(/,\s*/)) {
        if (!selector.endsWith('.cm-selectionBackground')) continue;
        rules.push({
          // The selectors involved are made only of classes and `>`, so
          // specificity is just how many classes they name.
          specificity: (selector.match(/\./g) ?? []).length,
          selector,
          background: style.style.background || style.style.backgroundColor,
        });
      }
    }
  }
  return rules.sort((a, b) => a.specificity - b.specificity);
}

describe('the editor theme', () => {
  /**
   * CodeMirror's base theme paints the focused selection `#d7d4f0` through a
   * five-class selector. The theme's own rule used to be three classes deep, so
   * it lost the cascade and `--selection` was never used: in a dark theme that
   * left light text on a near-white highlight. A shorter selector here is a
   * silent regression — it looks right in the source and does nothing.
   */
  it('paints the selection from --selection, and out-specifies the base theme', () => {
    mount(false);
    const rules = selectionRules();
    const strongest = rules[rules.length - 1];

    expect(strongest?.background).toBe('var(--selection)');
    // Nothing with the base theme's colours may be as specific as our own.
    const ours = rules.filter((rule) => rule.background === 'var(--selection)');
    for (const rule of rules) {
      if (rule.background === 'var(--selection)') continue;
      expect(ours.some((mine) => mine.specificity >= rule.specificity)).toBe(true);
    }
  });

  it('tells CodeMirror which appearance it is in', () => {
    // The base theme has its own light and dark rules for the parts this
    // package does not paint — the find panel, its buttons and fields, the
    // tooltips — and assumes light unless told.
    expect(mount(true).state.facet(EditorView.darkTheme)).toBe(true);
    expect(mount(false).state.facet(EditorView.darkTheme)).toBe(false);
  });
});
