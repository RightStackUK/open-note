export interface UpdateDownloadProgress {
  downloaded: number;
  total: number | null;
  finished: boolean;
}

export type UpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export interface UpdateSource {
  version: string;
  body?: string | null;
  download(onEvent: (event: UpdateDownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}

export interface UpdateDependencies {
  check(): Promise<UpdateSource | null>;
  relaunch(): Promise<void>;
}

export interface AppUpdate {
  version: string;
  notes: string | null;
  discard(): Promise<void>;
  install(
    onProgress: (progress: UpdateDownloadProgress) => void,
    beforeInstall?: () => Promise<void>,
  ): Promise<void>;
}

async function tauriDependencies(): Promise<UpdateDependencies> {
  const [{ check }, { relaunch }] = await Promise.all([
    import('@tauri-apps/plugin-updater'),
    import('@tauri-apps/plugin-process'),
  ]);
  return {
    check: () => check({ timeout: 30_000 }),
    relaunch,
  };
}

/**
 * Check the stable release feed and turn Tauri's resource-backed update into
 * the small shape the app needs. Dependencies are injectable because neither
 * Vitest nor the web screenshot harness runs inside a Tauri process.
 */
export async function checkForAppUpdate(
  dependencies?: UpdateDependencies,
): Promise<AppUpdate | null> {
  const runtime = dependencies ?? (await tauriDependencies());
  const update = await runtime.check();
  if (!update) return null;

  return {
    version: update.version,
    notes: update.body?.trim() || null,
    discard: () => update.close(),
    install: async (onProgress, beforeInstall) => {
      let downloaded = 0;
      let total: number | null = null;

      await update.download((event) => {
        if (event.event === 'Started') {
          downloaded = 0;
          total = event.data.contentLength ?? null;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
        }
        onProgress({ downloaded, total, finished: event.event === 'Finished' });
      });

      // Saving here (rather than before a potentially slow download) also
      // captures text entered while the update was downloading. Windows exits
      // as soon as install launches, so there is no later safe moment.
      await beforeInstall?.();
      await update.install();

      // Windows exits as part of installer launch. On macOS and Linux the
      // install has landed, but the running process must be replaced to use it.
      await runtime.relaunch();
    },
  };
}
