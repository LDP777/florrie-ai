import { useRef, useState, useCallback, useEffect } from 'react';
import Icon from './Icon';
import { hapticTap } from '../../lib/native.js';

/**
 * DragList — drag to reorder, built for a thumb.
 *
 * Ellie's ask was "shuffle these about, I want it at the bottom". Up and down
 * arrows answer that in five taps; a drag answers it in one gesture, which is
 * the difference between a feature she uses and one she doesn't.
 *
 * Built on Pointer Events, because HTML5 drag-and-drop does not fire on iOS
 * touch at all. Three things this got wrong before they were tested, all of
 * which only show up when you actually drag something:
 *
 *  1. THE DOM ORDER NEVER CHANGES DURING A DRAG. Reordering the array mid-drag
 *     makes React move the captured node, and moving a node releases its
 *     pointer capture — which fired lostpointercapture and ended the drag after
 *     a single swap, however far the finger travelled. So rows are displaced
 *     with a transform and the array is only reordered on release.
 *  2. The target index is recomputed from a layout snapshot taken at pickup,
 *     not from the live DOM. Measuring against a layout that is itself moving
 *     accumulates error.
 *  3. `touchAction: 'none'` on the handle, or the webview claims the gesture as
 *     a scroll and the drag never starts.
 *
 * Only the handle starts a drag, so rows stay tappable and the page keeps
 * scrolling normally — nothing gets reordered by accident. Edge auto-scroll is
 * there because "move it to the bottom" often means dragging past the fold.
 *
 *   <DragList
 *     items={treatments}
 *     getKey={t => t.id}
 *     onReorder={next => persist(next)}
 *     renderItem={(t, { handleProps, isDragging }) => (
 *       <div><DragHandle handleProps={handleProps} label={`Reorder ${t.name}`} />{t.name}</div>
 *     )}
 *   />
 */
