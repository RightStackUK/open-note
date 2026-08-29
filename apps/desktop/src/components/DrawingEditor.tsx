import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import '@excalidraw/excalidraw/index.css';

// Excalidraw is large and most notes are text, so it is only fetched when a
// drawing is actually opened.
const Excalidraw = lazy(async () => {
  const module = await import('@excalidraw/excalidraw');
  return { default: module.Excalidraw };
});

/** How long the canvas sits idle before the drawing is written to disk. */
const AUTOSAVE_IDLE_MS = 800;

interface DrawingEditorProps {
  path: string;
  /** The file's JSON, or an empty string for a drawing that does not exist yet. */
  source: string;
  dark: boolean;
  onSave: (json: string) => void;
}

interface ExcalidrawScene {
  type: string;
  version: number;
  source: string;
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

const EMPTY_SCENE: ExcalidrawScene = {
  type: 'excalidraw',
  version: 2,
  source: 'https://theopennote.com',
  elements: [],
  appState: {},
  files: {},
};

/**
 * Parse a `.excalidraw` file.
 *
 * A malformed file yields an empty scene rather than throwing: refusing to open
 * a drawing is worse than opening it blank, and the original bytes are still on
 * disk and in git history until the user saves over them.
 */
function parseScene(source: string): ExcalidrawScene {
  if (!source.trim()) return EMPTY_SCENE;
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === 'object') {
      return {
        ...EMPTY_SCENE,
        ...parsed,
        elements: Array.isArray(parsed.elements) ? parsed.elements : [],
      };
    }
  } catch {
    // Fall through to an empty scene.
  }
  return EMPTY_SCENE;
}

/**
 * Serialise a scene back to the `.excalidraw` format.
 *
 * Pretty-printed deliberately: the format is plaintext JSON precisely so it can
 * live in git, and one-key-per-line keeps diffs readable when a drawing changes.
 * Transient view state (scroll position, current zoom, which tool is selected)
 * is dropped, or every pan would show up as a change to commit.
 */
export function serialiseScene(
  elements: readonly unknown[],
  appState: Record<string, unknown>,
  files: Record<string, unknown>,
): string {
  const { viewBackgroundColor, gridSize } = appState;
  const scene = {
    type: 'excalidraw',
    version: 2,
    source: 'https://theopennote.com',
    elements,
    appState: {
      ...(viewBackgroundColor ? { viewBackgroundColor } : {}),
      ...(gridSize ? { gridSize } : {}),
    },
    files,
  };
  return `${JSON.stringify(scene, null, 2)}\n`;
}

/**
 * Bookkeeping Excalidraw rewrites whenever a scene is loaded, regardless of
 * whether anything was actually drawn.
 */
const VOLATILE_ELEMENT_FIELDS = ['version', 'versionNonce', 'updated'] as const;

/**
 * A comparable form of a scene, ignoring fields that change on their own.
 *
 * Loading a drawing bumps every element's version and stamps `updated`, so a
 * byte comparison would report a change for a drawing nobody edited — and,
 * because commits are automatic, publish it.
 */
export function sceneSignature(serialised: string): string {
  try {
    const scene = JSON.parse(serialised);
    const elements = Array.isArray(scene.elements) ? scene.elements : [];
    const stripped = elements.map((element: Record<string, unknown>) => {
      const copy = { ...element };
      for (const field of VOLATILE_ELEMENT_FIELDS) delete copy[field];
      return copy;
    });
    return JSON.stringify({ ...scene, elements: stripped });
  } catch {
    // Unparseable: fall back to the raw text so the comparison still works.
    return serialised;
  }
}

export function DrawingEditor({ path, source, dark, onSave }: DrawingEditorProps) {
  const [scene] = useState(() => parseScene(source));
  const saveTimer = useRef<number | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const lastSaved = useRef(
    sceneSignature(serialiseScene(scene.elements, scene.appState, scene.files)),
  );

  /**
   * Excalidraw fires onChange on mount, and normalises the scene as it loads —
   * bumping each element's `version`, regenerating `versionNonce` and stamping
   * `updated`. Saving that would rewrite the file, and therefore commit it, just
   * because somebody looked at it. Browsing twenty drawings would produce twenty
   * commits of pure bookkeeping.
   *
   * So: nothing is written until the user actually touches the canvas.
   */
  const touched = useRef(false);

  const onChange = useCallback(
    (
      elements: readonly unknown[],
      appState: Record<string, unknown>,
      files: Record<string, unknown>,
    ) => {
      if (!touched.current) return;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        const next = serialiseScene(elements, appState, files);
        const signature = sceneSignature(next);
        // The decisive guard: no write unless something meaningful changed.
        if (signature === lastSaved.current) return;
        lastSaved.current = signature;
        onSaveRef.current(next);
      }, AUTOSAVE_IDLE_MS);
    },
    [],
  );

  // Do not leave an edit unsaved because the user switched away.
  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const markTouched = useCallback(() => {
    touched.current = true;
  }, []);

  return (
    <div
      className="drawing"
      key={path}
      onPointerDown={markTouched}
      onKeyDown={markTouched}
      onWheel={markTouched}
    >
      <Suspense fallback={<p className="pane-empty">Loading the canvas…</p>}>
        <Excalidraw
          initialData={{
            elements: scene.elements as never,
            appState: { ...scene.appState, theme: dark ? 'dark' : 'light' } as never,
            files: scene.files as never,
            scrollToContent: true,
          }}
          theme={dark ? 'dark' : 'light'}
          onChange={onChange as never}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
        />
      </Suspense>
    </div>
  );
}
