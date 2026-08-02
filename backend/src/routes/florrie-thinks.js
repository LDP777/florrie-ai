import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { getFreeSlots, nowInSalonWall } from '../lib/free-slots.js';
import { isSocialLead, clientsEverBooked, hasContactIdentity } from '../lib/inbox-space.js';
import { getGapFillSuggestions } from '../services/gap-fill-engine.js';
import { clientNeedsPatchTest } from './appointments.js';
import { rankCards, dropExpired } from '../lib/florrie-thinks-rank.js';

const router = Router();

/**
 * GET /api/florrie-thinks
 *
 * The rebuilt "Florrie thinks" feed. The old cards were served from stored
 * booking_suggestions rows that went stale ("a client wants Lash tint on Thu
 * 25 Jun", shown in August, bookable into a June date). These cards are
 * different in kind: nothing is stored, everything is derived fresh from the
 * live tables at fetch time, so a card can only exist while its moment does.
 *
 * The five rules every card obeys:
 *   1. It names a real person (first name or @handle) and tapping it opens
 *      them. A card that cannot name its person does not render. The one
 *      partial exception is the gap card, whose subject is the diary itself;
 *      it still names a matched client whenever the gap-fill engine has one.
 *   2. It carries expires_at and is dropped server side once that passes.
 *   3. Its primary action is completable right now, verified at build time
 *      (a gap card only renders if the window is free per getFreeSlots, a
 *      balance card only if the charge guards would accept the charge).
 *   4. It shows its evidence ("asked Tue 2:14pm") linking to the source.
 *   5. At most three cards, ranked money first then urgency.
 *
 * Every Supabase result is error checked (supabase does not throw); any
 * failing source silently contributes nothing, and the endpoint always
 * answers 200 with whatever it could ground. Nothing here sends messages or
 * moves money: every primary action is a navigation to the surface where
 * Ellie herself acts.
 */
router.get('/', requireAuth, async (req, res) => {
  const beautician = req.beautician;
  const beauticianId = beautician.id;
  const timezone = beautician.timezone || 'Europe/London';
  const wallNow = nowInSalonWall(timezone);

  // Rule 2 clean-up for the LEGACY table: pending booking_suggestions whose
  // date has passed are dismissed (never deleted) so no surface can ever
  // resurrect them. Best effort; a failure here must not block the feed.
  retirePastBookingSuggestions(beauticianId, wallNow).catch(() => {});

  const results = await Promise.allSettled([
    leadCard(beauticianId, timezone),
    moneyCard(beauticianId, wallNow),
    patchTestCard(beauticianId, wallNow),
    gapCard(beauticianId, beautician, wallNow),
    setPricesCard(beauticianId, wallNow),
    lapsedRegularCard(beauticianId, wallNow),
  ]);

  let cards = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) cards.push(...r.value);
  }

  // Quiet No: anything she dismissed in the last 30 days stays gone. The
  // dismissals live in florrie_decisions (the same table the old cards used)
  // keyed by the card id, which is stable per subject.
  cards = await withoutDismissed(beauticianId, cards);

  // Rule 2 at the gate: nothing past its own moment renders, in the right
  // time frame for each stamp.
  cards = dropExpired(cards, { nowUtcMs: Date.now(), nowWallMs: wallNow.getTime() });

  // Rule 5: money first, urgency second, three at most.
  cards = rankCards(cards);

  res.json({ cards, count: cards.length });
});

export default router;

// ============================================================
// Card builders. Each returns [] or [card]; never throws upward.
// ============================================================

/**
 * LEAD: the newest Instagram-space lead (a stranger by the two-space rule)
 * whose escalated draft is still waiting. The draft is Ellie's to approve, so
 * the copy says so: her autonomy is drafts-only and nothing sends itself.
 */