export default function DragList({
  items,
  getKey,
  onReorder,
  renderItem,
  disabled = false,
  gap = 0,
}) {
  const [order, setOrder] = useState(items);
  const [drag, setDrag] = useState(null); // { key, from, target, offset }

  const rowRefs = useRef(new Map());
  const state = useRef(null);
  const scroller = useRef(null);
  const raf = useRef(null);

  useEffect(() => { if (!state.current) setOrder(items); }, [items]);

  const findScroller = (el) => {
    let n = el?.parentElement;
    while (n) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') return n;
      n = n.parentElement;
    }
    return document.getElementById('app-scroll') || document.scrollingElement;
  };

  const stopAutoScroll = () => {
    if (raf.current) { cancelAnimationFrame(raf.current); raf.current = null; }
  };

  const applyMove = useCallback((clientY) => {
    const s = state.current;
    if (!s) return;

    const scrolled = (scroller.current?.scrollTop ?? 0) - s.startScroll;
    const dy = (clientY - s.startY) + scrolled;
    const centre = s.centres[s.from] + dy;

    // Nearest slot. A pure function of the pointer, so dragging back up walks
    // through exactly the same indexes in reverse.
    let target = 0;
    let best = Infinity;
    for (let i = 0; i < s.centres.length; i++) {
      const d = Math.abs(s.centres[i] - centre);
      if (d < best) { best = d; target = i; }
    }

    if (target !== s.target) { s.target = target; hapticTap?.(); }
    setDrag({ key: s.key, from: s.from, target, offset: dy });
  }, []);

  const onPointerMove = useCallback((e) => {
    const s = state.current;
    if (!s || e.pointerId !== s.pointerId) return;
    e.preventDefault();
    applyMove(e.clientY);

    const el = scroller.current;
    if (!el) return;
    const box = el === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight }
      : el.getBoundingClientRect();
    const EDGE = 80;
    const topGap = e.clientY - box.top;
    const bottomGap = box.bottom - e.clientY;
    let speed = 0;
    if (topGap < EDGE) speed = -Math.min(16, (EDGE - topGap) / 4);
    else if (bottomGap < EDGE) speed = Math.min(16, (EDGE - bottomGap) / 4);

    stopAutoScroll();
    if (speed !== 0) {
      const heldY = e.clientY;
      const step = () => {
        if (!state.current) return;
        const before = el.scrollTop;
        el.scrollTop += speed;
        if (el.scrollTop !== before) applyMove(heldY);
        raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    }
  }, [applyMove]);

  const endDrag = useCallback(() => {
    const s = state.current;
    if (!s) return;
    state.current = null;
    stopAutoScroll();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    setDrag(null);

    if (s.target !== s.from) {
      const next = [...s.base];
      const [moved] = next.splice(s.from, 1);
      next.splice(s.target, 0, moved);
      setOrder(next);
      onReorder?.(next);
    }
  }, [onPointerMove, onReorder]);

  const onPointerDown = useCallback((key) => (e) => {
    if (disabled || e.button > 0) return;
    const node = rowRefs.current.get(key);
    if (!node) return;
    e.preventDefault();
    scroller.current = findScroller(node);

    // Snapshot the layout once, at pickup.
    const heights = order.map(it => (rowRefs.current.get(getKey(it))?.offsetHeight ?? 0) + gap);
    const centres = [];
    let running = 0;
    for (const h of heights) { centres.push(running + h / 2); running += h; }
    const from = order.findIndex(it => getKey(it) === key);

    state.current = {
      key, pointerId: e.pointerId, startY: e.clientY,
      startScroll: scroller.current?.scrollTop ?? 0,
      centres, heights, from, target: from, base: order,
    };

    // Listen on the window rather than the handle. Pointer capture is not
    // needed and would only be one more thing that can be lost.
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    setDrag({ key, from, target: from, offset: 0 });
    hapticTap?.();
  }, [disabled, order, getKey, gap, onPointerMove, endDrag]);

  useEffect(() => () => {
    stopAutoScroll();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
  }, [onPointerMove, endDrag]);

  // How far a row shifts to open a gap where the dragged one will land.
  const displacement = (i) => {
    if (!drag) return 0;
    const s = state.current;
    if (!s || i === drag.from) return 0;
    const h = s.heights[drag.from];
    if (drag.target > drag.from && i > drag.from && i <= drag.target) return -h;
    if (drag.target < drag.from && i >= drag.target && i < drag.from) return h;
    return 0;
  };

  return (
    <div>
      {order.map((item, i) => {
        const key = getKey(item);
        const isDragging = drag?.key === key;
        const shift = isDragging ? drag.offset : displacement(i);
        return (
          <div
            key={key}
            ref={node => { if (node) rowRefs.current.set(key, node); else rowRefs.current.delete(key); }}
            style={{
              position: 'relative',
              zIndex: isDragging ? 2 : 1,
              transform: shift ? `translateY(${shift}px)` : undefined,
              transition: isDragging ? 'none' : 'transform 180ms cubic-bezier(.22,1,.36,1)',
              // Lifted, not tilted. A rotation reads as a toy.
              boxShadow: isDragging ? '0 12px 28px -8px rgba(92,40,46,.34)' : undefined,
              borderRadius: isDragging ? 16 : undefined,
              opacity: drag && !isDragging ? 0.75 : 1,
              touchAction: 'pan-y',
            }}
          >
            {renderItem(item, {
              isDragging,
              index: i,
              handleProps: {
                onPointerDown: onPointerDown(key),
                style: { touchAction: 'none', cursor: isDragging ? 'grabbing' : 'grab' },
              },
            })}
          </div>
        );
      })}
    </div>
  );
}

/** The standard grab handle: a 44px target, a quiet glyph. */
export function DragHandle({ handleProps, label }) {
  return (
    <button
      type="button"
      aria-label={label}
      {...handleProps}
      style={{
        width: 44, height: 44, flexShrink: 0,
        border: 'none', background: 'transparent',
        color: 'var(--text-muted)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'inherit',
        ...handleProps.style,
      }}
    >
      <Icon name="grip" size={18} />
    </button>
  );
}
