import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { nextBankHoliday, postcodeToDivision } from '../lib/bank-holidays.js';
import { getFutureBookedClientIds } from '../lib/future-bookings.js';
import { guardedSend } from '../lib/outbound-guard.js';
import { sendSMS, sendOnPreferredChannel, notifyBookingConfirmed } from '../services/notifications.js';
import { getGapFillSuggestions, gapFillDiagnostic } from '../services/gap-fill-engine.js';
import { quietWeekStatus } from '../services/florrie-heartbeat.js';

const router = Router();

/**
 * Florrie thinks: the proactive intelligence feed on the Today page.
 *
 * GET  /api/suggestions                     -> one prioritised, deduped stream
 * POST /api/suggestions/respond             -> record yes / no / tweak / dismiss
 * POST /api/suggestions/book                -> actually create the appointment
 * POST /api/suggestions/send-offer          -> send rebook offer (guarded, channel-faithful)
 * POST /api/suggestions/fill-gap            -> offer a near-term gap to its matched clients (guarded)
 * POST /api/suggestions/block-day           -> block a bank-holiday date
 * GET  /api/suggestions/unpriced            -> upcoming appointments with no price
 * PATCH /api/suggestions/appointments/:id/price -> set price on one appointment
 *
 * Every card now carries:
 *   - impact_pence: best estimate of the pounds at stake (integer, 0 if unknown)
 *   - priority:     a blend of impact and urgency; the feed is sorted by it desc
 *   - action:       { kind, endpoint, method, body, confirm } so the primary
 *                   button EXECUTES in-app rather than just navigating away
 *
 * The feed drops the weakest card type (tag_dormant, pure busywork) and learns:
 * any card type the beautician has said no/dismiss to 2+ times in the last 30
 * days is suppressed.
 */

const MAX_SUGGESTIONS = 5;

// How a 'no'/'dismiss' habit silences a whole card type.
const LEARN_WINDOW_DAYS = 30;
const LEARN_NO_THRESHOLD = 2;

router.get('/', requireAuth, async (req, res) => {
  const beauticianId = req.beautician.id;
  let suggestions = [];

  try {
    // Gather every source. We over-collect and let priority sorting + the cap
    // decide what surfaces, rather than letting source order alone win.
    const groups = await Promise.all([
      fromUpcomingBankHoliday(beauticianId),
      fromBookingSuggestions(beauticianId),
      fromRebookReminders(beauticianId),
      fromValueCoaching(beauticianId),
      fromGapFill(beauticianId),
      fromUnpricedAppointments(beauticianId),
      fromFiveStarReviews(beauticianId),
      fromQuietWeek(beauticianId, req.query),
      // tag_dormant deliberately dropped: it was busywork, not money.
    ]);
    for (const g of groups) suggestions.push(...g);
  } catch (err) {
    logger.error({ err }, 'Suggestion source failed, falling back to synthetic');
  }

  // Learning + per-target dedup against recent answers.
  suggestions = await applyLearning(beauticianId, suggestions);

  // One prioritised stream: impact + urgency, highest first.
  suggestions.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  // If we still have nothing, surface the fresh-tenant defaults so the row
  // doesn't render empty.
  const out = suggestions.length > 0 ? suggestions : syntheticDefaults(req.beautician);

  res.json({ suggestions: out.slice(0, MAX_SUGGESTIONS), count: out.length });
});

router.get('/_gapdebug', requireAuth, async (req, res) => {
  res.json(await gapFillDiagnostic(req.beautician.id));
});