async function leadCard(beauticianId, timezone) {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('messages')
      .select('id, client_id, content, ai_intent, is_junk, created_at, clients(id, first_name, phone, email, whatsapp_id, instagram_username)')
      .eq('beautician_id', beauticianId)
      .eq('channel', 'instagram')
      .eq('escalated', true)
      .eq('resolved', false)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error || !data || !data.length) return [];

    // The Instagram space is strangers only: same rule as the inbox split.
    // Known clients' messages already live in the Clients space and its own
    // approval surfaces; duplicating them here would be nagging.
    const rows = data.filter(r => r.client_id && isSocialLead({ content: r.content, intent: r.ai_intent, isJunk: r.is_junk }));
    if (!rows.length) return [];

    const everBooked = await clientsEverBooked(beauticianId, rows.map(r => r.client_id));
    // Cannot tell stranger from regular: rather than mislabel a client as a
    // lead, this card sits the fetch out.
    if (everBooked === null) return [];

    for (const row of rows) {
      const c = row.clients;
      if (hasContactIdentity(c) || everBooked.has(row.client_id)) continue;
      const person = personLabel(c);
      // Rule 1: no real name or handle, no card. Try the next newest lead.
      if (!person) continue;

      const asked = intentPhrase(row.ai_intent);
      const when = agoLabel(row.created_at, timezone);
      const impact = await cheapestTreatmentPrice(beauticianId);
      const threadLink = `/inbox?client=${encodeURIComponent(row.client_id)}`;

      return [{
        id: `lead-${row.id}`,
        type: 'lead',
        icon: '\u{1F4AC}',
        person,
        summary: `${person} ${asked} ${when}. Reply ready for your OK.`,
        evidence: { label: `asked ${when}`, link_to: threadLink },
        action_label: 'Open thread',
        link_to: threadLink,
        impact_pence: impact,
        urgency: 90,
        // A week-old enquiry has gone cold; the card expires with it. Real
        // instant, so the UTC frame.
        expires_at: new Date(new Date(row.created_at).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        expires_frame: 'utc',
      }];
    }
    return [];
  } catch (err) {
    logger.warn({ err, beauticianId }, 'florrie-thinks: lead card failed');
    return [];
  }
}

/**
 * MONEY: a completed visit in the last 14 days whose remainder is unsettled
 * and whose client has a saved card. Mirrors the exact eligibility the charge
 * path enforces (chargeRemainingBalance): pay-in-full excluded, remainder of
 * at least 30p, and no payment / full_payment / payment_link transaction on
 * record. The card only ever OPENS the appointment sheet; money moves solely
 * from Ellie's tap on the sheet's existing charge button.
 */
