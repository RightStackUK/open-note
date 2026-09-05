import { type KeyboardEvent, type PointerEvent, useRef } from 'react';

interface Props {
  /**
   * Where the pane being sized sits relative to this handle. Dragging right
   * widens a pane on the left and narrows one on the right, so the two
   * directions cannot share a sign.
   */
  pane: 'before' | 'after';
  /** Current width in px. */
  width: number;
  min: number;
  max: number;
  /** Restored on double-click, the way a window edge snaps back. */
  fallback: number;
  /** Named for screen readers: "Resize sidebar". */
  label: string;
  /**
   * Takes the previous width rather than a number, because the arrow keys
   * repeat faster than React re-renders: computing from the `width` prop makes
   * every press in a burst read the same stale value, and all but the first
   * become no-ops.
   */
  onResize: (next: (previous: number) => number) => void;
}

/** How far one arrow-key press moves the divider. */
const KEY_STEP = 16;

/**
 * The divider between two panes.
 *
 * A `separator` with a `tabindex` is focusable and driven by the arrow keys,
 * because a control that can only be operated by dragging a four-pixel target
 * cannot be operated by everyone.
 */
export function PaneResizer({ pane, width, min, max, fallback, label, onResize }: Props) {
  const from = useRef<{ x: number; width: number } | null>(null);

  const clamp = (value: number) => Math.min(max, Math.max(min, value));
  // Dragging right grows a pane on the left and shrinks one on the right.
  const towards = pane === 'before' ? 1 : -1;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    from.current = { x: event.clientX, width };
    // Capture, or the drag stops the instant the pointer leaves the handle —
    // which is immediately, the handle being a few pixels wide.
    event.currentTarget.setPointerCapture(event.pointerId);
    // Without this the drag selects text across the panes it passes over.
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = from.current;
    if (!start) return;
    // A drag is anchored to where it started, so this one ignores the previous
    // width — otherwise the pane would drift by the whole delta every frame.
    onResize(() => clamp(start.width + (event.clientX - start.x) * towards));
  };

  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!from.current) return;
    from.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    onResize((previous) => clamp(previous + step * KEY_STEP * towards));
  };

  return (
    <div
      className={`pane-resizer ${pane === 'after' ? 'is-after' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onResize(() => fallback)}
      onKeyDown={onKeyDown}
    />
  );
}
