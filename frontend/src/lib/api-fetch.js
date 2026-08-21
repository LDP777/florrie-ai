/**
 * fetch, but a rate limit is not Ellie's problem to solve.
 *
 * WHAT THIS IS FOR. Lucy Walker asked to add a lash lift to her booking. Ellie
 * opened the appointment, tapped to add it, and got a modal: "Too many
 * requests, please try again later", with one OK button. She tried again, got
 * the same, and gave up — "So I just added 30mins block out instead." The app
 * could do exactly what she wanted. A counter said no, and the only thing the
 * screen offered her was the word "later".
 *
 * The limit itself was the real bug and is fixed in the backend. This is the
 * part that stops the next one being visible at all: a 429 is a "wait a
 * second", not a failure, so wait a second and go again rather than handing it
 * to whoever is holding the phone.
 *
 * WHAT IT WILL NOT DO. It retries a 429 and nothing else. A 500 might have
 * half-written something and a 409 is a real answer about a real clash, so
 * both go straight back to the caller. It never retries more than twice, and
 * never waits longer than SIX seconds in total, because a spinner that will
 * not end is its own kind of dead end.
 */

/** How long the server asked us to wait, in ms, clamped to something bearable. */
function retryDelayMs(res, attempt) {
  const header = Number(res.headers.get('Retry-After'));
  // Retry-After is in seconds and can legitimately be minutes. We are not
  // holding a button press open for minutes; if the wait is genuinely that
  // long, giving the caller the 429 to show is the honest move.
  if (Number.isFinite(header) && header > 0) return header <= 3 ? header * 1000 : null;
  // No header: back off gently rather than hammering the thing that just
  // asked us to slow down.
  return attempt === 0 ? 400 : 1200;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {RequestInit} [opts]
 * @returns {Promise<Response>} the first response that is not a 429, or the
 *   last 429 if it kept saying so.
 */
export async function apiFetch(url, opts = {}) {
  let res = await fetch(url, opts);
  for (let attempt = 0; attempt < 2 && res.status === 429; attempt++) {
    const wait = retryDelayMs(res, attempt);
    // Asked to wait longer than we are willing to: hand it back and let the
    // caller say so. The backend's 429 body explains that nothing was saved.
    if (wait === null) return res;
    await sleep(wait);
    res = await fetch(url, opts);
  }
  return res;
}

/**
 * What to put in front of her if it is STILL limited after the retries.
 *
 * The old text was "Too many requests, please try again later" — which is the
 * server's own words, is about the server, and gave her no way to judge
 * whether waiting would help. She read it as broken and worked around it.
 */
export const RATE_LIMIT_MESSAGE =
  'The app got ahead of itself. Nothing has been saved or changed — give it a few seconds and try that again.';

/**
 * Pull a message out of an API error body, preferring one that reads like a
 * person wrote it. Handles the 429 case so no call site has to.
 */
export function apiErrorMessage(res, body, fallback) {
  if (res?.status === 429) return RATE_LIMIT_MESSAGE;
  return body?.error || fallback;
}
