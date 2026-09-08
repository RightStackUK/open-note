import { describe, expect, it, vi } from 'vitest';

import { checkForAppUpdate, type UpdateDependencies, type UpdateSource } from './updates';

function dependencies(
  update: Awaited<ReturnType<UpdateDependencies['check']>>,
): UpdateDependencies & { relaunch: ReturnType<typeof vi.fn> } {
  return {
    check: vi.fn().mockResolvedValue(update),
    relaunch: vi.fn().mockResolvedValue(undefined),
  };
}

describe('app updates', () => {
  it('returns null when the installed version is current', async () => {
    const deps = dependencies(null);

    await expect(checkForAppUpdate(deps)).resolves.toBeNull();
    expect(deps.relaunch).not.toHaveBeenCalled();
  });

  it('exposes update metadata and installs before relaunching', async () => {
    const order: string[] = [];
    const download: UpdateSource['download'] = vi.fn(async (onEvent) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 25 } });
      onEvent({ event: 'Progress', data: { chunkLength: 75 } });
      onEvent({ event: 'Finished' });
      order.push('download');
    });
    const install = vi.fn(async () => {
      order.push('install');
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const deps = dependencies({
      version: '1.2.3',
      body: 'Release notes',
      download,
      install,
      close,
    });
    deps.relaunch.mockImplementation(async () => {
      order.push('relaunch');
    });
    const beforeInstall = vi.fn(async () => {
      order.push('save');
    });
    const progress = vi.fn();

    const update = await checkForAppUpdate(deps);
    expect(update).toMatchObject({ version: '1.2.3', notes: 'Release notes' });

    await update?.install(progress, beforeInstall);

    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { downloaded: 0, total: 100, finished: false },
      { downloaded: 25, total: 100, finished: false },
      { downloaded: 100, total: 100, finished: false },
      { downloaded: 100, total: 100, finished: true },
    ]);
    expect(download).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(order).toEqual(['download', 'save', 'install', 'relaunch']);
    expect(deps.relaunch).toHaveBeenCalledOnce();

    await update?.discard();
    expect(close).toHaveBeenCalledOnce();
  });

  it('supports servers that do not report a download size', async () => {
    const download: UpdateSource['download'] = vi.fn(async (onEvent) => {
      onEvent({ event: 'Started', data: { contentLength: undefined } });
      onEvent({ event: 'Progress', data: { chunkLength: 12 } });
    });
    const deps = dependencies({
      version: '2.0.0',
      body: null,
      download,
      install: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const progress = vi.fn();

    const update = await checkForAppUpdate(deps);
    await update?.install(progress);

    expect(progress).toHaveBeenLastCalledWith({ downloaded: 12, total: null, finished: false });
  });

  it('does not relaunch when installation fails', async () => {
    const failure = new Error('signature mismatch');
    const deps = dependencies({
      version: '1.2.3',
      body: null,
      download: vi.fn().mockRejectedValue(failure),
      install: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const update = await checkForAppUpdate(deps);

    await expect(update?.install(vi.fn())).rejects.toBe(failure);
    expect(deps.relaunch).not.toHaveBeenCalled();
  });
});
