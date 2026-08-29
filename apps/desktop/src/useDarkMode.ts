import { useEffect, useState } from 'react';

/**
 * Track the OS colour scheme.
 *
 * Diagrams are rendered as SVG with baked-in colours, so they must be redrawn
 * when the theme flips — a dark-themed diagram on a light page is unreadable.
 */
export function useDarkMode(): boolean {
  const [dark, setDark] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return dark;
}
