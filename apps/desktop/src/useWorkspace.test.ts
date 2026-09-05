import { describe, expect, it } from 'vitest';
import { nextActiveRoot } from './useWorkspace';

/**
 * Closing one vault of several has to leave a *different* vault showing.
 *
 * The list this is given still contains the vault being closed: it is read
 * from a ref mirroring rendered state, and the removal has not been applied
 * yet. Skipping that entry is the whole job, and getting it wrong points the
 * app at a session that has just been deleted — which renders as an empty
 * window rather than as an error.
 */
describe('nextActiveRoot', () => {
  it('moves to another open vault when the active one closes', () => {
    expect(nextActiveRoot(['/a', '/b'], '/a', '/a')).toBe('/b');
  });

  it('does not pick the vault being closed, even when it is listed first', () => {
    // The regression this exists for: `Object.keys(...)[0]` is `/a`.
    expect(nextActiveRoot(['/a', '/b', '/c'], '/a', '/a')).toBe('/b');
  });

  it('leaves the active vault alone when a different one closes', () => {
    expect(nextActiveRoot(['/a', '/b'], '/b', '/a')).toBe('/a');
  });

  it('returns to no vault when the last one closes', () => {
    expect(nextActiveRoot(['/a'], '/a', '/a')).toBeNull();
  });

  it('stays at no vault when there was none', () => {
    expect(nextActiveRoot(['/a'], '/a', null)).toBeNull();
  });
});
