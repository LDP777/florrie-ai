import { useEffect, useRef, useState } from 'react';

/**
 * useCountUp — animate a number up to `target` on load (the Monzo "money
 * counts up when you open the app" feel). Returns the current animated value;
 * the caller formats it however it likes.
 *
 * Starts from 0 so the first real value rolls up. Skips the animation when the
 * user prefers reduced motion. Cleans up its frame on unmount/re-target.
 */
export function useCountUp(target, { duration = 750 } = {}) {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef(null);

  useEffect(() => {
    const to = Number(target) || 0;
    const from = fromRef.current;
    if (to === from) { setValue(to); return; }

    const reduce = typeof window !== 'undefined'
      && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof requestAnimationFrame === 'undefined') {
      fromRef.current = to;
      setValue(to);
      return;
    }

    const start = performance.now();
    const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
    const tick = now => {
      const p = Math.min(1, (now - start) / duration);
      setValue(from + (to - from) * easeOutCubic(p));
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, duration]);

  return value;
}

export default useCountUp;
