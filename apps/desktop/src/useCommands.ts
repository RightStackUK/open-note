import { bindingFromEvent, type ResolvedKeymap } from '@open-note/core';
import { useEffect, useRef } from 'react';

export const PLATFORM: 'mac' | 'other' =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)
    ? 'mac'
    : 'other';

export type CommandHandlers = Record<string, () => void>;

/**
 * Route keyboard shortcuts to command handlers.
 *
 * Listens on the capture phase so a shortcut works while the editor has focus;
 * CodeMirror would otherwise swallow keys it has its own bindings for.
 */
export function useCommandKeys(keymap: ResolvedKeymap, handlers: CommandHandlers, active = true) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!active) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const binding = bindingFromEvent(event, PLATFORM);
      if (!binding) return;

      const commandId = keymap.byBinding.get(binding);
      if (!commandId) return;

      const handler = handlersRef.current[commandId];
      if (!handler) return;

      event.preventDefault();
      event.stopPropagation();
      handler();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [keymap, active]);
}
