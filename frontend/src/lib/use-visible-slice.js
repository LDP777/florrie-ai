import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Render the first N of a long list, and more as she reaches the end.
 *
 * Ellie has 868 clients and the page rendered all of them: 7,028 DOM nodes and
 * 883 buttons on a screen where she can see six. That cost is paid twice —
 * once when the page opens, and again on EVERY KEYSTROKE in the search box,
 * because filtering re-renders the whole list.
 *
 * WHY THIS AND NOT A VIRTUALISER. react-window and friends want a row height.
 * These rows do not have one: a client with two tags and a "booked in
 * Thursday" line is taller than a dormant one with neither, and the redesign
 * depends on that. Guessing a height gives you a scrollbar that lies and a
 * list that jumps while you drag it. Measuring every row costs more than it
 * saves at this size.
 *
 * So this does the boring thing instead: show a page of rows, and add another
 * page when the sentinel at the bottom comes into view. The cost of opening
 * the screen becomes fixed, the design is untouched, and there is no new
 * dependency in a repo whose lockfile has already been broken once this week.
 *
 * The trade is honest: scrolling to the very end still ends up with everything
 * mounted. That is the rare case, and it is the case where she has chosen to
 * look at all of them.
 *
 *   const { slice, sentinelRef, hasMore } = useVisibleSlice(filtered, 40);
 *   ...
 *   {slice.map(renderRow)}
 *   {hasMore && <div ref={sentinelRef} />}
 *
 * @param {Array} items the full, already-filtered and sorted list
 * @param {number} pageSize how many to add at a time
 */
export function useVisibleSlice(items, pageSize = 40) {
  const list = Array.isArray(items) ? items : [];
  const [count, setCount] = useState(pageSize);

  // Any change to what is being shown starts again from the top. Without this,
  // searching after a long scroll renders 400 rows of a 3-row result and the
  // sentinel never comes back into view.
  const signature = `${list.length}:${list[0]?.id ?? ''}:${list[list.length - 1]?.id ?? ''}`;
  useEffect(() => { setCount(pageSize); }, [signature, pageSize]);

  const hasMore = count < list.length;

  const observerRef = useRef(null);
  const sentinelRef = useCallback((node) => {
    if (observerRef.current) { observerRef.current.disconnect(); observerRef.current = null; }
    if (!node) return;
    // rootMargin, so the next page is mounted just BEFORE she reaches the end
    // rather than after — the difference between a list that grows and a list
    // that stutters.
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) setCount(c => c + pageSize);
    }, { rootMargin: '400px' });
    io.observe(node);
    observerRef.current = io;
  }, [pageSize]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return {
    slice: hasMore ? list.slice(0, count) : list,
    hasMore,
    shown: Math.min(count, list.length),
    total: list.length,
    sentinelRef,
    // An escape hatch for "show everything" — printing, or a select-all that
    // needs every row on screen.
    showAll: () => setCount(list.length),
  };
}