async function moneyCard(beauticianId, wallNow) {
  try {
    const sinceWall = new Date(wallNow.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('appointments')
      .select('id, client_id, starts_at, price_cents, deposit_cents, deposit_paid, payment_type, stripe_payment_method_id, clients(id, first_name, archived_at, blocked_at, stripe_customer_id)')
      .eq('beautician_id', beauticianId)
      .eq('status', 'completed')
      .gte('starts_at', sinceWall)
      .lte('starts_at', wallNow.toISOString())
      .order('starts_at', { ascending: false })
      .limit(60);
    if (error || !data || !data.length) return [];

    const candidates = data.filter((a) => {
      const c = a.clients;
      if (!c || !c.first_name || c.archived_at || c.blocked_at) return false;
      // A pay-in-full booking owes nothing whatever its transaction rows say;
      // this is the same skip that stopped the one-tap double charge.
      if (a.payment_type === 'full') return false;
      if (remainderCents(a) < 30) return false;
      // "Card on file" as the charge path sees it: a payment method pinned to
      // the appointment, or a Stripe customer whose saved card it can list.
      return !!(a.stripe_payment_method_id || c.stripe_customer_id);
    });
    if (!candidates.length) return [];

    // The unsettled-remainder claim MUST be verified, not assumed: if the
    // transactions guard cannot be read we say nothing, exactly as the charge
    // path refuses to charge blind.
    const { data: paid, error: txErr } = await supabase
      .from('transactions')
      .select('appointment_id')
      .in('appointment_id', candidates.map(a => a.id))
      .in('type', ['payment', 'full_payment', 'payment_link']);
    if (txErr) return [];
    const settled = new Set((paid || []).map(t => t.appointment_id));

    const owed = candidates.filter(a => !settled.has(a.id));
    if (!owed.length) return [];

    // The biggest unsettled remainder is the one worth her tap first.
    owed.sort((a, b) => remainderCents(b) - remainderCents(a));
    const appt = owed[0];
    const cents = remainderCents(appt);
    const first = appt.clients.first_name.trim();
    const date = String(appt.starts_at).slice(0, 10);
    const dayLabel = pastDayLabel(date, wallNow);
    const sheetLink = `/calendar/week?date=${date}&appt=${appt.id}`;

    return [{
      id: `money-${appt.id}`,
      type: 'money',
      icon: '\u{1F4B7}',
      person: first,
      summary: `${first}'s ${pounds(cents)} balance from ${dayLabel} is uncollected. Card on file.`,
      evidence: { label: `completed ${dayLabel} at ${friendlyTime(String(appt.starts_at).slice(11, 16))}`, link_to: sheetLink },
      action_label: 'Open booking',
      link_to: sheetLink,
      impact_pence: cents,
      urgency: 70,
      // The 14 day collection window is the card's own lifetime, in the wall
      // frame because starts_at is a wall stamp.
      expires_at: new Date(new Date(`${String(appt.starts_at).slice(0, 19)}Z`).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      expires_frame: 'wall',
    }];
  } catch (err) {
    logger.warn({ err, beauticianId }, 'florrie-thinks: money card failed');
    return [];
  }
}

/**
 * PATCH TEST: the soonest upcoming booking whose client still owes a patch
 * test they have not booked, per the same clientNeedsPatchTest rule the
 * appointment sheet uses (which is where the Send patch test link button
 * lives, so the tap-through lands exactly where she fixes it).
 */
async function patchTestCard(beauticianId, wallNow) {
  try {
    const untilWall = new Date(wallNow.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('appointments')
      .select('id, client_id, starts_at, price_cents, clients(first_name, archived_at, blocked_at), treatments(name)')
      .eq('beautician_id', beauticianId)
      .gte('starts_at', wallNow.toISOString())
      .lte('starts_at', untilWall)
      .not('status', 'in', '(cancelled,cancelled_by_client,cancelled_by_beautician,no_show)')
      .not('client_id', 'is', null)
      .order('starts_at', { ascending: true })
      .limit(50);
    if (error || !data || !data.length) return [];

    // Soonest first, one lookup per distinct client, capped so a busy diary
    // cannot turn one card into a query storm.
    const seen = new Set();
    for (const appt of data) {
      const c = appt.clients;
      if (!c || !c.first_name || c.archived_at || c.blocked_at) continue;
      if (seen.has(appt.client_id)) continue;
      seen.add(appt.client_id);
      if (seen.size > 10) break;

      const needs = await clientNeedsPatchTest(beauticianId, appt.client_id);
      if (!needs) continue;

      const first = c.first_name.trim();
      const date = String(appt.starts_at).slice(0, 10);
      const dayLabel = futureDayLabel(date, wallNow);
      const sheetLink = `/calendar/week?date=${date}&appt=${appt.id}`;
      const daysAway = Math.round((new Date(`${date}T12:00:00Z`).getTime() - wallNow.getTime()) / (24 * 60 * 60 * 1000));

      return [{
        id: `patch-${appt.id}`,
        type: 'patch_test',
        icon: '\u{1FA79}',
        person: first,
        summary: `${first}'s ${bookingPhrase(dayLabel)} needs a patch test she has not booked.`,
        evidence: { label: `booked for ${dayLabel} at ${friendlyTime(String(appt.starts_at).slice(11, 16))}`, link_to: sheetLink },
        action_label: 'Open booking',
        link_to: sheetLink,
        // The whole booking is at risk if the test never happens, so the
        // booking's own price is the money at stake.
        impact_pence: appt.price_cents || 0,
        urgency: daysAway <= 3 ? 85 : 65,
        // Once the appointment starts the moment has passed. Wall frame.
        expires_at: `${String(appt.starts_at).slice(0, 19)}Z`,
        expires_frame: 'wall',
      }];
    }
    return [];
  } catch (err) {
    logger.warn({ err, beauticianId }, 'florrie-thinks: patch test card failed');
    return [];
  }
}

/**
 * GAP: a gap of 90 minutes or more today or tomorrow, verified free at render
 * time by the same getFreeSlots the reply guard trusts (working hours, her
 * blocks and the live diary all respected), so this card can never advertise
 * time that is not really open. When the gap-fill engine has a matched client
 * for that day the card names them; the tap opens the gap-fill surface where
 * offering the slot is Ellie's own move.
 */
async function gapCard(beauticianId, beautician, wallNow) {
  try {
    if (!beautician.working_hours) return [];
    // 15 minute grain with no lead time: consecutive free starts chain into
    // runs, and a run of n slots is exactly n * 15 free minutes.
    const slots = await getFreeSlots(beauticianId, {
      workingHours: beautician.working_hours,
      timezone: beautician.timezone || 'Europe/London',
      durationMinutes: 15,
      leadHours: 0,
      days: 2,
      maxSlots: 200,
    });
    if (!slots.length) return [];

    const runs = contiguousRuns(slots).filter(r => r.minutes >= 90);
    if (!runs.length) return [];

    // Prefer today's biggest gap, then tomorrow's: the sooner it goes unsold
    // the sooner the money is gone for good.
    const todayStr = wallNow.toISOString().slice(0, 10);
    runs.sort((a, b) => a.date.localeCompare(b.date) || b.minutes - a.minutes);
    const run = runs[0];

    // Name a real person when the engine has one: its matches are already
    // deduped against recent contacts and preferences, so the name is earned.
    let match = null;
    try {
      const groups = await getGapFillSuggestions(beauticianId);
      const group = (groups || []).find(g => g.gap?.date === run.date && overlaps(g.gap, run));
      match = group?.matches?.[0]?.client?.first_name?.trim() || null;
    } catch { /* the gap is real either way; the name is a bonus */ }

    const dayWord = run.date === todayStr ? 'Today' : 'Tomorrow';
    const duration = durationPhrase(run.minutes);
    const base = `${dayWord} has a ${duration} gap from ${friendlyTime(run.start)}.`;
    const summary = match ? `${base} ${match} is due a visit and would fit.` : base;
    const dayLink = `/calendar/week?date=${run.date}&view=day`;

    return [{
      id: `gap-${run.date}-${run.start}`,
      type: 'gap',
      icon: '\u{1F337}',
      person: match,
      summary,
      evidence: { label: `free ${friendlyTime(run.start)} to ${friendlyTime(run.end)}, checked just now`, link_to: dayLink },
      action_label: 'Open gap fill',
      // The smart-schedule surface is where offering the slot actually
      // happens (drafts held for her OK); the diary day is one tap further.
      link_to: '/smart-schedule',
      impact_pence: await averageCompletedPrice(beauticianId),
      urgency: run.date === todayStr ? 80 : 60,
      // The card dies when the gap itself ends. It cannot go stale before
      // then: the window is recomputed fresh every fetch, and getFreeSlots
      // never returns time that has already passed. Wall frame.
      expires_at: `${run.date}T${run.end}:00Z`,
      expires_frame: 'wall',
    }];
  } catch (err) {
    logger.warn({ err, beauticianId }, 'florrie-thinks: gap card failed');
    return [];
  }
}

/**
 * SET PRICES, grounded: one NAMED upcoming booking with no price, opening
 * that appointment. The old anonymous "n bookings have no price" batch card
 * is gone; naming the person is what makes the tap obvious.
 */
async function setPricesCard(beauticianId, wallNow) {
  try {
    const untilWall = new Date(wallNow.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('appointments')
      .select('id, starts_at, price_cents, clients(first_name, archived_at, blocked_at), treatments(name, price_cents)')
      .eq('beautician_id', beauticianId)
      .gte('starts_at', wallNow.toISOString())
      .lte('starts_at', untilWall)
      .not('status', 'in', '(cancelled,cancelled_by_client,cancelled_by_beautician,no_show)')
      .order('starts_at', { ascending: true })
      .limit(60);
    if (error || !data || !data.length) return [];

    const appt = data.find(a =>
      (!a.price_cents || a.price_cents === 0)
      && a.clients?.first_name && !a.clients.archived_at && !a.clients.blocked_at
    );
    if (!appt) return [];

    const first = appt.clients.first_name.trim();
    const date = String(appt.starts_at).slice(0, 10);
    const dayLabel = futureDayLabel(date, wallNow);
    const sheetLink = `/calendar/week?date=${date}&appt=${appt.id}`;

    return [{
      id: `price-${appt.id}`,
      type: 'set_price',
      icon: '\u{1F3F7}️',
      person: first,
      summary: `${first}'s ${bookingPhrase(dayLabel)} has no price set.`,
      evidence: { label: `booked for ${dayLabel} at ${friendlyTime(String(appt.starts_at).slice(11, 16))}`, link_to: sheetLink },
      action_label: 'Open booking',
      link_to: sheetLink,
      // Best estimate of the untracked money: the treatment's own list price.
      impact_pence: appt.treatments?.price_cents || 0,
      urgency: 50,
      expires_at: `${String(appt.starts_at).slice(0, 19)}Z`,
      expires_frame: 'wall',
    }];
  } catch (err) {
    logger.warn({ err, beauticianId }, 'florrie-thinks: set prices card failed');
    return [];
  }
}

/**
 * LAPSED REGULAR: the same drift rule as the agents page churn count (2 or
 * more completed visits, now more than twice their usual gap overdue, nothing
 * booked), but returning the one named client most worth reaching for, valued
 * at their own average spend. The tap opens their profile; any message is
 * Ellie's to send from there.
 */
async function lapsedRegularCard(beauticianId, wallNow) {
  try {
    const { data: appts, error } = await supabase
      .from('appointments')
      .select('client_id, starts_at, status')
      .eq('beautician_id', beauticianId)
      .not('client_id', 'is', null)
      .order('starts_at', { ascending: true })
      .limit(5000);
    if (error || !appts || !appts.length) return [];

    // Everything in the wall frame: starts_at is a wall stamp, so "now" must
    // be the wall clock too or every gap is an hour out in BST.
    const nowMs = wallNow.getTime();
    const byClient = new Map();
    for (const a of appts) {
      let c = byClient.get(a.client_id);
      if (!c) { c = { past: [], hasUpcoming: false }; byClient.set(a.client_id, c); }
      const t = new Date(`${String(a.starts_at).slice(0, 19)}Z`).getTime();
      if (Number.isNaN(t)) continue;
      if (t > nowMs) {
        if (!['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show'].includes(a.status)) c.hasUpcoming = true;
      } else if (a.status === 'completed') {
        c.past.push(t);
      }
    }

    const week = 7 * 24 * 60 * 60 * 1000;
    const drifting = [];
    for (const [clientId, c] of byClient.entries()) {
      if (c.hasUpcoming || c.past.length < 2) continue;
      const gaps = [];
      for (let i = 1; i < c.past.length; i++) gaps.push(c.past[i] - c.past[i - 1]);
      const avgGap = gaps.reduce((x, y) => x + y, 0) / gaps.length;
      if (!avgGap) continue;
      const last = c.past[c.past.length - 1];
      if (nowMs - last > avgGap * 2) {
        drifting.push({ clientId, last, avgGap, overdueMs: nowMs - last - avgGap });
      }
    }
    if (!drifting.length) return [];

    const { data: clients, error: cErr } = await supabase
      .from('clients')
      .select('id, first_name, archived_at, blocked_at, total_spend_cents, total_visits')
      .eq('beautician_id', beauticianId)
      .in('id', drifting.slice(0, 50).map(d => d.clientId));
    if (cErr || !clients || !clients.length) return [];

    const byId = new Map(clients.map(c => [c.id, c]));
    const named = drifting
      .map((d) => {
        const c = byId.get(d.clientId);
        if (!c || !c.first_name || c.archived_at || c.blocked_at) return null;
        const visits = c.total_visits || 0;
        const avgSpend = (visits > 0 && c.total_spend_cents) ? Math.round(c.total_spend_cents / visits) : 3500;
        return { ...d, first: c.first_name.trim(), avgSpend };
      })
      .filter(Boolean)
      // Their own average spend is the money at stake, so the most valuable
      // drifting regular is the one Florrie mentions.
      .sort((a, b) => b.avgSpend - a.avgSpend);
    if (!named.length) return [];

    const top = named[0];
    const weeksPast = Math.max(1, Math.round(top.overdueMs / week));
    const lastDate = new Date(top.last).toISOString().slice(0, 10);

    return [{
      id: `lapsed-${top.clientId}`,
      type: 'lapsed_regular',
      icon: '\u{1F495}',
      person: top.first,
      summary: `${top.first} is ${weeksPast} week${weeksPast === 1 ? '' : 's'} past her usual visit.`,
      evidence: { label: `last in ${shortDate(lastDate)}`, link_to: '/clients', link_state: { clientId: top.clientId } },
      action_label: 'Open profile',
      link_to: '/clients',
      link_state: { clientId: top.clientId },
      impact_pence: top.avgSpend,
      urgency: 40,
      // Recomputed fresh every fetch; a week is just the stamp rule 2 demands.
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      expires_frame: 'utc',
    }];
  } catch (err) {
    logger.warn({ err, beauticianId }, 'florrie-thinks: lapsed regular card failed');
    return [];
  }
}

// ============================================================
// Dismissals + legacy clean-up
// ============================================================

/**
 * Filter out cards she has said No to in the last 30 days. Dismissals are
 * recorded through the existing POST /api/suggestions/respond into
 * florrie_decisions with suggestion_payload.key = the card id, so the same
 * table keeps serving as the memory of her choices. A failed read shows the
 * cards rather than hiding them: a repeated card is annoying, silently losing
 * the feed is worse.
 */
async function withoutDismissed(beauticianId, cards) {
  if (!cards.length) return cards;
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('florrie_decisions')
      .select('suggestion_payload, response')
      .eq('beautician_id', beauticianId)
      .gte('created_at', since);
    if (error || !data) return cards;
    const dismissed = new Set(
      data
        .filter(d => d.response === 'no' || d.response === 'dismissed')
        .map(d => d.suggestion_payload?.key)
        .filter(Boolean)
    );
    if (!dismissed.size) return cards;
    return cards.filter(c => !dismissed.has(c.id));
  } catch {
    return cards;
  }
}

/**
 * Legacy purge, rule 2 applied to the old stored cards: any pending
 * booking_suggestions row whose suggested date has passed is marked dismissed
 * (status only, never deleted) so no surface can offer to book a June date in
 * August ever again.
 */
async function retirePastBookingSuggestions(beauticianId, wallNow) {
  const today = wallNow.toISOString().slice(0, 10);
  const { error } = await supabase
    .from('booking_suggestions')
    .update({ status: 'dismissed', reviewed_at: new Date().toISOString() })
    .eq('beautician_id', beauticianId)
    .eq('status', 'pending')
    .lt('suggested_date', today);
  if (error) {
    logger.warn({ err: error, beauticianId }, 'florrie-thinks: could not retire past booking_suggestions');
  }
}

// ============================================================
// Small helpers
// ============================================================

function remainderCents(appt) {
  const depositPaid = appt.deposit_paid ? (appt.deposit_cents || 0) : 0;
  return Math.max(0, (appt.price_cents || 0) - depositPaid);
}

/** "@handle" if we have one, else a real first name, else null (no card). */
function personLabel(client) {
  const handle = client?.instagram_username && String(client.instagram_username).trim();
  if (handle) return `@${handle.replace(/^@/, '')}`;
  const first = client?.first_name && String(client.first_name).trim();
  // The webhook's placeholder name is not a person; a card may not lean on it.
  if (first && first !== 'Instagram User') return first;
  return null;
}

function intentPhrase(intent) {
  if (intent === 'price_enquiry') return 'asked about prices';
  if (intent === 'booking_request') return 'asked to book';
  if (intent === 'availability_check') return 'asked about availability';
  return 'asked a question';
}

/** "2h ago" for fresh things, then the day and salon-clock time. */
function agoLabel(createdAt, timezone) {
  const ms = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  // created_at is a real instant, so Intl conversion is correct here (unlike
  // appointment wall stamps, which must never go through Intl).
  const d = new Date(createdAt);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: timezone });
  const time = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone }).replace(/ /g, '');
  return `${day} ${time}`;
}

