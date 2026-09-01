import { describe, expect, it } from 'vitest';

import { parseVaultSettings } from './settings';
import {
  clampZoom,
  DEFAULT_TYPOGRAPHY,
  parseTypography,
  typographyCssVariables,
} from './typography';

describe('parseTypography', () => {
  it('returns defaults for a missing value', () => {
    expect(parseTypography(undefined)).toEqual(DEFAULT_TYPOGRAPHY);
    expect(parseTypography(null)).toEqual(DEFAULT_TYPOGRAPHY);
    expect(parseTypography('nonsense')).toEqual(DEFAULT_TYPOGRAPHY);
  });

  it('reads values that are present', () => {
    const parsed = parseTypography({ textFont: 'Georgia', fontSize: 19 });
    expect(parsed.textFont).toBe('Georgia');
    expect(parsed.fontSize).toBe(19);
    // The rest fall back field by field.
    expect(parsed.lineHeight).toBe(DEFAULT_TYPOGRAPHY.lineHeight);
  });

  it('clamps a hand-edited size that would make text unreadable', () => {
    expect(parseTypography({ fontSize: 2 }).fontSize).toBe(9);
    expect(parseTypography({ fontSize: 500 }).fontSize).toBe(48);
    expect(parseTypography({ lineHeight: 99 }).lineHeight).toBe(3);
  });

  it('drops a non-string font rather than crashing', () => {
    expect(parseTypography({ textFont: 42 }).textFont).toBe('');
  });

  it('parses through the settings file', () => {
    const parsed = parseVaultSettings('{"typography":{"fontSize":20}}');
    expect(parsed.typography.fontSize).toBe(20);
  });
});

describe('typographyCssVariables', () => {
  it('produces the size, measure and rhythm variables', () => {
    const vars = typographyCssVariables(DEFAULT_TYPOGRAPHY);
    expect(vars['--note-font-size']).toBe('17px');
    expect(vars['--note-line-height']).toBe('1.7');
    expect(vars['--note-line-width']).toBe('46rem');
  });

  it('multiplies the font size by the zoom', () => {
    expect(typographyCssVariables(DEFAULT_TYPOGRAPHY, 1.5)['--note-font-size']).toBe('25.5px');
  });

  it('omits font variables when unset, so the stylesheet defaults hold', () => {
    const vars = typographyCssVariables(DEFAULT_TYPOGRAPHY);
    expect(vars['--note-font']).toBeUndefined();
    expect(vars['--heading-font']).toBeUndefined();
    expect(vars['--mono-font']).toBeUndefined();
  });

  it('quotes a family name containing spaces', () => {
    const vars = typographyCssVariables({ ...DEFAULT_TYPOGRAPHY, textFont: 'Iowan Old Style' });
    expect(vars['--note-font']).toBe('"Iowan Old Style"');
  });

  it('passes a stack through untouched', () => {
    const vars = typographyCssVariables({ ...DEFAULT_TYPOGRAPHY, textFont: 'Georgia, serif' });
    expect(vars['--note-font']).toBe('Georgia, serif');
  });
});

describe('clampZoom', () => {
  it('clamps to the working range', () => {
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(9)).toBe(2.5);
  });

  it('rounds to one decimal so repeated steps stay exact', () => {
    expect(clampZoom(1.0000001 + 0.1)).toBe(1.1);
  });

  it('recovers from a corrupted stored value', () => {
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});
