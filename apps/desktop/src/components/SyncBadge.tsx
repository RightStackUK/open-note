import type { SyncPhase, SyncState } from '@open-note/core';

/**
 * The sync indicator.
 *
 * Every phase the engine can be in gets a label a person can act on — a vault
 * silently doing nothing is the one outcome we can never ship.
 */
const LABELS: Record<SyncPhase, string> = {
  idle: 'Synced',
  dirty: 'Not committed',
  committing: 'Committing…',
  pushing: 'Pushing…',
  fetching: 'Checking…',
  behind: 'Updates available',
  conflict: 'Conflict',
  offline: 'Offline',
  paused: 'Sync paused',
  error: 'Sync problem',
};

export function SyncBadge({ state, paused }: { state: SyncState; paused: boolean }) {
  const phase = paused ? 'paused' : state.phase;
  // "Synced" over commits that only exist on this machine is the one lie the
  // badge must not tell: with automatic pushing off, that is the steady state.
  const label = phase === 'idle' && state.ahead > 0 ? 'Not pushed' : LABELS[phase];
  return (
    <span className={`sync-badge is-${phase}`} title={state.lastError?.message ?? label}>
      <span className="sync-dot" />
      {label}
      {state.ahead > 0 && <span className="counter">↑{state.ahead}</span>}
      {state.behind > 0 && <span className="counter">↓{state.behind}</span>}
    </span>
  );
}