function pounds(pence) {
  const p = pence / 100;
  return Number.isInteger(p) ? `£${p}` : `£${p.toFixed(2)}`;
}

/** 24h "HH:MM" wall time to a warm "1pm" / "1:30pm". */
function friendlyTime(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return hhmm || '';
  const [hStr, mStr] = hhmm.split(':');
  let h = Number(hStr);
  const m = Number(mStr) || 0;
  if (!Number.isFinite(h)) return hhmm;
  const suffix = h < 12 ? 'am' : 'pm';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

function durationPhrase(minutes) {
  if (minutes < 60) return `${minutes} minute`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h} hour`;
  if (m === 30) return `${h} and a half hour`;
  return `${h} hour ${m} minute`;
}

/** Weekday word for a wall date: "today", "tomorrow", else "Thursday". */
function futureDayLabel(dateStr, wallNow) {
  const today = wallNow.toISOString().slice(0, 10);
  if (dateStr === today) return 'today';
  const tomorrow = new Date(wallNow.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (dateStr === tomorrow) return 'tomorrow';
  return weekdayName(dateStr);
}

/** "today", "yesterday", "Tuesday", or "Tue 22 Jul" once it is over a week. */
function pastDayLabel(dateStr, wallNow) {
  const today = wallNow.toISOString().slice(0, 10);
  if (dateStr === today) return 'today';
  const yesterday = new Date(wallNow.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (dateStr === yesterday) return 'yesterday';
  const days = Math.round((wallNow.getTime() - new Date(`${dateStr}T12:00:00Z`).getTime()) / (24 * 60 * 60 * 1000));
  return days <= 7 ? weekdayName(dateStr) : shortDate(dateStr);
}

/** "Emily's Thursday booking" reads well; "Emily's today booking" does not. */
function bookingPhrase(dayLabel) {
  return (dayLabel === 'today' || dayLabel === 'tomorrow') ? `booking ${dayLabel}` : `${dayLabel} booking`;
}

function weekdayName(dateStr) {
  // Noon UTC on the wall date; timeZone UTC keeps the wall date's own weekday.
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}

function shortDate(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * Chain consecutive 15 minute free starts into runs per day. Slots arrive
 * sorted; a run of n slots covers exactly n * 15 minutes ending a quarter
 * hour after the last start.
 */
function contiguousRuns(slots) {
  const runs = [];
  let cur = null;
  for (const s of slots) {
    const startMs = new Date(s.iso).getTime();
    if (cur && s.date === cur.date && startMs === cur.nextMs) {
      cur.minutes += 15;
      cur.nextMs = startMs + 15 * 60 * 1000;
    } else {
      if (cur) runs.push(finishRun(cur));
      cur = { date: s.date, start: s.time, minutes: 15, startMs, nextMs: startMs + 15 * 60 * 1000 };
    }
  }
  if (cur) runs.push(finishRun(cur));
  return runs;
}

function finishRun(run) {
  const end = new Date(run.startMs + run.minutes * 60 * 1000).toISOString().slice(11, 16);
  return { date: run.date, start: run.start, end, minutes: run.minutes };
}

function overlaps(gap, run) {
  const toMins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  return toMins(gap.start) < toMins(run.end) && toMins(run.start) < toMins(gap.end);
}

async function cheapestTreatmentPrice(beauticianId) {
  try {
    const { data, error } = await supabase
      .from('treatments')
      .select('price_cents')
      .eq('beautician_id', beauticianId)
      .eq('is_active', true)
      .gt('price_cents', 0)
      .order('price_cents', { ascending: true })
      .limit(1);
    if (error || !data || !data.length) return 0;
    return data[0].price_cents || 0;
  } catch {
    return 0;
  }
}

async function averageCompletedPrice(beauticianId) {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('price_cents')
      .eq('beautician_id', beauticianId)
      .eq('status', 'completed')
      .gt('price_cents', 0)
      .order('starts_at', { ascending: false })
      .limit(30);
    if (error || !data || !data.length) return 3500;
    return Math.round(data.reduce((s, a) => s + (a.price_cents || 0), 0) / data.length);
  } catch {
    return 3500;
  }
}
