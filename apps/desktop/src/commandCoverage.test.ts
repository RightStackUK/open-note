import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS } from '@open-note/core';
import { editorCommands } from '@open-note/editor';
import { describe, expect, it } from 'vitest';

/**
 * Every declared command must actually do something.
 *
 * Ten `edit.*` commands once shipped declared, bound to keys and listed in the
 * command palette, while doing nothing at all — because nothing checked. The
 * app source is read as text rather than imported: importing `App` would drag
 * in CodeMirror, Excalidraw and the Tauri bridge for a check that only needs to
 * know which ids are wired.
 */
const appSource = readFileSync(join(__dirname, 'App.tsx'), 'utf8');

function isHandledByApp(id: string): boolean {
  return appSource.includes(`'${id}':`);
}

describe('command coverage', () => {
  it('implements or handles every declared command', () => {
    const orphans = COMMANDS.filter(
      (command) => !isHandledByApp(command.id) && !(command.id in editorCommands),
    ).map((command) => `${command.id} (${command.title})`);

    expect(orphans, 'commands that are advertised but do nothing').toEqual([]);
  });

  it('does not implement editor commands the registry never declares', () => {
    // The reverse gap: an implementation nothing can reach.
    const declared = new Set(COMMANDS.map((c) => c.id));
    const unreachable = Object.keys(editorCommands).filter((id) => !declared.has(id));

    expect(unreachable, 'editor commands missing from the registry').toEqual([]);
  });

  it('covers every edit.* command in the editor package', () => {
    const editIds = COMMANDS.filter((c) => c.id.startsWith('edit.')).map((c) => c.id);
    expect(editIds.length).toBeGreaterThan(0);
    for (const id of editIds) {
      expect(editorCommands[id], `${id} has no implementation`).toBeTypeOf('function');
    }
  });
});
