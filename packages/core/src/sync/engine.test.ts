import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultCommitMessage, VaultSync } from './engine';
import { DEFAULT_SYNC_SETTINGS } from './settings';
import type { MergeOutcome, RepoStatus, SyncPort } from './types';

const ROOT = '/vault';

function status(over: Partial<RepoStatus> = {}): RepoStatus {
  return {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    changes: [],
    ...over,
  };
}

function err(code: string, message = code) {
  return Object.assign(new Error(message), { code, message });
}

/** A scripted git, so every branch of the engine can be provoked on demand. */
class FakePort implements SyncPort {
  statusValue: RepoStatus = status();
  fetchValue = { newCommits: 0 };
  pullValue: MergeOutcome = { kind: 'alreadyUpToDate' };

  commitError: unknown = null;
  pushError: unknown = null;
  fetchError: unknown = null;
  pullError: unknown = null;

  calls: string[] = [];
  /** Records overlap; must stay empty or git's index lock would be contended. */
  overlaps: string[] = [];
  private inFlight = 0;

  private async track<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    this.calls.push(name);
    if (this.inFlight > 0) this.overlaps.push(name);
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
    }
  }

  status(): Promise<RepoStatus> {
    return this.track('status', () => this.statusValue);
  }

  commit(_root: string, message: string): Promise<string> {
    return this.track('commit', () => {
      this.calls.push(`commit:${message}`);
      if (this.commitError) throw this.commitError;
      this.statusValue = { ...this.statusValue, changes: [], ahead: this.statusValue.ahead + 1 };
      return 'abc123';
    });
  }

  fetch(): Promise<{ newCommits: number }> {
    return this.track('fetch', () => {
      if (this.fetchError) throw this.fetchError;
      return this.fetchValue;
    });
  }

  pullRebase(): Promise<MergeOutcome> {
    return this.track('pullRebase', () => {
      if (this.pullError) throw this.pullError;
      return this.pullValue;
    });
  }

  push(): Promise<void> {
    return this.track('push', () => {
      if (this.pushError) throw this.pushError;
      this.statusValue = { ...this.statusValue, ahead: 0 };
    });
  }
}

function makeEngine(port: FakePort, over: Partial<typeof DEFAULT_SYNC_SETTINGS> = {}) {
  const externalChanges: MergeOutcome[] = [];
  const engine = new VaultSync({
    root: ROOT,
    port,
    settings: { commitIdleMs: 1_000, pushDebounceMs: 500, fetchIntervalMs: 10_000, ...over },
    onExternalChange: (o) => externalChanges.push(o),
  });
  return { engine, externalChanges };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Remove fetch jitter so interval assertions are exact.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('commitWith', () => {
  it('commits everything under the given message', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'a.md', state: 'modified' }] });
    const { engine } = makeEngine(port);
    await engine.start();

    await engine.commitWith('notes: rename #a to #b (3 notes)');
    expect(port.calls).toContain('commit:notes: rename #a to #b (3 notes)');
    engine.stop();
  });

  it('makes a queued auto-commit stand aside rather than stealing the changes', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'a.md', state: 'modified' }] });
    const { engine } = makeEngine(port);
    await engine.start();

    // Both are queued in this order; the named one must be the commit that runs.
    const auto = engine.syncNow();
    const named = engine.commitWith('notes: remove #x (2 notes)');
    await Promise.all([auto, named]);

    const commits = port.calls.filter((c) => c.startsWith('commit:'));
    expect(commits).toEqual(['commit:notes: remove #x (2 notes)']);
    engine.stop();
  });

  it('refuses to commit while conflicted, like everything else', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'a.md', state: 'conflicted' }] });
    const { engine } = makeEngine(port);
    await engine.start();
    await engine.syncNow().catch(() => {});
    port.calls.length = 0;

    await engine.commitWith('notes: rename #a to #b (1 note)');
    expect(port.calls.filter((c) => c.startsWith('commit:'))).toEqual([]);
    engine.stop();
  });
});

