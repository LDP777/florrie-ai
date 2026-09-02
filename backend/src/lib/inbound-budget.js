/**
 * How many model calls one client, and one salon, may cause in an hour.
 *
 * Every inbound message that reaches processInboundMessage costs at least one
 * model call (classifyIntent) and usually two (the draft). Until 2 September
 * 2026 the only thing limiting that was the IP-keyed webhook rate limiter in
 * index.js, and Meta delivers every salon's webhooks from the same handful of
 * IPs: a limiter keyed on them cannot tell one salon from another, let alone
 * one client from another, and is tuned loosely enough not to drop real
 * traffic. So a single sender who kept texting a salon's number, or a script
 * that had found the WhatsApp number of one, could run the bill up two model
 * calls at a time with nothing in the way.
 *
 * This is a sliding one hour window per client and per salon, held in memory.
 * In memory is a deliberate choice: the API is single-replica today (see the
 * webhookHits ring buffer in routes/webhooks.js for the same reasoning), and
 * a budget that needs a database round trip to enforce would cost on every
 * message what it is trying to save on the bad ones. If the process restarts
 * the counts start again, which errs on the side of answering the client.
 *
 * A real client sending twenty messages in an hour is rare and, when it
 * happens, is a conversation Ellie should be in anyway. The caller escalates
 * the message when this says no, so she still sees it.
 */

const WINDOW_MS = 60 * 60 * 1000;
export const CLIENT_LIMIT_PER_HOUR = 20;
export const BEAUTICIAN_LIMIT_PER_HOUR = 300;

// Both Maps hold `key -> number[]` of message timestamps inside the window.
// `${beauticianId}:${clientId}` for clients, `${beauticianId}` for salons.
const clientWindows = new Map();
const beauticianWindows = new Map();

// Every call prunes the two keys it touches; every PRUNE_EVERY calls it sweeps
// the whole thing. Several module-scope caches in this codebase grow for the
// life of the process, which is a known problem, and a Map keyed on client
// ids, with a new key for every stranger who ever sends one message, is the
// exact shape that grows fastest. A key with no timestamps left in the window
// is deleted, not emptied.
const PRUNE_EVERY = 200;
let callsSincePrune = 0;

function pruneList(list, cutoff) {
  let drop = 0;
  while (drop < list.length && list[drop] <= cutoff) drop += 1;
  if (drop) list.splice(0, drop);
  return list;
}

function sweep(map, cutoff) {
  for (const [key, list] of map) {
    if (pruneList(list, cutoff).length === 0) map.delete(key);
  }
}

function countIn(map, key, now) {
  const cutoff = now - WINDOW_MS;
  const list = map.get(key);
  if (!list) return 0;
  if (pruneList(list, cutoff).length === 0) {
    map.delete(key);
    return 0;
  }
  return list.length;
}

function record(map, key, now) {
  const list = map.get(key);
  if (list) list.push(now);
  else map.set(key, [now]);
}

/**
 * May this message be processed, and if so, count it.
 *
 * Returns { allowed, count, limit, reason }. `count` is the number of messages
 * already in the window for whichever limit was hit (or, when allowed, for the
 * client), and `reason` is 'client_limit' or 'beautician_limit' when blocked.
 * A message that is refused is NOT counted, so a client who is over budget is
 * allowed again the moment the oldest message in her window ages out, rather
 * than being pushed further into the future every time she tries.
 *
 * `now` is a millisecond timestamp and defaults to the clock; tests fix it.
 */
export function inboundBudget({ beauticianId, clientId, now = Date.now() }) {
  const salonKey = String(beauticianId ?? 'unknown');
  // A message with no client row (the webhook could not create one) still
  // counts against the salon, and is bucketed together under 'anonymous' so a
  // flood of unattributable messages does not become a flood of keys.
  const clientKey = `${salonKey}:${clientId ?? 'anonymous'}`;

  callsSincePrune += 1;
  if (callsSincePrune >= PRUNE_EVERY) {
    callsSincePrune = 0;
    const cutoff = now - WINDOW_MS;
    sweep(clientWindows, cutoff);
    sweep(beauticianWindows, cutoff);
  }

  const salonCount = countIn(beauticianWindows, salonKey, now);
  if (salonCount >= BEAUTICIAN_LIMIT_PER_HOUR) {
    return { allowed: false, count: salonCount, limit: BEAUTICIAN_LIMIT_PER_HOUR, reason: 'beautician_limit' };
  }

  const clientCount = countIn(clientWindows, clientKey, now);
  if (clientCount >= CLIENT_LIMIT_PER_HOUR) {
    return { allowed: false, count: clientCount, limit: CLIENT_LIMIT_PER_HOUR, reason: 'client_limit' };
  }

  record(beauticianWindows, salonKey, now);
  record(clientWindows, clientKey, now);
  return { allowed: true, count: clientCount + 1, limit: CLIENT_LIMIT_PER_HOUR, reason: null };
}

/** Tests only. */
export function __resetInboundBudget() {
  clientWindows.clear();
  beauticianWindows.clear();
  callsSincePrune = 0;
}

/** Tests only: how many keys are being held, so eviction can be asserted. */
export function __inboundBudgetSize() {
  return { clients: clientWindows.size, beauticians: beauticianWindows.size };
}
