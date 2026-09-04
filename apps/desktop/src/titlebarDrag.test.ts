import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The window has no native title bar (`titleBarStyle: "Overlay"`), so the
 * header strip is the only thing left to grab. Making it draggable takes three
 * separate pieces, and any one of them missing fails *silently* — the strip
 * just goes dead, which is exactly how this shipped once already:
 *
 *   1. `data-tauri-drag-region` on the header. macOS runs WKWebView, which does
 *      not implement Chromium's `-webkit-app-region`, so the CSS route is a
 *      no-op there.
 *   2. `core:window:allow-start-dragging` in the capability. It is *not* part
 *      of `core:default`, and without it the runtime's IPC call is denied.
 *   3. No leftover `-webkit-app-region`, which only ever worked on Windows and
 *      would quietly become the reason a regression looks platform-specific.
 *
 * Read as text for the same reason as the command-coverage check: importing
 * `App` drags in CodeMirror, Excalidraw and the Tauri bridge.
 */
const appSource = readFileSync(join(__dirname, 'App.tsx'), 'utf8');
const cssSource = readFileSync(join(__dirname, 'styles.css'), 'utf8');
const capability = JSON.parse(
  readFileSync(join(__dirname, '..', 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
) as { permissions: (string | { identifier: string })[] };

describe('title bar drag region', () => {
  it('declares the header as a drag region', () => {
    expect(appSource).toMatch(/<header className="titlebar" data-tauri-drag-region="deep">/);
  });

  it('grants the permission the drag region invokes', () => {
    const granted = capability.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));

    expect(granted).toContain('core:window:allow-start-dragging');
  });

  it('does not fall back to -webkit-app-region', () => {
    expect(cssSource).not.toContain('-webkit-app-region');
  });
});