describe('commit loop', () => {
  it('commits once the editor has been idle', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    const { engine } = makeEngine(port);
    await engine.start();

    engine.noteChanged();
    expect(engine.getState().phase).toBe('dirty');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(port.calls).toContain('commit');
    engine.stop();
  });

  it('does not commit while the user is still typing', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    const { engine } = makeEngine(port);
    await engine.start();

    for (let i = 0; i < 5; i++) {
      engine.noteChanged();
      await vi.advanceTimersByTimeAsync(600);
    }
    expect(port.calls).not.toContain('commit');
    engine.stop();
  });

  it('commits anyway once edits exceed the maximum wait', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    const { engine } = makeEngine(port, { commitIdleMs: 1_000, commitMaxWaitMs: 5_000 });
    await engine.start();

    // Continuous typing would otherwise postpone the commit forever.
    for (let i = 0; i < 12; i++) {
      engine.noteChanged();
      await vi.advanceTimersByTimeAsync(600);
    }
    expect(port.calls).toContain('commit');
    engine.stop();
  });

  it('summarises multiple changed notes in the commit message', async () => {
    const port = new FakePort();
    port.statusValue = status({
      changes: [
        { path: 'a.md', state: 'modified' },
        { path: 'b.md', state: 'modified' },
        { path: 'c.md', state: 'untracked' },
      ],
    });
    const { engine } = makeEngine(port);
    await engine.start();
    engine.noteChanged();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(port.calls).toContain('commit:notes: update 3 notes');
    engine.stop();
  });

  it('treats "nothing to commit" as routine, not an error', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    port.commitError = err('nothingToCommit');
    const { engine } = makeEngine(port);
    await engine.start();

    engine.noteChanged();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(engine.getState().phase).not.toBe('error');
    expect(engine.getState().lastError).toBeNull();
    engine.stop();
  });

  it('does not commit when autoCommit is off', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    const { engine } = makeEngine(port, { autoCommit: false });
    await engine.start();

    engine.noteChanged();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(port.calls).not.toContain('commit');
    engine.stop();
  });
});

describe('push loop', () => {
  it('pushes after a commit', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    const { engine } = makeEngine(port);
    await engine.start();

    engine.noteChanged();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(500);

    expect(port.calls).toContain('push');
    engine.stop();
  });

  it('does not push when autoPush is off', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    const { engine } = makeEngine(port, { autoPush: false });
    await engine.start();

    engine.noteChanged();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(port.calls).toContain('commit');
    expect(port.calls).not.toContain('push');
    engine.stop();
  });

  it('rebases and retries once when the remote rejects the push', async () => {
    const port = new FakePort();
    port.statusValue = status({ ahead: 1 });
    const { engine } = makeEngine(port);
    await engine.start();

    let attempts = 0;
    const original = port.push.bind(port);
    port.push = () => {
      attempts += 1;
      if (attempts === 1) {
        port.calls.push('push');
        return Promise.reject(err('pushRejected'));
      }
      return original();
    };

    await engine.syncNow();

    expect(port.calls).toContain('pullRebase');
    expect(attempts).toBe(2);
    expect(engine.getState().lastError).toBeNull();
    engine.stop();
  });

  it('backs off exponentially while offline', async () => {
    const port = new FakePort();
    port.statusValue = status({ ahead: 1 });
    port.pushError = err('offline');
    const { engine } = makeEngine(port, { retryBaseMs: 1_000, retryMaxMs: 8_000 });
    await engine.start();

    await engine.syncNow();
    expect(engine.getState().phase).toBe('offline');

    const countPushes = () => port.calls.filter((c) => c === 'push').length;
    const afterFirst = countPushes();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(countPushes()).toBe(afterFirst + 1);

    // The next retry must wait longer than the first.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(countPushes()).toBe(afterFirst + 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(countPushes()).toBe(afterFirst + 2);

    engine.stop();
  });

  it('publishes commits left unpushed by a previous session', async () => {
    // Quit while offline with work committed but not pushed; on next launch it
    // must go out on its own.
    const port = new FakePort();
    port.statusValue = status({ ahead: 3 });
    const { engine } = makeEngine(port);

    await engine.start();
    await vi.advanceTimersByTimeAsync(500);

    expect(port.calls).toContain('push');
    engine.stop();
  });

  it('does not push a backlog when autoPush is off', async () => {
    const port = new FakePort();
    port.statusValue = status({ ahead: 3 });
    const { engine } = makeEngine(port, { autoPush: false });

    await engine.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(port.calls).not.toContain('push');
    engine.stop();
  });

  it('does not push a backlog with no upstream to push to', async () => {
    const port = new FakePort();
    port.statusValue = status({ upstream: null, ahead: 3 });
    const { engine } = makeEngine(port);

    await engine.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(port.calls).not.toContain('push');
    engine.stop();
  });

  it('does not push when there is nothing waiting', async () => {
    const port = new FakePort();
    port.statusValue = status({ ahead: 0 });
    const { engine } = makeEngine(port);

    await engine.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(port.calls).not.toContain('push');
    engine.stop();
  });

  it('reports a missing upstream instead of failing silently', async () => {
    const port = new FakePort();
    port.statusValue = status({ upstream: null, ahead: 2 });
    const { engine } = makeEngine(port);
    await engine.start();

    await engine.syncNow();
    expect(engine.getState().lastError?.code).toBe('noUpstream');
    expect(port.calls).not.toContain('push');
    engine.stop();
  });
});

