import { normaliseWorkspace, type Workspace } from '@open-note/core';

/**
 * Which workspace a vault is in, per vault.
 *
 * Machine-local in `localStorage`, beside the pane layout and the open tabs:
 * being inside `#work` is where *this machine* is looking, not a fact about the
 * vault, and a tracked file would have the sync engine commit and push every
 * time you changed rooms — and then have two machines argue about which room
 * you are in.
 *
 * It does persist across restarts, which is deliberate: the whole point is that
 * the app stays inside the workspace "until you leave", and quietly dropping
 * you back into the whole vault overnight would be a different promise.
 */
export const WORKSPACE_PREFIX = 'opennote:workspace:';

export function workspaceKey(root: string): string {
  return `${WORKSPACE_PREFIX}${root}`;
}

/**
 * Read the stored workspace.
 *
 * Normalised on the way out as well as in: the value is hand-editable, and a
 * `#work` written by someone editing storage must mean the same workspace as
 * the `work` the app wrote.
 */
export function readWorkspace(root: string): Workspace {
  try {
    return normaliseWorkspace(localStorage.getItem(workspaceKey(root)));
  } catch {
    // Storage can be unavailable outright; the whole vault is the safe answer,
    // because it is the one that cannot hide a note from you.
    return null;
  }
}

export function writeWorkspace(root: string, workspace: Workspace): void {
  try {
    if (!workspace) localStorage.removeItem(workspaceKey(root));
    else localStorage.setItem(workspaceKey(root), workspace);
  } catch {
    // Full or unavailable storage costs the choice its persistence, no more.
  }
}
