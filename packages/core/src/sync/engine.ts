import { DEFAULT_SYNC_SETTINGS, type SyncSettings } from './settings';
import {
  errorCode,
  errorMessage,
  type MergeOutcome,
  type RepoStatus,
  type SyncPort,
  type SyncState,
} from './types';

export interface VaultSyncOptions {
  root: string;
  port: SyncPort;
  settings?: Partial<SyncSettings>;
  remote?: string;
  /** Called whenever the observable state changes. */
  onState?: (state: SyncState) => void;
  /**
   * Called when upstream work changed the working tree, so the UI can reload
   * any open buffer rather than letting the user type over a stale document.
   */
  onExternalChange?: (outcome: MergeOutcome) => void;
  /** Message for an automatic commit, given the paths that changed. */
  commitMessage?: (changed: string[]) => string;
}

const INITIAL: SyncState = {
  phase: 'idle',
  branch: '',
  upstream: null,
  ahead: 0,
  behind: 0,
  conflicts: [],
  lastError: null,
  lastSyncedAt: null,
};

export function defaultCommitMessage(changed: string[]): string {
  if (changed.length === 1) return `notes: update ${changed[0]}`;
  if (changed.length === 0) return 'notes: update';
  return `notes: update ${changed.length} notes`;
}

/**
 * The per-vault sync engine.
 *
 * Three independent debounced loops — commit, push and fetch — each of which
 * can be disabled on its own. Two rules govern everything here:
 *
 * 1. **Never resolve a conflict.** On conflict the engine stops all automation
 *    and waits for the user. Silently losing one note would permanently destroy
 *    trust in the app, which is worth more than any amount of convenience.
 * 2. **Never run two git operations at once.** Git takes an index lock, so
 *    overlapping commands fail in confusing ways. Everything is serialised.
 */
export class VaultSync {
  private readonly root: string;
  private readonly port: SyncPort;
  private readonly remote: string;
  private readonly onState: (state: SyncState) => void;
  private readonly onExternalChange: (outcome: MergeOutcome) => void;
  private readonly commitMessage: (changed: string[]) => string;

  private settings: SyncSettings;
  private state: SyncState = { ...INITIAL };

  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while a `commitWith` waits in the queue; auto-commits stand aside. */
  private namedCommitPending = false;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;

  /** When the oldest uncommitted edit arrived, for the max-wait ceiling. */
  private dirtySince: number | null = null;
  private pushFailures = 0;
  private running = false;
  private started = false;
  private paused = false;
  /** Serialises git operations; see rule 2 above. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: VaultSyncOptions) {
    this.root = options.root;
    this.port = options.port;
    this.remote = options.remote ?? 'origin';
    this.onState = options.onState ?? (() => {});
    this.onExternalChange = options.onExternalChange ?? (() => {});
    this.commitMessage = options.commitMessage ?? defaultCommitMessage;
    this.settings = { ...DEFAULT_SYNC_SETTINGS, ...options.settings };
  }

  getState(): SyncState {
    return { ...this.state };
  }

  getSettings(): SyncSettings {
    return { ...this.settings };
  }

  /** Apply new settings and re-arm the loops they affect. */
  updateSettings(next: Partial<SyncSettings>) {
    this.settings = { ...this.settings, ...next };
    if (!this.started) return;
    this.armFetch();
    if (!this.settings.autoCommit) this.clear('commit');
    if (!this.settings.autoPush) this.clear('push');
  }

  /**
   * Re-read git's status without touching the working tree.
   *
   * Anything outside the engine that runs git — switching branches, restoring
   * a file from history — changes what the badge and the branch label should
   * say, and nothing else would notice until the next fetch tick.
   */
  async refresh(): Promise<SyncState> {
    await this.enqueue(() => this.refreshStatus());
    return this.getState();
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.refreshStatus();
    // A previous session may have committed but failed to push — offline, or
    // the app was quit before the debounce elapsed. Without this those commits
    // would sit on this machine forever, which is exactly the kind of silent
    // loss the engine exists to prevent.
    this.publishBacklog();
    this.armFetch();
  }

  /** Schedule a push if commits are waiting and pushing is allowed. */
  private publishBacklog() {
    if (this.paused || this.isConflicted()) return;
    if (!this.settings.autoPush || !this.state.upstream) return;
    if (this.state.ahead > 0) this.armPush();
  }

