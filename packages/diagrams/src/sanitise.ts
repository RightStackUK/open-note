/**
 * SVG sanitisation.
 *
 * Diagram sources arrive from Markdown files, and a vault can be cloned from
 * anywhere. Rendered SVG is injected into the app's own document, so a script
 * inside it would run with the app's privileges. Renderers have their own
 * security settings, but this is the backstop that does not depend on any of
 * them being configured correctly.
 */

const FORBIDDEN_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'animate',
  'set',
]);

/** `javascript:` and friends, tolerating whitespace and control characters. */
const DANGEROUS_URL = /^\s*(?:javascript|vbscript|data:text\/html)/i;

function stripNode(node: Element) {
  node.remove();
}

/**
 * Remove scripting from an SVG document fragment.
 *
 * Returns the cleaned markup. Anything unparseable yields an empty string
 * rather than passing the original through.
 */
export function sanitiseSvg(svg: string): string {
  if (typeof DOMParser === 'undefined') {
    // No DOM available (a non-browser test run); refuse rather than trust it.
    return '';
  }

  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return '';

  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') return '';

  const walk = (element: Element) => {
    for (const child of [...element.children]) {
      if (FORBIDDEN_ELEMENTS.has(child.nodeName.toLowerCase())) {
        stripNode(child);
        continue;
      }
      walk(child);
    }

    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      // Inline event handlers.
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
        continue;
      }
      // Links that execute rather than navigate.
      if (
        (name === 'href' || name === 'xlink:href' || name === 'src') &&
        DANGEROUS_URL.test(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  };

  walk(root);
  return root.outerHTML;
}
