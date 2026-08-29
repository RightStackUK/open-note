/**
 * Per-vault sync settings, stored in `.opennote/settings.json` inside the repo
 * so they travel between a user's machines.
 */
export interface SyncSettings {
  /** Batch outstanding edits into a commit automatically. */
  autoCommit: boolean;
  /** Publish commits automatically. On by default, per product decision. */
  autoPush: boolean;
  /** Poll the remote for other people's work. */
  autoFetch: boolean;
  /** Quiet period after the last edit before committing. */
  commitIdleMs: number;
  /** Commit anyway once edits have been outstanding this long. */
  commitMaxWaitMs: number;
  /** Delay between a commit and the push that publishes it. */
  pushDebounceMs: number;
  /** How often to look for upstream work. */
  fetchIntervalMs: number;
  /** First retry delay after a failed push; doubles up to `retryMaxMs`. */
  retryBaseMs: number;
  retryMaxMs: number;
}

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  autoCommit: true,
  autoPush: true,
  autoFetch: true,
  commitIdleMs: 30_000,
  commitMaxWaitMs: 300_000,
  pushDebounceMs: 10_000,
  fetchIntervalMs: 60_000,
  retryBaseMs: 5_000,
  retryMaxMs: 300_000,
};

export interface VaultSettings {
  sync: SyncSettings;
}

export const DEFAULT_VAULT_SETTINGS: VaultSettings = { sync: DEFAULT_SYNC_SETTINGS };

/** Guard against a hand-edited settings file producing a runaway timer. */
const LIMITS: Record<string, [min: number, max: number]> = {
  commitIdleMs: [1_000, 3_600_000],
  commitMaxWaitMs: [5_000, 86_400_000],
  pushDebounceMs: [0, 3_600_000],
  fetchIntervalMs: [10_000, 86_400_000],
  retryBaseMs: [1_000, 600_000],
  retryMaxMs: [5_000, 3_600_000],
};

function clampNumber(key: string, value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const limit = LIMITS[key];
  if (!limit) return value;
  return Math.min(Math.max(value, limit[0]), limit[1]);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Parse settings from the repo, falling back to defaults field by field.
 *
 * These files are hand-editable and synced between machines, so a partial,
 * stale or malformed file must never stop a vault from syncing — it degrades to
 * defaults for whatever it got wrong.
 */
export function parseVaultSettings(raw: string | null | undefined): VaultSettings {
  if (!raw) return { sync: { ...DEFAULT_SYNC_SETTINGS } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { sync: { ...DEFAULT_SYNC_SETTINGS } };
  }

  const sync =
    typeof parsed === 'object' && parsed !== null && 'sync' in parsed
      ? ((parsed as { sync: unknown }).sync as Record<string, unknown> | null)
      : null;

  if (typeof sync !== 'object' || sync === null) {
    return { sync: { ...DEFAULT_SYNC_SETTINGS } };
  }

  const d = DEFAULT_SYNC_SETTINGS;
  return {
    sync: {
      autoCommit: bool(sync.autoCommit, d.autoCommit),
      autoPush: bool(sync.autoPush, d.autoPush),
      autoFetch: bool(sync.autoFetch, d.autoFetch),
      commitIdleMs: clampNumber('commitIdleMs', sync.commitIdleMs, d.commitIdleMs),
      commitMaxWaitMs: clampNumber('commitMaxWaitMs', sync.commitMaxWaitMs, d.commitMaxWaitMs),
      pushDebounceMs: clampNumber('pushDebounceMs', sync.pushDebounceMs, d.pushDebounceMs),
      fetchIntervalMs: clampNumber('fetchIntervalMs', sync.fetchIntervalMs, d.fetchIntervalMs),
      retryBaseMs: clampNumber('retryBaseMs', sync.retryBaseMs, d.retryBaseMs),
      retryMaxMs: clampNumber('retryMaxMs', sync.retryMaxMs, d.retryMaxMs),
    },
  };
}

export function serialiseVaultSettings(settings: VaultSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