  stop() {
    this.started = false;
    this.clear('commit');
    this.clear('push');
    this.clear('fetch');
  }

  /** The global kill switch. Timers are dropped; nothing is lost. */
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.clear('commit');
    this.clear('push');
    this.clear('fetch');
    this.patch({ phase: 'paused' });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.armFetch();
    // Ask git what actually changed rather than trusting in-memory bookkeeping:
    // the user may have edited, or even committed by hand, while paused.
    void this.enqueue(async () => {
      const status = await this.port.status(this.root).catch(() => null);
      if (!status) return;
      if (this.noteConflicts(status)) return;
      this.applyStatus(status);
      this.patch({ phase: this.idlePhase(status) });
      if (status.changes.length > 0) {
        this.dirtySince ??= Date.now();
        this.armCommit();
      }
    });
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Whether the vault is parked on a conflict.
   *
   * A method rather than an inline `this.state.phase === 'conflict'` check: the
   * operations below mutate state across `await` boundaries, and reading the
   * field directly invites the type checker (correctly, by its rules) to assume
   * it cannot have changed.
   */
  isConflicted(): boolean {
    return this.state.phase === 'conflict';
  }

  /**
   * Report that a note was written to disk.
   *
   * Called by the autosave loop, not on every keystroke — this is about files,
   * not edits.
   */
  noteChanged() {
    if (this.isConflicted()) return;
    this.dirtySince ??= Date.now();
    // While paused we record that work is pending but arm nothing; `resume`
    // reconciles against git.
    if (this.paused) return;
    this.patch({ phase: 'dirty' });
    this.armCommit();
  }

  /**
   * Commit everything outstanding right now, under a specific message.
   *
   * For vault-wide operations — a tag rename touching fourteen notes — that
   * must land as one revertable commit named for what happened, rather than
   * dissolving into the next autosave batch.
   */
  async commitWith(message: string): Promise<boolean> {
    this.clear('commit');
    // An auto-commit whose timer already fired may sit in the queue ahead of
    // this one; the flag makes it stand aside so the changes land under the
    // named message, not a generic one.
    this.namedCommitPending = true;
    let committed = false;
    await this.enqueue(async () => {
      this.namedCommitPending = false;
      if (this.isConflicted()) return;
      const status = await this.port.status(this.root).catch(() => null);
      if (status && this.noteConflicts(status)) return;
      if (status && status.changes.length === 0) {
        // Everything already landed — for the caller that is success.
        committed = true;
        return;
      }

      this.patch({ phase: 'committing' });
      try {
        await this.port.commit(this.root, message);
        committed = true;
        this.dirtySince = null;
        this.patch({ lastError: null });
        await this.refreshStatus();
      } catch (e) {
        if (errorCode(e) === 'nothingToCommit') {
          committed = true;
          this.dirtySince = null;
          await this.refreshStatus();
          return;
        }
        // Reported, not swallowed: "merged" must not be said over a commit a
        // hook or signing setup rejected.
        this.fail(e);
      }
    });
    this.armPush();
    return committed;
  }

  /**
   * Reserve the next commit for `commitWith`, before the slow work starts.
   *
   * A vault-wide operation writes many files over many awaits; the idle timer
   * can fire mid-flight and commit half of them generically. Reserving first
   * makes any auto-commit stand aside for the named one. Always paired with
   * `releaseNamedCommit` in a finally — a reservation nothing redeems would
   * silence auto-commits forever.
   */
  reserveNamedCommit(): void {
    this.namedCommitPending = true;
  }

  releaseNamedCommit(): void {
    this.namedCommitPending = false;
  }

  /** Commit, integrate and publish immediately, ignoring every debounce. */
  async syncNow(): Promise<SyncState> {
    if (this.paused) this.resume();
    this.clear('commit');
    this.clear('push');
    await this.enqueue(async () => {
      await this.doCommit();
      if (this.isConflicted()) return;
      await this.doPull();
      if (this.isConflicted()) return;
      await this.doPush();
    });
    return this.getState();
  }