router.post('/respond', requireAuth, async (req, res) => {
  const beauticianId = req.beautician.id;
  const { suggestion_id, suggestion_type, suggestion_payload, response, tweak } = req.body || {};

  if (!response || !['yes', 'no', 'tweak', 'dismissed'].includes(response)) {
    return res.status(400).json({ error: 'Invalid response value' });
  }
  if (!suggestion_type) {
    return res.status(400).json({ error: 'Missing suggestion_type' });
  }

  // The execute endpoints (book / send-offer / block-day / price) now do the real
  // work. /respond just records the choice so learning + dedup stay accurate. We
  // mark acted_on when the card was actually carried out (the UI passes acted: true
  // after a successful execute), so a plain 'yes' with no side effect still logs.
  const actedOn = response === 'yes' && req.body.acted === true;

  const { data, error } = await supabase
    .from('florrie_decisions')
    .insert({
      beautician_id: beauticianId,
      suggestion_type,
      suggestion_payload: suggestion_payload || {},
      response,
      tweak_payload: response === 'tweak' ? (tweak || null) : null,
      acted_on: actedOn,
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to record florrie_decision');
    // Don't fail the request, the user already tapped, we don't want to crash the UI.
  }

  res.json({ ok: true, decision_id: data?.id || null, acted_on: actedOn });
});

// ============================================================
// Execute endpoints. These DO the thing, reusing existing logic.
// ============================================================

/**
 * POST /api/suggestions/book
 * Actually create the appointment from a pending booking_suggestion, then mark
 * the suggestion approved. Reuses the same guards as POST /api/appointments:
 * the no-double-book unique index (23505) and the no-overlap exclusion (23P01)
 * both surface as a 409 "that time is taken".
 *
 * booking_suggestions store a treatment NAME (not an id) and a wall-clock
 * date+time, so we resolve the treatment by name and store times wall-clock,
 * exactly like POST /api/appointments/manual.
 */
router.post('/book', requireAuth, async (req, res) => {
  const beauticianId = req.beautician.id;
  const id = req.body?.booking_suggestion_id;
  if (!id) return res.status(400).json({ error: 'Missing booking_suggestion_id' });

  const { data: sug } = await supabase
    .from('booking_suggestions')
    .select('id, client_id, treatment_name, suggested_date, suggested_time, status')
    .eq('id', id)
    .eq('beautician_id', beauticianId)
    .maybeSingle();

  if (!sug) return res.status(404).json({ error: 'Suggestion not found' });
  if (sug.status === 'approved') return res.status(409).json({ error: 'Already booked.' });
  if (!sug.client_id) return res.status(400).json({ error: 'No client on this suggestion. Open it to add one.' });
  if (!sug.suggested_date || !sug.suggested_time) {
    return res.status(400).json({ error: 'This suggestion has no date or time. Open it to pick one.' });
  }

  // Resolve treatment by name (case-insensitive). Fall back to any active
  // treatment match so a slightly different spelling still books.
  const { data: treatments } = await supabase
    .from('treatments')
    .select('id, name, duration_minutes, buffer_minutes, price_cents, deposit_cents')
    .eq('beautician_id', beauticianId);

  const wanted = String(sug.treatment_name || '').trim().toLowerCase();
  const treatment = (treatments || []).find(t => (t.name || '').trim().toLowerCase() === wanted)
    || (treatments || []).find(t => (t.name || '').trim().toLowerCase().includes(wanted) && wanted.length > 2);

  if (!treatment) {
    return res.status(400).json({ error: `Could not match "${sug.treatment_name}" to one of your treatments. Open it to pick the treatment.` });
  }

  // Wall-clock strings, matching POST /api/appointments/manual exactly. Times are
  // stored as-is (no trailing Z) and never timezone-converted.
  const date = String(sug.suggested_date).slice(0, 10);
  const time = String(sug.suggested_time).slice(0, 5);
  const startsAt = `${date}T${time}:00`;
  const totalMinutes = (treatment.duration_minutes || 0) + (treatment.buffer_minutes || 0);
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const endDate = new Date(Date.UTC(y, mo - 1, d, hh, mm + totalMinutes));
  const pad = (n) => String(n).padStart(2, '0');
  const endsAt = `${endDate.getUTCFullYear()}-${pad(endDate.getUTCMonth() + 1)}-${pad(endDate.getUTCDate())}T${pad(endDate.getUTCHours())}:${pad(endDate.getUTCMinutes())}:00`;

  const { data: appointment, error } = await supabase
    .from('appointments')
    .insert({
      beautician_id: beauticianId,
      client_id: sug.client_id,
      treatment_id: treatment.id,
      starts_at: startsAt,
      ends_at: endsAt,
      duration_minutes: treatment.duration_minutes,
      buffer_minutes: treatment.buffer_minutes || 0,
      price_cents: treatment.price_cents,
      deposit_cents: treatment.deposit_cents || 0,
      status: 'confirmed',
      booked_via: 'florrie_thinks',
    })
    .select('id, starts_at')
    .single();

  if (error) {
    // 23505 = no-double-book unique guard (same start); 23P01 = no-overlap
    // exclusion guard. Either means the slot is taken.
    if (error.code === '23505' || error.code === '23P01') {
      return res.status(409).json({ error: 'That time is already booked.' });
    }
    logger.error({ err: error }, 'Florrie-thinks book failed');
    return res.status(500).json({ error: 'Could not book that in.' });
  }

  await supabase
    .from('booking_suggestions')
    .update({ status: 'approved', reviewed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('beautician_id', beauticianId);

  // Approving a Florrie-thinks card puts a real booking in the diary. Until
  // now it told the client nothing — so the one place in the app where the
  // machine books somebody in was also the quietest. Fire-and-forget here,
  // deliberately: the card's job is to disappear the instant she taps it, and
  // this suggestion always concerns a future slot with a known client.
  notifyBookingConfirmed(appointment.id).catch((err) =>
    logger.warn({ err, appointmentId: appointment.id }, 'Florrie-thinks booking confirmation failed')
  );

  return res.status(201).json({ ok: true, appointment_id: appointment.id });
});

/**
 * POST /api/suggestions/send-offer
 * Send a rebook offer to the client through the single outbound gate, on the
 * channel they actually use (Instagram regular gets it on Instagram, not a stray
 * text). guardedSend returns 'send' (delivered now) or 'approve' (held in the
 * owner's outbox for known clients / awaiting trust) or 'block'. We report which,
 * so the UI can say "Offer sent" vs "Held for your OK".
 */
router.post('/send-offer', requireAuth, async (req, res) => {
  const beautician = req.beautician;
  const beauticianId = beautician.id;
  const clientId = req.body?.client_id;
  if (!clientId) return res.status(400).json({ error: 'Missing client_id' });

  const { data: client } = await supabase
    .from('clients')
    .select('id, first_name, phone, whatsapp_id, instagram_id, preferred_channel, marketing_consent, marketing_opted_out_at, status')
    .eq('id', clientId)
    .eq('beautician_id', beauticianId)
    .maybeSingle();
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Make sure there is at least one channel we can actually reach them on, so we
  // never hold an offer we could never deliver.
  if (!reachable(client, beautician)) {
    return res.status(400).json({ error: 'No contact details on file to message this client. Open them to add a number or connect a channel.' });
  }

  const firstName = client.first_name?.trim() || 'there';
  const message = buildRebookMessage(firstName, beautician);
  const channel = client.preferred_channel || 'sms';

  // The one gate: consent (fail closed), frequency + monthly caps, allowance
  // reserve, the trust dial, and the known-client hold. Never weakened here. The
  // SEND step routes to the client's own channel.
  const verdict = await guardedSend({
    beauticianId,
    clientId,
    messageType: 'rebook_offer',
    channel,
    client,
    body: message,
    send: async () => {
      const r = await sendOnPreferredChannel({ client, body: message, beautician, messageType: 'rebook_offer' });
      return r.ok;
    },
  });

  return res.json(describeVerdict(verdict, firstName));
});

/**
 * POST /api/suggestions/fill-gap
 * The flagship one-tap money-maker. Reuses the gap-fill engine's own gap
 * detection + candidate matching (getGapFillSuggestions: it scans the next 7
 * days, finds gaps >=30min, builds waitlist/rebook/dormant pools, matches them
 * to gaps with fitsGap/matchesPreferences, and already skips anyone contacted in
 * the last 7 days). We never rebuild that matching here.
 *
 * Default target is the soonest gap (or tomorrow if a date is passed). For each
 * matched client we send a warm, personalised offer naming the open day/time and
 * their usual treatment, with the real booking link, THROUGH guardedSend on the
 * client's own channel. guardedSend respects consent, caps and the known-client
 * hold, so regulars Ellie knows land in her outbox for approval, not auto-sent.
 *
 * Returns { sent, held, blocked, gap, candidates } so the card can say what
 * happened. One bad candidate never aborts the batch.
 */
router.post('/fill-gap', requireAuth, async (req, res) => {
  const beautician = req.beautician;
  const beauticianId = beautician.id;
  const wantDate = req.body?.date ? String(req.body.date).slice(0, 10) : null;

  // Reuse the engine's read-only matcher: gaps + matched clients, already deduped
  // against recent contacts and waitlist/preference rules.
  let groups = [];
  try {
    groups = await getGapFillSuggestions(beauticianId);
  } catch (err) {
    logger.error({ err }, 'fill-gap: gap-fill matcher failed');
    return res.status(500).json({ error: 'Could not work out who to offer the slot to.' });
  }

  if (!groups.length) {
    return res.json({ sent: 0, held: 0, blocked: 0, candidates: 0, gap: null, reason: 'No matching clients for a near-term gap right now.' });
  }

  // Pick the target gap: the one matching the passed date, else the soonest.
  const sorted = [...groups].sort((a, b) => String(a.gap.date).localeCompare(String(b.gap.date)));
  const target = (wantDate && sorted.find(g => g.gap.date === wantDate)) || sorted[0];
  const gap = target.gap;
  const matches = target.matches || [];

  if (!matches.length) {
    return res.json({ sent: 0, held: 0, blocked: 0, candidates: 0, gap, reason: 'No clients are a fit for that gap.' });
  }

  // Pull full client records for the matched ids so we can route channel-faithful.
  const clientIds = matches.map(m => m.client?.id).filter(Boolean);
  const { data: clientRows } = await supabase
    .from('clients')
    .select('id, first_name, phone, whatsapp_id, instagram_id, preferred_channel, marketing_consent, marketing_opted_out_at, status')
    .eq('beautician_id', beauticianId)
    .in('id', clientIds);
  const clientById = new Map((clientRows || []).map(c => [c.id, c]));

  const dayLabel = gap.dayLabel || gap.date;
  const timeLabel = gap.start;
  let sent = 0, held = 0, blocked = 0;

  for (const match of matches) {
    const client = clientById.get(match.client?.id);
    if (!client) { blocked++; continue; }
    // Never offer where we have no channel to reach them on.
    if (!reachable(client, beautician)) { blocked++; continue; }

    try {
      const treatmentName = match.treatment?.name || 'your usual';
      const message = buildGapMessage(client.first_name, dayLabel, timeLabel, treatmentName, beautician);
      const channel = client.preferred_channel || 'sms';

      const verdict = await guardedSend({
        beauticianId,
        clientId: client.id,
        messageType: 'gap_fill_offer',
        channel,
        client,
        body: message,
        send: async () => {
          const r = await sendOnPreferredChannel({ client, body: message, beautician, messageType: 'gap_fill_offer' });
          return r.ok;
        },
      });

      if (verdict.delivered) sent++;
      else if (verdict.decision === 'approve') held++;
      else blocked++;
    } catch (err) {
      // One bad candidate must not abort the batch.
      logger.warn({ err, clientId: client.id }, 'fill-gap: one offer failed');
      blocked++;
    }
  }

  return res.json({
    sent,
    held,
    blocked,
    candidates: matches.length,
    gap: { date: gap.date, dayLabel, start: gap.start, end: gap.end, duration_minutes: gap.duration_minutes },
  });
});

/**
 * POST /api/suggestions/fill-week
 * The quiet-week card's accept. Offers next week's open slots (all gaps that
 * have a matched client) to those clients, one offer per client, capped so a
 * single tap never floods the outbox. Every offer goes THROUGH the outbound
 * guard, so proactive offers land as pending_approval in the outbox and only
 * auto-send if Ellie has explicitly trusted this. Mirrors /fill-gap over the
 * whole week rather than a single gap.
 */
router.post('/fill-week', requireAuth, async (req, res) => {
  const beautician = req.beautician;
  const beauticianId = beautician.id;

  let groups = [];
  try {
    groups = await getGapFillSuggestions(beauticianId);
  } catch (err) {
    logger.error({ err }, 'fill-week: gap-fill matcher failed');
    return res.status(500).json({ error: 'Could not work out who to offer the slots to.' });
  }

  const withMatches = [...groups]
    .filter(g => (g.matches || []).length > 0)
    .sort((a, b) => String(a.gap.date).localeCompare(String(b.gap.date)));
  if (!withMatches.length) {
    return res.json({ sent: 0, held: 0, blocked: 0, candidates: 0, gaps: 0, reason: 'No clients are a fit for next week\'s open slots right now.' });
  }

  const allIds = [...new Set(withMatches.flatMap(g => (g.matches || []).map(m => m.client?.id).filter(Boolean)))];
  const { data: clientRows } = await supabase
    .from('clients')
    .select('id, first_name, phone, whatsapp_id, instagram_id, preferred_channel, marketing_consent, marketing_opted_out_at, status')
    .eq('beautician_id', beauticianId)
    .in('id', allIds);
  const clientById = new Map((clientRows || []).map(c => [c.id, c]));

  const MAX_OFFERS = 8;          // one tap never floods the outbox
  const offeredTo = new Set();   // at most one offer per client across the week
  let sent = 0, held = 0, blocked = 0, candidates = 0;

  for (const { gap, matches } of withMatches) {
    if (sent + held >= MAX_OFFERS) break;
    const dayLabel = gap.dayLabel || gap.date;
    const timeLabel = gap.start;
    for (const match of (matches || [])) {
      if (sent + held >= MAX_OFFERS) break;
      const id = match.client?.id;
      if (!id || offeredTo.has(id)) continue;
      const client = clientById.get(id);
      if (!client) { blocked++; continue; }
      if (!reachable(client, beautician)) { blocked++; continue; }
      candidates++;
      offeredTo.add(id);
      try {
        const treatmentName = match.treatment?.name || 'your usual';
        const message = buildGapMessage(client.first_name, dayLabel, timeLabel, treatmentName, beautician);
        const channel = client.preferred_channel || 'sms';
        const verdict = await guardedSend({
          beauticianId,
          clientId: id,
          messageType: 'gap_fill_offer',
          channel,
          client,
          body: message,
          send: async () => {
            const r = await sendOnPreferredChannel({ client, body: message, beautician, messageType: 'gap_fill_offer' });
            return r.ok;
          },
        });
        if (verdict.delivered) sent++;
        else if (verdict.decision === 'approve') held++;
        else blocked++;
      } catch (err) {
        logger.warn({ err, clientId: id }, 'fill-week: one offer failed');
        blocked++;
      }
    }
  }

  return res.json({ sent, held, blocked, candidates, gaps: withMatches.length });
});

/**
 * POST /api/suggestions/block-day
 * Block a bank-holiday (or any) date by inserting an hours_exception. Idempotent:
 * a day that is already blocked just returns ok. Reuses the same insert shape the
 * live bank-holiday side effect already used in production.
 */
router.post('/block-day', requireAuth, async (req, res) => {
  const beauticianId = req.beautician.id;
  const date = req.body?.date;
  const name = req.body?.name;
  if (!date) return res.status(400).json({ error: 'Missing date' });

  const { data: existing } = await supabase
    .from('hours_exceptions')
    .select('id')
    .eq('beautician_id', beauticianId)
    .eq('date', date)
    .maybeSingle();
  if (existing) return res.json({ ok: true, action: 'already_blocked' });

  const { error } = await supabase
    .from('hours_exceptions')
    .insert([{
      beautician_id: beauticianId,
      date,
      type: 'closed',
      reason: 'bank_holiday',
      note: name ? `${name} (bank holiday)` : 'Bank holiday',
      notify_clients: false,
      created_at: new Date().toISOString(),
    }]);

  if (error) {
    logger.error({ err: error }, 'Florrie-thinks block-day failed');
    return res.status(500).json({ error: 'Could not block the day off.' });
  }
  return res.json({ ok: true, action: 'day_blocked' });
});

/**
 * GET /api/suggestions/unpriced
 * Upcoming appointments with no price set, so the card can let her fill them in
 * inline. Imported bookings often land at price_cents 0.
 */
router.get('/unpriced', requireAuth, async (req, res) => {
  const beauticianId = req.beautician.id;
  const rows = await getUnpricedUpcoming(beauticianId, 12);
  return res.json({ appointments: rows });
});

/**
 * PATCH /api/suggestions/appointments/:id/price
 * Set the price (in pence) on one appointment.
 */
router.patch('/appointments/:id/price', requireAuth, async (req, res) => {
  const beauticianId = req.beautician.id;
  const cents = Math.round(Number(req.body?.price_cents));
  if (!Number.isFinite(cents) || cents < 0) {
    return res.status(400).json({ error: 'price_cents must be a non-negative number' });
  }

  const { error } = await supabase
    .from('appointments')
    .update({ price_cents: cents })
    .eq('id', req.params.id)
    .eq('beautician_id', beauticianId);

  if (error) {
    logger.error({ err: error }, 'Florrie-thinks set-price failed');
    return res.status(500).json({ error: 'Could not save the price.' });
  }
  return res.json({ ok: true, price_cents: cents });
});

// ============================================================
// Sources: each returns cards with impact_pence + priority + action.
// ============================================================

async function fromUpcomingBankHoliday(beauticianId) {
  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('postcode')
      .eq('id', beauticianId)
      .single();

    const division = postcodeToDivision(b?.postcode);
    const next = nextBankHoliday(division);
    if (!next) return [];

    // Never re-prompt once she has decided for this date, or if it is blocked.
    const { data: decided } = await supabase
      .from('florrie_decisions')
      .select('id')
      .eq('beautician_id', beauticianId)
      .eq('suggestion_type', 'bank_holiday')
      .contains('suggestion_payload', { date: next.date })
      .limit(1);
    if (decided && decided.length) return [];

    const { data: exc } = await supabase
      .from('hours_exceptions')
      .select('id')
      .eq('beautician_id', beauticianId)
      .eq('date', next.date)
      .maybeSingle();
    if (exc) return [];

    // Urgency: the closer the date, the higher it should ride. No direct pounds
    // figure (it is a "decide" card), so impact stays 0 and urgency carries it.
    const urgency = next.daysAway <= 3 ? 95 : next.daysAway <= 10 ? 80 : 60;

    return [{
      id: `bankholiday-${next.date}`,
      type: 'bank_holiday',
      featured: true,
      pill: 'Bank holiday',
      icon: '\u{1F4C5}',
      title: next.title,
      date: next.date,
      summary: `${next.title} is ${friendlyWhen(next.date, next.daysAway)}. Want me to block the day off, or keep it open for bookings?`,
      action_label: 'Block it off',
      secondary_label: 'Keep it open',
      impact_pence: 0,
      priority: urgency,
      payload: { date: next.date, name: next.title },
      action: {
        kind: 'block_day',
        endpoint: '/api/suggestions/block-day',
        method: 'POST',
        body: { date: next.date, name: next.title },
        confirm: null,
      },
      link_to: '/hours',
    }];
  } catch (err) {
    logger.error({ err }, 'fromUpcomingBankHoliday failed');
    return [];
  }
}

function friendlyWhen(date, daysAway) {
  const d = new Date(`${date}T00:00:00Z`);
  const long = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const short = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  if (daysAway <= 0) return 'today';
  if (daysAway === 1) return `tomorrow (${short})`;
  if (daysAway <= 21) return `on ${short}, just ${daysAway} days away`;
  return `coming up on ${long}`;
}

async function fromBookingSuggestions(beauticianId) {
  const { data, error } = await supabase
    .from('booking_suggestions')
    .select('id, treatment_name, suggested_date, suggested_time, client_id, clients(first_name, last_name)')
    .eq('beautician_id', beauticianId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(3);

  if (error || !data || !data.length) return [];

  // LEGACY PURGE, server side: a stored suggestion whose date has passed, or
  // one that cannot name its client, must never render anywhere. The August
  // incident was this exact table serving "Thu 25 Jun, book it in?" months
  // late, for nobody in particular, with a Book button that would have written
  // a June date into the diary. Rows are filtered, not deleted; the new
  // /api/florrie-thinks endpoint also retires past-dated rows to 'dismissed'.
  const todayStr = new Date().toISOString().slice(0, 10);
  const live = data.filter(row =>
    row.clients?.first_name?.trim()
    && row.suggested_date
    && String(row.suggested_date).slice(0, 10) >= todayStr
  );
  if (!live.length) return [];

  // Price each suggested treatment by name so the card shows real money at stake.
  const { data: treatments } = await supabase
    .from('treatments')
    .select('name, price_cents')
    .eq('beautician_id', beauticianId);
  const priceByName = new Map(
    (treatments || []).map(t => [(t.name || '').trim().toLowerCase(), t.price_cents || 0])
  );

  return live.map(row => {
    const first = row.clients.first_name.trim();
    const dateLong = formatShortDate(row.suggested_date);
    const time = row.suggested_time ? ` at ${String(row.suggested_time).slice(0, 5)}` : '';
    const calendarDate = isoDateOnly(row.suggested_date);
    const impact = priceByName.get(String(row.treatment_name || '').trim().toLowerCase()) || 0;

    // A confirmed booking is the single most valuable thing in the feed. Base 70
    // plus the pounds (capped so one giant treatment can't dwarf everything).
    const priority = 70 + Math.min(30, Math.round(impact / 1000));

    return {
      id: `booking-${row.id}`,
      type: 'booking_suggestion',
      icon: '📅',
      summary: `${first} wants ${row.treatment_name || 'a treatment'}${dateLong ? ` on ${dateLong}` : ''}${time}. Book it in?`,
      action_label: 'Book it',
      impact_pence: impact,
      priority,
      payload: { booking_suggestion_id: row.id },
      action: {
        kind: 'book',
        endpoint: '/api/suggestions/book',
        method: 'POST',
        body: { booking_suggestion_id: row.id },
        confirm: `Book ${first} in for ${row.treatment_name || 'this'}${time}?`,
      },
      link_to: calendarDate ? `/calendar/week?date=${calendarDate}` : '/calendar/week',
    };
  });
}

async function fromRebookReminders(beauticianId) {
  // Lapsed but re-engageable: 4 weeks to ~6 months. Past that the relationship
  // has ended, not lapsed, and a comeback offer reads as out of touch.
  const minCutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
  const maxCutoff = new Date(Date.now() - 182 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('clients')
    .select('id, first_name, last_name, last_visit_at, total_spend_cents, total_visits')
    .eq('beautician_id', beauticianId)
    .lt('last_visit_at', minCutoff)
    .gte('last_visit_at', maxCutoff)
    .order('last_visit_at', { ascending: false })
    .limit(3);

  if (error || !data) return [];

  const booked = await getFutureBookedClientIds(beauticianId);

  return data.filter(client => !booked.has(client.id)).map(client => {
    const weeks = Math.floor(
      (Date.now() - new Date(client.last_visit_at).getTime()) / (7 * 24 * 60 * 60 * 1000)
    );
    const first = client.first_name?.trim() || 'A client';

    // Impact = what one returning visit is roughly worth to her. Prefer the
    // client's own average spend; fall back to a modest sector default.
    const visits = client.total_visits || 0;
    const avg = (visits > 0 && client.total_spend_cents)
      ? Math.round(client.total_spend_cents / visits)
      : 3500;
    const impact = avg;

    const summary = weeks <= 8
      ? `${first} is due a rebook (last in ${weeks} weeks ago). Send a friendly nudge?`
      : `${first} hasn't been in for ${weeks} weeks. Send a comeback offer?`;

    // One returning client is real money but lower-certainty than a booking
    // she already has on the table. Base 40 + capped pounds.
    const priority = 40 + Math.min(20, Math.round(impact / 1000));

    return {
      id: `rebook-${client.id}`,
      type: 'rebook_reminder',
      icon: '💕',
      summary,
      action_label: 'Send offer',
      impact_pence: impact,
      priority,
      payload: { client_id: client.id, weeks_since: weeks },
      action: {
        kind: 'send_offer',
        endpoint: '/api/suggestions/send-offer',
        method: 'POST',
        body: { client_id: client.id },
        confirm: `Send ${first} a rebook offer?`,
      },
      link_to: `/inbox?client=${client.id}`,
    };
  });
}

async function fromValueCoaching(beauticianId) {
  const { data, error } = await supabase
    .from('ai_actions')
    .select('id, summary, created_at')
    .eq('beautician_id', beauticianId)
    .eq('action_type', 'value_coaching')
    .order('created_at', { ascending: false })
    .limit(6);

  if (error || !data) return [];

  const cards = [];
  for (const row of data) {
    if (!row.summary) continue;
    // Never surface a "£0" insight; legacy rows from imported £0 treatments can
    // still exist. Matches £0 only when it is a standalone zero amount.
    if (/£0(?![.\d])/.test(row.summary)) continue;

    // A coaching card earns its place only if it names a real pounds figure to
    // gain. No figure (or under a fiver) is judgement noise, not money, so we
    // drop it rather than clutter the feed.
    const m = String(row.summary).match(/£\s?(\d[\d,]*)/);
    const impact = m ? parseInt(m[1].replace(/,/g, ''), 10) * 100 : 0;
    if (impact < 500) continue;

    cards.push({
      id: `coaching-${row.id}`,
      type: 'value_coaching',
      icon: '💡',
      // Keep it to one tight line so a rambling insight can't blow out the card.
      summary: tidyCoaching(row.summary),
      action_label: 'Review prices',
      impact_pence: impact,
      // Judgement, not a one-tap action. It must rank BELOW everything that books,
      // fills a gap, or recovers untracked money, so the band tops out low.
      priority: 20 + Math.min(8, Math.round(impact / 2000)),
      payload: { ai_action_id: row.id },
      // No safe one-tap execute, so the primary action navigates to where she
      // edits prices and treatments.
      action: {
        kind: 'navigate',
        endpoint: null,
        method: null,
        body: null,
        confirm: null,
      },
      link_to: '/treatments',
    });
    // One coaching insight at a time keeps the feed varied, not all-pricing.
    if (cards.length >= 1) break;
  }
  return cards;
}

// Trim a coaching insight to a single clean sentence so the card stays scannable.
function tidyCoaching(text) {
  let t = String(text).replace(/\s+/g, ' ').trim();
  // Take the first sentence if it already carries the pounds figure; otherwise
  // keep up to the first two so the number is never cut off.
  const parts = t.split(/(?<=[.!?])\s+/);
  let out = parts[0] || t;
  if (!/£\s?\d/.test(out) && parts[1]) out = `${parts[0]} ${parts[1]}`;
  if (out.length > 130) out = `${out.slice(0, 127).trimEnd()}...`;
  return out;
}

async function fromGapFill(beauticianId) {
  // Reuse the gap-fill engine's own gap detection + candidate matching. It scans
  // the next 7 days, finds gaps >=30min, and matches waitlist / overdue-rebook /
  // dormant clients to them, already deduped against recent contacts. We never
  // rebuild that here; we just turn the soonest gap-with-candidates into a card
  // whose ONE TAP offers it to those exact clients.
  let groups = [];
  try {
    groups = await getGapFillSuggestions(beauticianId);
  } catch (err) {
    logger.error({ err }, 'fromGapFill: matcher failed');
    return [];
  }
  if (!groups.length) return [];

  // Soonest gap that actually has matched clients to offer.
  const withMatches = groups
    .filter(g => (g.matches || []).length > 0)
    .sort((a, b) => String(a.gap.date).localeCompare(String(b.gap.date)));
  if (!withMatches.length) return [];

  const { gap, matches } = withMatches[0];
  const n = matches.length;
  const dayLabel = gap.dayLabel || gap.date;
  // Friendly window, e.g. "9am to 11am" rather than "09:00 to 11:00".
  const window = `${friendlyTime(gap.start)} to ${friendlyTime(gap.end)}`;
  const clients = `${n} client${n === 1 ? '' : 's'} who ${n === 1 ? 'is' : 'are'} due a visit`;

  // Money on the table soon. Value it at the average completed price per client
  // we could fill the slot with (capped to the number who fit the gap).
  // A gap is one bookable slot, so its worth is roughly one completed visit.
  const fillImpact = await averageCompletedPrice(beauticianId);

  return [{
    id: `gap-fill-${gap.date}-${gap.start}`,
    type: 'gap_fill',
    featured: true,
    icon: '🌷',
    pill: 'Gap to fill',
    title: `${dayLabel}, ${window}`,
    summary: `${n} client${n === 1 ? '' : 's'} due a visit ${n === 1 ? 'is' : 'are'} a match. One tap and I'll offer it to them in your voice.`,
    action_label: 'Offer it',
    secondary_label: 'Not now',
    impact_pence: fillImpact,
    // A near-term fillable gap is real money soon. Sit it just under live bookings
    // and unpriced money, above plain rebook nudges.
    priority: 60 + Math.min(10, Math.round(fillImpact / 3000)),
    payload: { date: gap.date },
    action: {
      kind: 'fill_gap',
      endpoint: '/api/suggestions/fill-gap',
      method: 'POST',
      body: { date: gap.date },
      // Names the day, the window and how many clients, plainly.
      confirm: `Offer ${dayLabel}, ${window}, to ${clients}?`,
    },
    link_to: '/smart-schedule',
  }];
}

// Turn a 24-hour "HH:MM" into a warm "9am" / "1:30pm" label.
function friendlyTime(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return hhmm || '';
  const [hStr, mStr] = hhmm.split(':');
  let h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h)) return hhmm;
  const suffix = h < 12 ? 'am' : 'pm';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

async function fromQuietWeek(beauticianId, query = {}) {
  // A quiet week ahead is a chance to fill, not a chart. Surface ONE actionable
  // card whose accept offers the week's open slots to clients due back (guarded,
  // so they land in the outbox for Ellie's OK, nothing sends on its own).
  const forceRatio = query && query.qw_debug_ratio !== undefined
    ? parseFloat(query.qw_debug_ratio) : undefined;
  const status = await quietWeekStatus(
    beauticianId,
    Number.isFinite(forceRatio) ? { forceRatio } : {}
  );
  if (!status.quiet) return [];

  // One card per ISO week: once she has offered or dismissed it, it is gone.
  const { data: decisions } = await supabase
    .from('florrie_decisions')
    .select('suggestion_payload')
    .eq('beautician_id', beauticianId)
    .eq('suggestion_type', 'quiet_week');
  const answered = new Set(
    (decisions || []).map(d => d?.suggestion_payload?.iso_week).filter(Boolean)
  );
  if (answered.has(status.isoWeek)) return [];

  const n = status.openSlots;
  const slotWord = n === 1 ? 'slot' : 'slots';
  return [{
    id: `quiet-week-${status.isoWeek}`,
    type: 'quiet_week',
    icon: '\u{1F5D3}\u{FE0F}',
    summary: `Next week looks quiet, ${status.nextCount} booked against your usual ${status.baseline}. I can offer ${n} open ${slotWord} to clients due back. Want me to?`,
    action_label: 'Offer the slots',
    impact_pence: 0,
    priority: 44,
    payload: { iso_week: status.isoWeek, open_slots: n },
    action: {
      kind: 'fill_gap',
      endpoint: '/api/suggestions/fill-week',
      method: 'POST',
      body: {},
      confirm: `Offer ${n} open ${slotWord} to clients due back? They wait in your outbox for your OK. You can add a promo code from Offers first.`,
    },
    link_to: '/promos',
  }];
}

async function fromFiveStarReviews(beauticianId) {
  // A glowing review is free marketing. Turn a recent 5-star review with a
  // real comment into a one-tap post, prefilled and ready for Ellie to edit.
  const { data, error } = await supabase
    .from('reviews')
    .select('id, rating, comment, created_at, clients(first_name)')
    .eq('beautician_id', beauticianId)
    .gte('rating', 5)
    .order('created_at', { ascending: false })
    .limit(5);

  if (error || !data?.length) return [];

  const qualifying = data.filter(r => (r.comment || '').trim().length > 20);
  if (!qualifying.length) return [];

  // Durable dedupe: once she has posted or dismissed a review card it never
  // comes back, even past the 7-day answer window applyLearning enforces.
  const { data: decisions } = await supabase
    .from('florrie_decisions')
    .select('suggestion_payload')
    .eq('beautician_id', beauticianId)
    .eq('suggestion_type', 'review_post');
  const answered = new Set(
    (decisions || []).map(d => d?.suggestion_payload?.review_id).filter(Boolean)
  );

  const fresh = qualifying.filter(r => !answered.has(r.id)).slice(0, 2);
  if (!fresh.length) return [];

  // Booking slug for the caption's book-your-own link.
  const { data: beaut } = await supabase
    .from('beauticians')
    .select('booking_slug')
    .eq('id', beauticianId)
    .maybeSingle();
  const slug = beaut?.booking_slug || 'book';

  return fresh.map(r => {
    const first = r.clients?.first_name?.trim() || null;
    const comment = r.comment.trim();
    const caption = first
      ? `${first} said: "${comment}" \u{1F337}\n\nThank you ${first}! Book your own in: florrie.ai/book/${slug}`
      : `A lovely client said: "${comment}" \u{1F337}\n\nBook your own in: florrie.ai/book/${slug}`;
    const who = first || 'A client';
    return {
      id: `review-${r.id}`,
      type: 'review_post',
      icon: '\u2B50',
      summary: `${who} left you a 5-star review. Turn it into a post?`,
      action_label: 'Make a post',
      impact_pence: 0,
      priority: 32,
      payload: { review_id: r.id },
      action: { kind: 'navigate', endpoint: null, method: null, body: null, confirm: null },
      link_to: '/content',
      prefill: { compose: 'review', type: 'testimonial', caption },
    };
  });
}

async function fromUnpricedAppointments(beauticianId) {
  const rows = await getUnpricedUpcoming(beauticianId, 12);
  if (!rows.length) return [];

  // Money sitting in the diary with no price on it. Impact is what those visits
  // are roughly worth: count them at the average completed price.
  const avg = await averageCompletedPrice(beauticianId);
  const impact = rows.length * avg;
  const n = rows.length;

  return [{
    id: 'unpriced-appointments',
    type: 'unpriced_appointments',
    icon: '\u{1F3F7}\uFE0F',
    summary: `${n} upcoming booking${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} no price set. Add ${n === 1 ? 'it' : 'them'} so your takings stay right.`,
    action_label: 'Set prices',
    impact_pence: impact,
    // Untracked money should sit high, just under live bookings.
    priority: 55 + Math.min(15, Math.round(impact / 3000)),
    payload: { count: n },
    // Handled inline by the card (expands a mini editor); kind tells the UI.
    action: {
      kind: 'set_prices',
      endpoint: '/api/suggestions/unpriced',
      method: 'GET',
      body: null,
      confirm: null,
    },
    link_to: '/calendar/week',
  }];
}

// ============================================================
// Learning + dedup
// ============================================================

async function applyLearning(beauticianId, suggestions) {
  if (!suggestions.length) return suggestions;

  const since30 = new Date(Date.now() - LEARN_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('florrie_decisions')
    .select('suggestion_type, suggestion_payload, response, created_at')
    .eq('beautician_id', beauticianId)
    .gte('created_at', since30);

  if (!data || data.length === 0) return suggestions;

  // (a) Per-target dedup: anything answered in the last 7 days (any response)
  //     does not come back, so we never re-ask the same booking/client/date.
  const recentlyAnswered = new Set();
  // (b) Type-level learning: a card type told no/dismiss 2+ times in 30 days is
  //     suppressed entirely, it is clearly not wanted.
  const noCounts = new Map();

  for (const d of data) {
    if (d.created_at >= since7) {
      recentlyAnswered.add(stableKey(d.suggestion_type, d.suggestion_payload));
    }
    if (d.response === 'no' || d.response === 'dismissed') {
      noCounts.set(d.suggestion_type, (noCounts.get(d.suggestion_type) || 0) + 1);
    }
  }

  const mutedTypes = new Set(
    [...noCounts.entries()].filter(([, n]) => n >= LEARN_NO_THRESHOLD).map(([t]) => t)
  );

  return suggestions.filter(s =>
    !mutedTypes.has(s.type) && !recentlyAnswered.has(stableKey(s.type, s.payload))
  );
}

function stableKey(type, payload) {
  if (!payload || typeof payload !== 'object') return `${type}:`;
  const id =
    payload.booking_suggestion_id ||
    payload.client_id ||
    payload.date ||
    JSON.stringify(payload);
  return `${type}:${id}`;
}

// ============================================================
// Helpers
// ============================================================

function syntheticDefaults(beautician) {
  const firstName = beautician?.first_name?.trim() || 'there';
  return [
    {
      id: 'synth-import',
      type: 'synth_import_clients',
      icon: '📇',
      summary: 'Got an existing client list? Import it so Florrie can start learning.',
      action_label: 'Import',
      impact_pence: 0,
      priority: 10,
      payload: {},
      action: { kind: 'navigate', endpoint: null, method: null, body: null, confirm: null },
      link_to: '/import',
    },
    {
      id: 'synth-templates',
      type: 'synth_check_templates',
      icon: '💌',
      summary: 'Check your message templates so Florrie sounds like you.',
      action_label: 'Open',
      impact_pence: 0,
      priority: 9,
      payload: {},
      action: { kind: 'navigate', endpoint: null, method: null, body: null, confirm: null },
      link_to: '/templates',
    },
    {
      id: 'synth-booking',
      type: 'synth_share_booking',
      icon: '🔗',
      summary: `Share your booking link, ${firstName}. Clients book in, Florrie does the rest.`,
      action_label: 'Open',
      impact_pence: 0,
      priority: 8,
      payload: {},
      action: { kind: 'navigate', endpoint: null, method: null, body: null, confirm: null },
      link_to: '/business',
    },
  ];
}

async function getUnpricedUpcoming(beauticianId, limit = 12) {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from('appointments')
    .select('id, starts_at, price_cents, clients(first_name, last_name), treatments(name)')
    .eq('beautician_id', beauticianId)
    .gte('starts_at', nowIso)
    .neq('status', 'cancelled')
    .order('starts_at', { ascending: true })
    .limit(60);

  return (data || [])
    .filter(a => !a.price_cents || a.price_cents === 0)
    .slice(0, limit)
    .map(a => ({
      id: a.id,
      client: [a.clients?.first_name, a.clients?.last_name].map(x => (x || '').trim()).filter(Boolean).join(' ') || 'A client',
      treatment: a.treatments?.name || 'Treatment',
      date: isoDateOnly(a.starts_at),
    }));
}

async function averageCompletedPrice(beauticianId) {
  try {
    const { data } = await supabase
      .from('appointments')
      .select('price_cents')
      .eq('beautician_id', beauticianId)
      .eq('status', 'completed')
      .gt('price_cents', 0)
      .order('starts_at', { ascending: false })
      .limit(30);
    if (!data || !data.length) return 3500;
    return Math.round(data.reduce((s, a) => s + (a.price_cents || 0), 0) / data.length);
  } catch {
    return 3500;
  }
}

// True if there is at least one channel we can actually reach this client on,
// mirroring how sendOnPreferredChannel decides where a message would go.
function reachable(client, beautician) {
  const channel = client?.preferred_channel || 'sms';
  if (channel === 'instagram' && client?.instagram_id) return true;
  if (channel === 'whatsapp' && beautician?.whatsapp_phone_id && client?.whatsapp_id) return true;
  return !!client?.phone; // SMS fallback
}

// Booking link for this beautician, or null if she has no slug yet.
function bookingUrlFor(beautician) {
  return beautician?.booking_slug ? `florrie.ai/book/${beautician.booking_slug}` : null;
}

// Warm rebook copy. No em dashes, no slop.
function buildRebookMessage(firstName, beautician) {
  const businessName = beautician?.business_name || 'us';
  const url = bookingUrlFor(beautician);
  const cta = url ? `book your next visit here: ${url}` : `just reply and I'll get you booked in`;
  return `Hi ${firstName}, it's been a while since we saw you at ${businessName}. We'd love to have you back, ${cta} 💕`;
}

// Warm gap-fill copy naming the open day, time and their usual treatment.
function buildGapMessage(firstName, dayLabel, timeLabel, treatmentName, beautician) {
  const name = firstName?.trim() || 'there';
  const url = bookingUrlFor(beautician);
  const cta = url ? `Grab it here: ${url}` : `Reply and I'll pop you in`;
  return `Hi ${name}, a slot has just opened up on ${dayLabel} at ${timeLabel}, perfect for your ${treatmentName}. ${cta} 💕`;
}

// Turn a guardedSend verdict into the { ok, outcome, sent, held, reason } shape
// the single-offer card expects.
function describeVerdict(verdict, firstName) {
  let outcome = 'blocked';
  if (verdict.delivered) outcome = 'sent';
  else if (verdict.decision === 'approve') outcome = 'held';

  const reasons = {
    no_client_match: 'No contact details to message on.',
    opted_out: `${firstName} has opted out of messages.`,
    quiet_hours: 'Saved for daytime, it is too late to message now.',
    frequency_cap: `${firstName} was messaged recently, this is on hold.`,
    monthly_cap: `${firstName} has had a few messages this month, this is on hold.`,
    allowance_reserved: 'Your message allowance is low, this is on hold.',
    autonomy_off: 'Rebook offers are switched off in your settings.',
    send_failed: 'The message could not be sent. Try again shortly.',
  };

  return {
    ok: outcome !== 'blocked',
    outcome,
    held: outcome === 'held',
    sent: outcome === 'sent',
    reason: outcome === 'blocked' ? (reasons[verdict.reason] || 'Could not send right now.') : null,
  };
}

function formatShortDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch { return ''; }
}

// Normalise a date or timestamp to a YYYY-MM-DD string for /calendar?date=.
function isoDateOnly(value) {
  if (!value) return '';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  } catch { return ''; }
}


export default router;
