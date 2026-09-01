/**
 * Typography settings: how the prose looks.
 *
 * All of it is applied as CSS custom properties on the editor root, so a
 * change never rebuilds the editor — the variables land and the text reflows.
 * Stored under the `typography` key in `.opennote/settings.json` and parsed
 * with the same field-by-field degradation as everything else in that file.
 */

export interface TypographySettings {
  /** Body font. Empty means the built-in default stack. */
  textFont: string;
  /** Headings font. Empty means the UI font, as today. */
  headingFont: string;
  /** Code font. Empty means the built-in monospace stack. */
  codeFont: string;
  /** Base size in px. The zoom multiplier applies on top of this. */
  fontSize: number;
  /** Unitless line height. */
  lineHeight: number;
  /** Measure in rem — how wide a line of prose may run. */
  lineWidth: number;
  /** Extra space below each line block, in px. */
  paragraphSpacing: number;
  /** First-line indent, in em. */
  paragraphIndent: number;
}

/** Matches what the stylesheet has always shipped, so absent settings change nothing. */
export const DEFAULT_TYPOGRAPHY: TypographySettings = {
  textFont: '',
  headingFont: '',
  codeFont: '',
  fontSize: 17,
  lineHeight: 1.7,
  lineWidth: 46,
  paragraphSpacing: 0,
  paragraphIndent: 0,
};

/** Guard against a hand-edited file making the editor unreadable. */
const TYPOGRAPHY_LIMITS: Record<string, [min: number, max: number]> = {
  fontSize: [9, 48],
  lineHeight: [1, 3],
  lineWidth: [20, 120],
  paragraphSpacing: [0, 48],
  paragraphIndent: [0, 4],
};

function clamp(key: keyof typeof TYPOGRAPHY_LIMITS, value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const [min, max] = TYPOGRAPHY_LIMITS[key] as [number, number];
  return Math.min(Math.max(value, min), max);
}

function font(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Parse the `typography` value of a settings file, field by field. */
export function parseTypography(raw: unknown): TypographySettings {
  const d = DEFAULT_TYPOGRAPHY;
  if (typeof raw !== 'object' || raw === null) return { ...d };
  const record = raw as Record<string, unknown>;
  return {
    textFont: font(record.textFont),
    headingFont: font(record.headingFont),
    codeFont: font(record.codeFont),
    fontSize: clamp('fontSize', record.fontSize, d.fontSize),
    lineHeight: clamp('lineHeight', record.lineHeight, d.lineHeight),
    lineWidth: clamp('lineWidth', record.lineWidth, d.lineWidth),
    paragraphSpacing: clamp('paragraphSpacing', record.paragraphSpacing, d.paragraphSpacing),
    paragraphIndent: clamp('paragraphIndent', record.paragraphIndent, d.paragraphIndent),
  };
}

/** Zoom is clamped so a runaway shortcut cannot make text invisible or absurd. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.5;
export const ZOOM_STEP = 0.1;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(Math.max(Math.round(zoom * 10) / 10, MIN_ZOOM), MAX_ZOOM);
}

/**
 * The CSS custom properties a typography choice turns into.
 *
 * Zoom multiplies the configured font size rather than being a separate
 * mechanism, so the two can never disagree. Font entries are omitted when
 * empty so the stylesheet's fallback stacks stay in charge of the defaults.
 */
export function typographyCssVariables(
  settings: TypographySettings,
  zoom = 1,
): Record<string, string> {
  const vars: Record<string, string> = {
    '--note-font-size': `${Math.round(settings.fontSize * clampZoom(zoom) * 10) / 10}px`,
    '--note-line-height': String(settings.lineHeight),
    '--note-line-width': `${settings.lineWidth}rem`,
    '--note-paragraph-spacing': `${settings.paragraphSpacing}px`,
    '--note-paragraph-indent': `${settings.paragraphIndent}em`,
  };
  if (settings.textFont) vars['--note-font'] = quoteFont(settings.textFont);
  if (settings.headingFont) vars['--heading-font'] = quoteFont(settings.headingFont);
  if (settings.codeFont) vars['--mono-font'] = quoteFont(settings.codeFont);
  return vars;
}

/** A family name with spaces needs quoting; a stack is passed through as-is. */
function quoteFont(name: string): string {
  if (name.includes(',') || name.includes('"') || name.includes("'")) return name;
  return name.includes(' ') ? `"${name}"` : name;
}