describe('fetch loop', () => {
  it('polls the remote on an interval', async () => {
    const port = new FakePort();
    const { engine } = makeEngine(port, { fetchIntervalMs: 10_000 });
    await engine.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(port.calls.filter((c) => c === 'fetch')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(port.calls.filter((c) => c === 'fetch')).toHaveLength(2);
    engine.stop();
  });

  it('integrates upstream work and announces the change', async () => {
    const port = new FakePort();
    port.fetchValue = { newCommits: 2 };
    port.pullValue = { kind: 'rebased', commits: 2 };
    const { engine, externalChanges } = makeEngine(port, { fetchIntervalMs: 10_000 });
    await engine.start();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(port.calls).toContain('pullRebase');
    // The UI must know to reload any open buffer.
    expect(externalChanges).toEqual([{ kind: 'rebased', commits: 2 }]);
    engine.stop();
  });

  it('does not pull when there is nothing upstream', async () => {
    const port = new FakePort();
    port.fetchValue = { newCommits: 0 };
    const { engine } = makeEngine(port, { fetchIntervalMs: 10_000 });
    await engine.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(port.calls).not.toContain('pullRebase');
    engine.stop();
  });

  it('does not fetch when autoFetch is off', async () => {
    const port = new FakePort();
    const { engine } = makeEngine(port, { autoFetch: false, fetchIntervalMs: 10_000 });
    await engine.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(port.calls).not.toContain('fetch');
    engine.stop();
  });

  it('keeps polling after a fetch fails', async () => {
    const port = new FakePort();
    port.fetchError = err('offline');
    const { engine } = makeEngine(port, { fetchIntervalMs: 10_000 });
    await engine.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.getState().phase).toBe('offline');

    port.fetchError = null;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(port.calls.filter((c) => c === 'fetch').length).toBeGreaterThanOrEqual(2);
    engine.stop();
  });
});

describe('conflicts', () => {
  it('parks the vault instead of resolving a conflicted rebase', async () => {
    const port = new FakePort();
    port.fetchValue = { newCommits: 1 };
    port.pullValue = { kind: 'conflicted', paths: ['note.md'] };
    const { engine } = makeEngine(port, { fetchIntervalMs: 10_000 });
    await engine.start();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(engine.getState().phase).toBe('conflict');
    expect(engine.getState().conflicts).toEqual(['note.md']);
    engine.stop();
  });

  it('makes no further commits or pushes while conflicted', async () => {
    const port = new FakePort();
    port.fetchValue = { newCommits: 1 };
    port.pullValue = { kind: 'conflicted', paths: ['note.md'] };
    const { engine } = makeEngine(port, { fetchIntervalMs: 10_000 });
    await engine.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const before = port.calls.length;
    engine.noteChanged();
    await vi.advanceTimersByTimeAsync(60_000);

    const since = port.calls.slice(before);
    expect(since).not.toContain('commit');
    expect(since).not.toContain('push');
    engine.stop();
  });

  it('enters the conflict phase when status reports unmerged paths', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'conflicted' }] });
    const { engine } = makeEngine(port);
    await engine.start();

    expect(engine.getState().phase).toBe('conflict');
    engine.stop();
  });

  it('stays parked if the user claims resolution but git disagrees', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'conflicted' }] });
    const { engine } = makeEngine(port);
    await engine.start();

    await engine.conflictResolved();
    expect(engine.getState().phase).toBe('conflict');
    engine.stop();
  });

  it('resumes once the conflict is genuinely resolved', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'conflicted' }] });
    const { engine } = makeEngine(port);
    await engine.start();
    expect(engine.getState().phase).toBe('conflict');

    port.statusValue = status();
    await engine.conflictResolved();

    expect(engine.getState().phase).toBe('idle');
    expect(engine.getState().conflicts).toEqual([]);
    engine.stop();
  });
});

