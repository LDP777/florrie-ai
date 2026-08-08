/**
 * Run something once the app is on screen, and not a moment before.
 *
 * Used to defer PostHog (230 KB) and Sentry (110 KB), which together were 40%
 * of everything the browser had to fetch before Ellie could see anything —
 * measured on a throttled 4G phone with scripts/check-boot.mjs, not guessed.
 *
 * Two earlier versions of this were wrong, and both looked fine:
 *
 *  1. requestIdleCallback with a timeout. iOS Safari does not implement it at
 *     all, and iOS is the only platform Ellie uses, so the "fallback" was in
 *     fact the primary path. Worse, the app hard-reloads to /login during boot
 *     and a callback scheduled before that reload is discarded — in testing
 *     PostHog landed and Sentry did not, on the same page load, purely because
 *     their timeouts sat either side of the redirect.
 *
 *  2. Waiting for the `load` event. `load` waits for every image and font, and
 *     this app pulls two typefaces from Google Fonts. If those stall, `load`
 *     never fires and nothing is ever sent. That is not hypothetical: it is
 *     what happened on the first verified run, where both chunks silently
 *     never arrived. The failure is invisible — no error, just no data.
 *
 * Two animation frames is what "after paint" actually means: the callback of a
 * nested rAF cannot run until the first frame has been painted. It owes nothing
 * to the network, so a dead font server delays analytics by zero milliseconds.
 */
export function afterPaint(fn, settleMs = 600) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    // A timeout, not a direct call: the settle gives the app's own first data
    // fetches a clear run at the network before analytics competes for it.
    setTimeout(fn, settleMs);
  };

  if (typeof requestAnimationFrame !== 'function') { setTimeout(run, 1000); return; }

  requestAnimationFrame(() => requestAnimationFrame(run));

  // Backstop for a tab that is hidden at load: rAF does not fire in a
  // background tab, and iOS restores backgrounded tabs constantly.
  setTimeout(run, 3000);
}
