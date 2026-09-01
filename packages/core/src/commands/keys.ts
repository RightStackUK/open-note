/**
 * Key binding notation.
 *
 * Bindings are written as modifier-prefixed strings: `Mod-K`, `Mod-Shift-P`,
 * `Alt-ArrowUp`. `Mod` means Command on macOS and Control everywhere else, so a
 * single keymap file works on every platform — which matters because the keymap
 * lives in the repo and syncs between machines.
 */

export type Platform = 'mac' | 'other';

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;

const ALIASES: Record<string, string> = {
  mod: 'Mod',
  cmd: 'Mod',
  command: 'Mod',
  meta: 'Mod',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  space: ' ',
  del: 'Delete',
  ins: 'Insert',
  // `-` and `+` collide with the separator, so bindings spell them out.
  minus: 'Minus',
  plus: 'Plus',
};

function canonicalKey(key: string): string {
  const lower = key.toLowerCase();
  if (ALIASES[lower] && !MODIFIER_ORDER.includes(ALIASES[lower] as never)) {
    return ALIASES[lower];
  }
  // The characters that cannot appear literally in a binding string.
  if (key === '-') return 'Minus';
  if (key === '+') return 'Plus';
  if (key.length === 1) return key.toUpperCase();
  // Arrow keys, F-keys, Home, PageUp and friends keep their canonical casing.
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Rewrite a binding into its canonical form.
 *
 * Modifiers are ordered consistently and aliases folded, so `cmd+shift+p`,
 * `Shift-Cmd-P` and `Mod-Shift-P` all become one comparable string.
 */
export function normaliseBinding(binding: string): string {
  const parts = binding
    .split(/[-+]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';

  const modifiers = new Set<string>();
  let key = '';

  for (const part of parts) {
    const alias = ALIASES[part.toLowerCase()];
    if (alias && MODIFIER_ORDER.includes(alias as never)) {
      modifiers.add(alias);
    } else if (MODIFIER_ORDER.includes(part as never)) {
      modifiers.add(part);
    } else {
      key = canonicalKey(part);
    }
  }

  if (!key) return '';
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.has(m));
  return [...ordered, key].join('-');
}

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Describe a keyboard event in the same notation bindings use. */
export function bindingFromEvent(event: KeyEventLike, platform: Platform): string {
  const modifiers: string[] = [];
  const modPressed = platform === 'mac' ? event.metaKey : event.ctrlKey;
  if (modPressed) modifiers.push('Mod');
  // A Control press on macOS is a real, separate modifier.
  if (platform === 'mac' && event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');

  const key = canonicalKey(event.key);
  if (!key || MODIFIER_ORDER.includes(key as never)) return '';
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.includes(m));
  return [...ordered, key].join('-');
}

/**
 * A binding in the global-shortcut plugin's accelerator notation.
 *
 * `Mod` maps to `CommandOrControl`, which is the same platform fold the in-app
 * dispatcher performs — one keymap file, both dispatchers.
 */
export function bindingToAccelerator(binding: string): string | null {
  const normalised = normaliseBinding(binding);
  if (!normalised) return null;
  const parts = normalised.split('-');
  const key = parts.pop() ?? '';
  // The plugin names these; `+` and a literal space are not valid key tokens.
  const label = key === 'Minus' ? 'Minus' : key === 'Plus' ? 'Plus' : key === ' ' ? 'Space' : key;
  const mods = parts.map((m) => (m === 'Mod' ? 'CommandOrControl' : m));
  return [...mods, label].join('+');
}

/** Render a binding for display: ⌘⇧P on macOS, Ctrl+Shift+P elsewhere. */
export function formatBinding(binding: string, platform: Platform): string {
  const parts = binding.split('-');
  const key = parts.pop() ?? '';
  const symbols = parts.map((mod) => {
    if (platform === 'mac') {
      if (mod === 'Mod') return '⌘';
      if (mod === 'Ctrl') return '⌃';
      if (mod === 'Alt') return '⌥';
      if (mod === 'Shift') return '⇧';
      return mod;
    }
    return mod === 'Mod' ? 'Ctrl' : mod;
  });

  const label = key === ' ' ? 'Space' : key === 'Minus' ? '-' : key === 'Plus' ? '+' : key;
  return platform === 'mac' ? `${symbols.join('')}${label}` : [...symbols, label].join('+');
}