describe('pause', () => {
  it('stops every loop', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    const { engine } = makeEngine(port, { fetchIntervalMs: 10_000 });
    await engine.start();

    engine.pause();
    engine.noteChanged();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(port.calls).not.toContain('commit');
    expect(port.calls).not.toContain('push');
    expect(port.calls).not.toContain('fetch');
    expect(engine.getState().phase).toBe('paused');
    engine.stop();
  });

  it('picks pending work back up on resume', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    const { engine } = makeEngine(port);
    await engine.start();

    engine.pause();
    engine.noteChanged();
    engine.resume();
    // resume() re-reads status before arming, so allow for that round trip.
    await vi.advanceTimersByTimeAsync(2_000);

    expect(port.calls).toContain('commit');
    engine.stop();
  });

  it('syncNow overrides a pause, because the user asked explicitly', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    const { engine } = makeEngine(port);
    await engine.start();

    engine.pause();
    await engine.syncNow();

    expect(port.calls).toContain('commit');
    expect(engine.isPaused()).toBe(false);
    engine.stop();
  });
});

describe('safety', () => {
  it('never runs two git operations at once', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    port.fetchValue = { newCommits: 1 };
    port.pullValue = { kind: 'rebased', commits: 1 };
    const { engine } = makeEngine(port, {
      commitIdleMs: 1_000,
      pushDebounceMs: 1_000,
      fetchIntervalMs: 1_000,
    });
    await engine.start();

    // Deliberately make every loop want to fire at the same moment.
    engine.noteChanged();
    void engine.syncNow();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(port.overlaps).toEqual([]);
    engine.stop();
  });

  it('reports state transitions to the listener', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    const seen: string[] = [];
    const engine = new VaultSync({
      root: ROOT,
      port,
      settings: { commitIdleMs: 1_000, pushDebounceMs: 500 },
      onState: (s) => seen.push(s.phase),
    });
    await engine.start();
    engine.noteChanged();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(seen).toContain('dirty');
    expect(seen).toContain('committing');
    engine.stop();
  });

  it('stop() cancels everything pending', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    const { engine } = makeEngine(port);
    await engine.start();

    engine.noteChanged();
    engine.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(port.calls).not.toContain('commit');
  });
});

describe('refresh', () => {
  it('picks up a branch switched outside the engine', async () => {
    const port = new FakePort();
    const { engine } = makeEngine(port);
    await engine.start();
    expect(engine.getState().branch).toBe('main');

    // The app switched branches through its own git command; nothing told the
    // engine, so without an explicit refresh the badge would keep saying main
    // until the next fetch tick — and there is none when autoFetch is off.
    port.statusValue = status({ branch: 'codex/desktop-smoke', upstream: null, ahead: 2 });
    await engine.refresh();

    expect(engine.getState().branch).toBe('codex/desktop-smoke');
    expect(engine.getState().ahead).toBe(2);
    engine.stop();
  });

  it('waits its turn rather than racing another git command', async () => {
    const port = new FakePort();
    port.statusValue = status({ changes: [{ path: 'note.md', state: 'modified' }] });
    const { engine } = makeEngine(port);
    await engine.start();

    engine.noteChanged();
    const both = Promise.all([engine.syncNow(), engine.refresh()]);
    await vi.advanceTimersByTimeAsync(2_000);
    await both;

    expect(port.overlaps).toEqual([]);
    engine.stop();
  });
});

describe('defaultCommitMessage', () => {
  it('names a single note', () => {
    expect(defaultCommitMessage(['daily/2026-08-29.md'])).toBe('notes: update daily/2026-08-29.md');
  });

  it('counts several notes', () => {
    expect(defaultCommitMessage(['a.md', 'b.md'])).toBe('notes: update 2 notes');
  });

  it('copes with an empty list', () => {
    expect(defaultCommitMessage([])).toBe('notes: update');
  });
});
