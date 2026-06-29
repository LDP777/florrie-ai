import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { nextBankHoliday, postcodeToDivision } from '../lib/bank-holidays.js';
import { getFutureBookedClientIds } from '../lib/future-bookings.js';
import { guardedSend } from '../lib/outbound-guard.js';
import { sendSMS } from '../services/notifications.js';

const router = Router();

/**
 * Florrie thinks: the proactive intelligence feed on the Today page.
 *
 * GET  /api/suggestions                     -> one prioritised, deduped stream
 * POST /api/suggestions/respond             -> record yes / no / tweak / dismiss
 * POST /api/suggestions/book                -> actually create the appointment
 * POST /api/suggestions/send-offer          -> send rebook/gap-fill offer (guarded)
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
      fromEmptyTomorrow(beauticianId),
      fromUnpricedAppointments(beauticianId),
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

  return res.status(201).json({ ok: true, appointment_id: appointment.id });
});

/**
 * POST /api/suggestions/send-offer
 * Send a rebook / gap-fill offer to the client through the single outbound gate.
 * guardedSend returns 'send' (delivered now) or 'approve' (held in the owner's
 * outbox for known clients / awaiting trust) or 'block'. We report which, so the
 * UI can say "Offer sent" vs "Held for your OK".
 */
router.post('/send-offer', requireAuth, async (req, res) => {
  const beauticianId = req.beautician.id;
  const clientId = req.body?.client_id;
  if (!clientId) return res.status(400).json({ error: 'Missing client_id' });

  const { data: client } = await supabase
    .from('clients')
    .select('id, first_name, phone, marketing_consent, marketing_opted_out_at, status')
    .eq('id', clientId)
    .eq('beautician_id', beauticianId)
    .maybeSingle();
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!client.phone) {
    return res.status(400).json({ error: 'No phone number on file to message this client. Open them to add one.' });
  }

  const { data: b } = await supabase
    .from('beauticians')
    .select('business_name, booking_slug')
    .eq('id', beauticianId)
    .maybeSingle();

  const firstName = client.first_name?.trim() || 'there';
  const businessName = b?.business_name || 'us';
  const bookingUrl = b?.booking_slug ? `florrie.ai/book/${b.booking_slug}` : null;
  const cta = bookingUrl
    ? `book your next visit here: ${bookingUrl}`
    : `just reply and I'll get you booked in`;
  const message = `Hi ${firstName}, it's been a while since we saw you at ${businessName}. We'd love to have you back, ${cta} 💕`;

  // The one gate: consent (fail closed), frequency + monthly caps, allowance
  // reserve, the trust dial, and the known-client hold. Never weakened here.
  const verdict = await guardedSend({
    beauticianId,
    clientId,
    messageType: 'rebook_offer',
    channel: 'sms',
    client,
    body: message,
    send: () => sendSMS({ to: client.phone, body: message, beauticianId, messageType: 'rebook_offer' }),
  });

  // 'sent' = delivered now. 'held' = queued in her outbox for a one-tap approve
  // (known client, or trust dial set to ask). 'blocked' = consent/cap/hours.
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

  return res.json({
    ok: outcome !== 'blocked',
    outcome,
    held: outcome === 'held',
    sent: outcome === 'sent',
    reason: outcome === 'blocked' ? (reasons[verdict.reason] || 'Could not send right now.') : null,
  });
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

  // Price each suggested treatment by name so the card shows real money at stake.
  const { data: treatments } = await supabase
    .from('treatments')
    .select('name, price_cents')
    .eq('beautician_id', beauticianId);
  const priceByName = new Map(
    (treatments || []).map(t => [(t.name || '').trim().toLowerCase(), t.price_cents || 0])
  );

  return data.map(row => {
    const first = row.clients?.first_name?.trim() || 'a client';
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
      link_to: calendarDate ? `/calendar?date=${calendarDate}` : '/today',
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

  return data
    // Never surface a "£0" insight; legacy rows from imported £0 treatments can
    // still exist. Matches £0 only when it is a standalone zero amount.
    .filter(row => row.summary && !/£0(?![.\d])/.test(row.summary))
    .slice(0, 2)
    .map(row => {
      // Pull a pounds figure out of the coaching copy if it has one, so the card
      // can show the upside and rank on it.
      const m = String(row.summary).match(/£\s?(\d[\d,]*)/);
      const impact = m ? parseInt(m[1].replace(/,/g, ''), 10) * 100 : 0;
      const priority = 25 + Math.min(15, Math.round(impact / 1000));
      return {
        id: `coaching-${row.id}`,
        type: 'value_coaching',
        icon: '💡',
        summary: row.summary,
        action_label: 'Review prices',
        impact_pence: impact,
        priority,
        payload: { ai_action_id: row.id },
        // No safe one-tap execute (it is judgement, not a single action), so the
        // primary action navigates to where she edits prices.
        action: {
          kind: 'navigate',
          endpoint: null,
          method: null,
          body: null,
          confirm: null,
        },
        link_to: '/treatments',
      };
    });
}

async function fromEmptyTomorrow(beauticianId) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const dayEnd = new Date(tomorrow);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const { data, error } = await supabase
    .from('appointments')
    .select('id')
    .eq('beautician_id', beauticianId)
    .gte('starts_at', tomorrow.toISOString())
    .lt('starts_at', dayEnd.toISOString())
    .neq('status', 'cancelled');

  if (error) return [];
  if ((data || []).length > 0) return [];

  // A whole empty day is a real revenue hole; an average day's takings is a fair
  // stand-in for what filling it could be worth.
  const dateStr = localDateOnly(tomorrow);
  const impact = await averageDayTakings(beauticianId);

  return [{
    id: 'gap-fill-tomorrow',
    type: 'gap_fill_tomorrow',
    icon: '🌷',
    summary: 'Tomorrow is quiet. Want Florrie to offer your waitlist a slot?',
    action_label: 'Offer it',
    impact_pence: impact,
    priority: 45 + Math.min(15, Math.round(impact / 2000)),
    payload: { date: dateStr },
    // No bulk waitlist-blast endpoint yet, so this still opens Smart Schedule.
    // The booking + rebook cards carry the executing actions this pass.
    action: {
      kind: 'navigate',
      endpoint: null,
      method: null,
      body: null,
      confirm: null,
    },
    link_to: '/smart-schedule',
  }];
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
    link_to: '/calendar',
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

async function averageDayTakings(beauticianId) {
  // Rough: mean price of the last 30 completed appointments times a typical
  // 3-booking day. Falls back to a sensible default when there is no history.
  try {
    const { data } = await supabase
      .from('appointments')
      .select('price_cents')
      .eq('beautician_id', beauticianId)
      .eq('status', 'completed')
      .gt('price_cents', 0)
      .order('starts_at', { ascending: false })
      .limit(30);
    if (!data || !data.length) return 9000;
    const mean = data.reduce((s, a) => s + (a.price_cents || 0), 0) / data.length;
    return Math.round(mean * 3);
  } catch {
    return 9000;
  }
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

// Local YYYY-MM-DD for a Date, never via toISOString (which shifts the day).
function localDateOnly(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default router;