  /**
   * Re-check after the user says they have resolved a conflict.
   *
   * If git still reports conflicts the engine stays parked rather than taking
   * their word for it.
   */
  async conflictResolved(): Promise<SyncState> {
    await this.enqueue(async () => {
      const status = await this.port.status(this.root);
      const conflicts = status.changes.filter((c) => c.state === 'conflicted').map((c) => c.path);
      if (conflicts.length > 0) {
        this.patch({ phase: 'conflict', conflicts });
        return;
      }
      this.applyStatus(status);
      this.patch({ conflicts: [], lastError: null, phase: this.idlePhase(status) });
      if (status.changes.length > 0) {
        this.dirtySince ??= Date.now();
        this.armCommit();
      }
      this.armFetch();
    });
    return this.getState();
  }

  // -- loops ---------------------------------------------------------------

  private armCommit() {
    if (!this.settings.autoCommit || this.paused) return;
    this.clear('commit');

    const idleAt = Date.now() + this.settings.commitIdleMs;
    // Never let continuous typing postpone a commit indefinitely.
    const deadline = (this.dirtySince ?? Date.now()) + this.settings.commitMaxWaitMs;
    const delay = Math.max(0, Math.min(idleAt, deadline) - Date.now());

    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      void this.enqueue(async () => {
        await this.doCommit();
        if (this.settings.autoPush && !this.isConflicted()) this.armPush();
      });
    }, delay);
  }

  private armPush(delayMs?: number) {
    if (!this.settings.autoPush || this.paused) return;
    this.clear('push');
    const delay = delayMs ?? this.settings.pushDebounceMs;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.enqueue(() => this.doPush());
    }, delay);
  }

  private armFetch() {
    this.clear('fetch');
    if (!this.settings.autoFetch || this.paused || !this.started) return;
    // Jitter keeps many open vaults from hitting a forge in lockstep.
    const jitter = Math.floor(Math.random() * Math.min(5_000, this.settings.fetchIntervalMs / 4));
    this.fetchTimer = setTimeout(() => {
      this.fetchTimer = null;
      void this.enqueue(async () => {
        await this.doFetch();
      }).finally(() => this.armFetch());
    }, this.settings.fetchIntervalMs + jitter);
  }

  // -- operations ----------------------------------------------------------

  private async doCommit() {
    if (this.isConflicted()) return;
    // A named commit is queued right behind; it will carry these changes.
    if (this.namedCommitPending) return;
    const status = await this.port.status(this.root).catch(() => null);
    if (status && this.noteConflicts(status)) return;
    if (status && status.changes.length === 0) {
      this.dirtySince = null;
      this.applyStatus(status);
      this.patch({ phase: this.idlePhase(status) });
      return;
    }

    this.patch({ phase: 'committing' });
    const changed = status?.changes.map((c) => c.path) ?? [];
    try {
      await this.port.commit(this.root, this.commitMessage(changed));
      this.dirtySince = null;
      this.patch({ lastError: null });
      await this.refreshStatus();
    } catch (e) {
      if (errorCode(e) === 'nothingToCommit') {
        // Routine: the file was saved but its bytes did not actually change.
        this.dirtySince = null;
        await this.refreshStatus();
        return;
      }
      this.fail(e);
    }
  }

  private async doPush() {
    if (this.isConflicted()) return;
    if (!this.state.upstream) {
      this.patch({
        phase: 'error',
        lastError: {
          code: 'noUpstream',
          message: `Branch '${this.state.branch}' has no upstream, so there is nowhere to push.`,
        },
      });
      return;
    }
    if (this.state.ahead === 0) return;

    this.patch({ phase: 'pushing' });
    try {
      await this.port.push(this.root, this.remote, this.state.branch);
      this.pushFailures = 0;
      this.patch({ lastError: null, lastSyncedAt: Date.now() });
      await this.refreshStatus();
    } catch (e) {
      const code = errorCode(e);
      if (code === 'pushRejected') {
        // Somebody pushed first. Integrate their work, then try once more.
        await this.doPull();
        if (this.isConflicted()) return;
        try {
          await this.port.push(this.root, this.remote, this.state.branch);
          this.pushFailures = 0;
          this.patch({ lastError: null, lastSyncedAt: Date.now() });
          await this.refreshStatus();
          return;
        } catch (retryError) {
          this.backOff(retryError);
          return;
        }
      }
      this.backOff(e);
    }
  }

  private async doFetch() {
    if (this.isConflicted() || !this.state.upstream) return;

    this.patch({ phase: 'fetching' });
    try {
      const { newCommits } = await this.port.fetch(this.root, this.remote);
      this.patch({ lastError: null });
      if (newCommits > 0) {
        await this.doPull();
      } else {
        await this.refreshStatus();
      }
      this.publishBacklog();
    } catch (e) {
      // A failed fetch is not worth alarming anyone about; the next tick retries.
      if (errorCode(e) === 'offline') {
        this.patch({ phase: 'offline' });
        return;
      }
      this.fail(e);
    }
  }

  private async doPull() {
    if (this.isConflicted()) return;
    try {
      const outcome = await this.port.pullRebase(this.root);
      if (outcome.kind === 'conflicted') {
        // Stop everything. Resolution is the user's decision, always.
        this.clear('commit');
        this.clear('push');
        this.patch({
          phase: 'conflict',
          conflicts: outcome.paths,
          lastError: {
            code: 'conflicted',
            message: `Conflicts need resolving in ${outcome.paths.join(', ')}`,
          },
        });
        return;
      }
      if (outcome.kind !== 'alreadyUpToDate') {
        this.onExternalChange(outcome);
      }
      this.patch({ lastError: null, lastSyncedAt: Date.now() });
      await this.refreshStatus();
    } catch (e) {
      if (errorCode(e) === 'offline') {
        this.patch({ phase: 'offline' });
        return;
      }
      this.fail(e);
    }
  }

  private async refreshStatus() {
    try {
      const status = await this.port.status(this.root);
      if (this.noteConflicts(status)) return;
      this.applyStatus(status);
      this.patch({ phase: this.idlePhase(status) });
    } catch (e) {
      this.fail(e);
    }
  }

  // -- helpers -------------------------------------------------------------

  /** Enter the conflict phase if git reports unmerged paths. */
  private noteConflicts(status: RepoStatus): boolean {
    const conflicts = status.changes.filter((c) => c.state === 'conflicted').map((c) => c.path);
    if (conflicts.length === 0) return false;
    this.clear('commit');
    this.clear('push');
    this.applyStatus(status);
    this.patch({
      phase: 'conflict',
      conflicts,
      lastError: {
        code: 'conflicted',
        message: `Conflicts need resolving in ${conflicts.join(', ')}`,
      },
    });
    return true;
  }

  private idlePhase(status: RepoStatus): SyncState['phase'] {
    if (this.paused) return 'paused';
    if (status.changes.length > 0) return 'dirty';
    if (status.behind > 0) return 'behind';
    return 'idle';
  }

  private applyStatus(status: RepoStatus) {
    this.patch({
      branch: status.branch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
    });
  }

  private backOff(e: unknown) {
    this.pushFailures += 1;
    const delay = Math.min(
      this.settings.retryBaseMs * 2 ** (this.pushFailures - 1),
      this.settings.retryMaxMs,
    );
    const code = errorCode(e);
    this.patch({
      phase: code === 'offline' ? 'offline' : 'error',
      lastError: { code, message: errorMessage(e) },
    });
    this.armPush(delay);
  }

  private fail(e: unknown) {
    this.patch({ phase: 'error', lastError: { code: errorCode(e), message: errorMessage(e) } });
  }

  private patch(next: Partial<SyncState>) {
    this.state = { ...this.state, ...next };
    this.onState(this.getState());
  }

  private clear(which: 'commit' | 'push' | 'fetch') {
    const timer =
      which === 'commit' ? this.commitTimer : which === 'push' ? this.pushTimer : this.fetchTimer;
    if (timer) clearTimeout(timer);
    if (which === 'commit') this.commitTimer = null;
    else if (which === 'push') this.pushTimer = null;
    else this.fetchTimer = null;
  }

  /** Chain onto the queue so git operations never overlap. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      this.running = true;
      try {
        return await fn();
      } finally {
        this.running = false;
      }
    });
    // Keep the chain alive even if this link rejects.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Exposed for tests: is a git operation in flight? */
  isRunning(): boolean {
    return this.running;
  }
}
