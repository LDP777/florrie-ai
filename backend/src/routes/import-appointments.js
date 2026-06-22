/**
 * Timely appointment import , POST /api/import/appointments
 *
 * Takes pre-mapped rows from the frontend (parsed out of Timely's
 * Reports > Appointment Schedule CSV) and inserts future appointments
 * for the authenticated beautician.
 *
 * Hard rules:
 *   - Plain supabase inserts ONLY. No Stripe, no notifications, no
 *     confirmations, no reminders, no messaging of any kind.
 *   - Times follow the wall-clock convention: the CSV's date + time are
 *     stored as-is with a UTC stamp (e.g. "2026-06-22T14:00:00"), never
 *     timezone-converted.
 *   - treatment_id is NOT NULL on appointments, so unmatched services get
 *     one inactive treatment created per unique name and reused.
 *   - booked_via is constrained by a CHECK; we try 'import' first and fall
 *     back to 'manual' if the DB hasn't had migration 057 applied yet.
 */
import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

const MAX_ROWS = 500;
const CANCELLED_STATUSES = '("cancelled","cancelled_by_client","cancelled_by_beautician")';

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Normalise a date into 'YYYY-MM-DD'. Accepts:
 *   2026-06-22 / 2026/06/22
 *   22/06/2026 / 22-06-2026 / 22.06.2026 (UK day-first)
 *   22/06/26 (two-digit year)
 *   22 Jun 2026 / 22 June 2026 / Mon 22 Jun 2026 / Jun 22, 2026
 * Returns null if unreadable.
 */
function normaliseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // ISO-ish: 2026-06-22 (optionally with trailing time)
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return buildDate(m[1], m[2], m[3]);

  // UK day-first: 22/06/2026, 22-06-2026, 22.06.26
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let year = m[3];
    if (year.length === 2) year = '20' + year;
    return buildDate(year, m[2], m[1]);
  }

  // Month names: "22 Jun 2026", "Mon 22 June 2026", "Jun 22, 2026"
  m = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month) return buildDate(m[3], month, m[1]);
  }
  m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month) return buildDate(m[3], month, m[2]);
  }

  return null;
}

function buildDate(y, mo, d) {
  const year = parseInt(y, 10);
  const month = parseInt(mo, 10);
  const day = parseInt(d, 10);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Normalise a time into 'HH:MM' (24h). Accepts '2:00 PM', '2.00pm', '2pm',
 * '14:00', '14:00:00', '09:30 AM'. Returns null if unreadable.
 */
function normaliseTime(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?$/);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[4] ? m[4].toLowerCase() : null;
  if (mins > 59) return null;
  if (meridiem === 'p' && hours < 12) hours += 12;
  if (meridiem === 'a' && hours === 12) hours = 0;
  if (hours > 23) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(mins)}`;
}

/**
 * Wall-clock string builder. Adds minutes using UTC arithmetic so no local
 * timezone ever leaks in, then formats back to 'YYYY-MM-DDTHH:MM:00'.
 */
function wallClock(dateStr, timeStr, addMinutes = 0) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, hh, mm + addMinutes));
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}

/** Parse '£45.00', '45', '1,250.50' into integer pence. Null if absent/unreadable. */
function parsePriceCents(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).replace(/[£$\s,]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  if (isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Parse '60', '60 min', '1:30', '1h 30m', '1 hr' into minutes. Null if unreadable. */
function parseDuration(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const h = s.match(/(\d+(?:\.\d+)?)\s*h/);
  const min = s.match(/(\d+)\s*m/);
  if (h || min) {
    return Math.round((h ? parseFloat(h[1]) * 60 : 0) + (min ? parseInt(min[1], 10) : 0)) || null;
  }
  const n = parseInt(s, 10);
  if (!isNaN(n) && n > 0 && n <= 24 * 60) return n;
  return null;
}

/** Digits only, for phone matching. */
function phoneDigits(p) {
  return String(p || '').replace(/\D/g, '');
}

/** Lowercase, strip punctuation, collapse whitespace. "Lashes - Classic Set!" -> "lashes classic set". */
function normaliseService(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words that carry no identity, so they shouldn't drive a token match.
const SERVICE_STOPWORDS = new Set(['the', 'a', 'and', 'with', 'set', 'full', 'mini', 'session', 'appointment', 'treatment', 'service', 'inc', 'including']);

function serviceTokens(s) {
  return normaliseService(s).split(' ').filter((w) => w && !SERVICE_STOPWORDS.has(w));
}

/**
 * Best treatment for an imported service name. Tries, in order: exact normalised
 * match, one name fully containing the other, then Jaccard token overlap. Only
 * returns a match when it's confident enough to inherit that treatment's price.
 * Returns null if nothing clears the bar (caller makes a placeholder instead).
 */
function bestTreatmentMatch(serviceName, treatments) {
  const norm = normaliseService(serviceName);
  if (!norm) return null;
  const exact = treatments.find((t) => t.normKey === norm);
  if (exact) return exact;

  const tokens = serviceTokens(serviceName);
  if (tokens.length === 0) return null;
  const tokenSet = new Set(tokens);

  let best = null;
  let bestScore = 0;
  for (const t of treatments) {
    if (!t.normKey) continue;
    // Containment either direction is a strong signal.
    let score = 0;
    if (t.normKey.includes(norm) || norm.includes(t.normKey)) {
      score = 0.9;
    } else {
      const tt = t.tokens || [];
      if (tt.length === 0) continue;
      let shared = 0;
      for (const w of tt) if (tokenSet.has(w)) shared += 1;
      const union = new Set([...tokens, ...tt]).size;
      score = union > 0 ? shared / union : 0;
    }
    if (score > bestScore) { bestScore = score; best = t; }
  }
  // 0.5 Jaccard ~ half the meaningful words shared. Conservative enough to avoid
  // gluing "Brow Tint" onto "Lash Tint", generous enough to catch reorderings.
  return bestScore >= 0.5 ? best : null;
}

/** Split 'Jane Smith' or 'Smith, Jane' into { first, last }. */
function splitName(name) {
  const s = String(name || '').trim();
  if (s.includes(',')) {
    const [last, first] = s.split(',').map((p) => p.trim());
    if (first) return { first, last: last || null };
  }
  const parts = s.split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || null };
}

router.post('/appointments', requireAuth, async (req, res) => {
  const beauticianId = req.beautician.id;
  const { rows } = req.body || {};

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Send the appointments in a "rows" array' });
  }
  if (rows.length > MAX_ROWS) {
    return res.status(400).json({ error: `Too many rows (max ${MAX_ROWS} per import)` });
  }

  const result = {
    imported: 0,
    skipped_duplicates: 0,
    clients_created: 0,
    unmatched_services: [],
    errors: [],
  };

  try {
    // ---- Preload everything we match against (one query each, not per row) ----
    const [{ data: clientRows, error: cErr }, { data: treatmentRows, error: tErr }] = await Promise.all([
      supabase
        .from('clients')
        .select('id, first_name, last_name, phone, email')
        .eq('beautician_id', beauticianId),
      supabase
        .from('treatments')
        .select('id, name, price_cents, duration_minutes')
        .eq('beautician_id', beauticianId),
    ]);
    if (cErr || tErr) {
      logger.error({ err: cErr || tErr, beauticianId }, 'Timely import preload failed');
      return res.status(500).json({ error: 'Could not load your clients and treatments' });
    }

    const clients = (clientRows || []).map((c) => ({
      id: c.id,
      nameKey: `${c.first_name || ''} ${c.last_name || ''}`.trim().toLowerCase(),
      digits: phoneDigits(c.phone),
      email: (c.email || '').toLowerCase(),
    }));
    const treatments = (treatmentRows || []).map((t) => ({
      id: t.id,
      nameKey: (t.name || '').trim().toLowerCase(),
      normKey: normaliseService(t.name),
      tokens: serviceTokens(t.name),
      price_cents: t.price_cents || 0,
      duration_minutes: t.duration_minutes || 60,
    }));

    // ---- Normalise every row up front so we can window the duplicate query ----
    const parsed = [];
    rows.forEach((row, i) => {
      const rowNum = i + 1;
      const date = normaliseDate(row.date);
      const time = normaliseTime(row.start_time);
      const name = String(row.client_name || '').trim();
      if (!date) { result.errors.push({ row: rowNum, reason: `Could not read the date "${row.date || ''}"` }); return; }
      if (!time) { result.errors.push({ row: rowNum, reason: `Could not read the start time "${row.start_time || ''}"` }); return; }
      if (!name) { result.errors.push({ row: rowNum, reason: 'No client name on this row' }); return; }
      parsed.push({ rowNum, date, time, name, raw: row, startsAt: wallClock(date, time) });
    });

    if (parsed.length === 0) {
      return res.json(result);
    }

    // ---- Existing appointments in the import's date window (non-cancelled) ----
    const sorted = parsed.map((p) => p.startsAt).sort();
    const windowStart = wallClock(sorted[0].slice(0, 10), sorted[0].slice(11, 16), -2);
    const last = sorted[sorted.length - 1];
    const windowEnd = wallClock(last.slice(0, 10), last.slice(11, 16), 2);

    const { data: existingAppts, error: aErr } = await supabase
      .from('appointments')
      .select('client_id, starts_at')
      .eq('beautician_id', beauticianId)
      .gte('starts_at', windowStart)
      .lte('starts_at', windowEnd)
      .not('status', 'in', CANCELLED_STATUSES);
    if (aErr) {
      logger.error({ err: aErr, beauticianId }, 'Timely import duplicate-window query failed');
      return res.status(500).json({ error: 'Could not check for existing appointments' });
    }

    // client_id -> [epoch ms] of existing non-cancelled appointment starts
    const apptTimes = new Map();
    const addApptTime = (clientId, isoish) => {
      const t = new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(isoish) ? isoish : isoish + 'Z').getTime();
      if (isNaN(t)) return;
      if (!apptTimes.has(clientId)) apptTimes.set(clientId, []);
      apptTimes.get(clientId).push(t);
    };
    (existingAppts || []).forEach((a) => addApptTime(a.client_id, a.starts_at));

    const unmatchedServiceSet = new Set();
    const createdTreatmentByName = new Map(); // lowercased service name -> treatment object
    let bookedVia = 'import'; // falls back to 'manual' if the CHECK rejects it

    // ---- Row by row. Sequential on purpose: find-or-create must not race itself. ----
    for (const p of parsed) {
      const row = p.raw;

      // 1. Find or create the client
      let client = null;
      const digits = phoneDigits(row.phone);
      if (digits.length >= 9) {
        const last9 = digits.slice(-9);
        client = clients.find((c) => c.digits.length >= 9 && c.digits.endsWith(last9)) || null;
      }
      if (!client) {
        const nameKey = p.name.toLowerCase();
        client = clients.find((c) => c.nameKey === nameKey) || null;
      }

      if (!client) {
        const { first, last } = splitName(p.name);
        if (!first) {
          result.errors.push({ row: p.rowNum, reason: 'Client name was empty after cleaning' });
          continue;
        }
        const email = String(row.email || '').trim().toLowerCase() || null;
        const phone = String(row.phone || '').trim().substring(0, 30) || null;
        const insertRow = {
          beautician_id: beauticianId,
          first_name: first.substring(0, 100),
          last_name: last ? last.substring(0, 100) : null,
          phone,
          email: email ? email.substring(0, 255) : null,
          status: 'new',
          imported_from: 'timely',
        };
        const { data: created, error: createErr } = await supabase
          .from('clients')
          .insert(insertRow)
          .select('id, first_name, last_name, phone, email')
          .single();

        if (createErr) {
          // Unique collision on (beautician_id, email) or (beautician_id, phone):
          // someone matching this contact info already exists, re-fetch and reuse.
          if (createErr.code === '23505') {
            let refetched = null;
            if (phone) {
              const { data } = await supabase
                .from('clients')
                .select('id, first_name, last_name, phone, email')
                .eq('beautician_id', beauticianId)
                .eq('phone', phone)
                .maybeSingle();
              refetched = data;
            }
            if (!refetched && email) {
              const { data } = await supabase
                .from('clients')
                .select('id, first_name, last_name, phone, email')
                .eq('beautician_id', beauticianId)
                .eq('email', email)
                .maybeSingle();
              refetched = data;
            }
            if (!refetched) {
              result.errors.push({ row: p.rowNum, reason: `Could not create or find client "${p.name}"` });
              continue;
            }
            client = {
              id: refetched.id,
              nameKey: `${refetched.first_name || ''} ${refetched.last_name || ''}`.trim().toLowerCase(),
              digits: phoneDigits(refetched.phone),
              email: (refetched.email || '').toLowerCase(),
            };
            clients.push(client);
          } else {
            logger.error({ err: createErr, row: p.rowNum }, 'Timely import client insert failed');
            result.errors.push({ row: p.rowNum, reason: `Could not create client "${p.name}"` });
            continue;
          }
        } else {
          client = {
            id: created.id,
            nameKey: `${created.first_name || ''} ${created.last_name || ''}`.trim().toLowerCase(),
            digits: phoneDigits(created.phone),
            email: (created.email || '').toLowerCase(),
          };
          clients.push(client);
          result.clients_created += 1;
        }
      }

      // 2. Duplicate check: same beautician + client within 1 minute of starts_at
      const startsMs = new Date(p.startsAt + 'Z').getTime();
      const times = apptTimes.get(client.id) || [];
      if (times.some((t) => Math.abs(t - startsMs) <= 60 * 1000)) {
        result.skipped_duplicates += 1;
        continue;
      }

      // 3. Match the service to a treatment, creating an inactive one if needed
      //    (treatment_id is NOT NULL, so we always need a real id)
      const serviceName = String(row.service || '').trim();
      const serviceKey = serviceName.toLowerCase();
      let treatment = null;
      if (serviceKey) {
        // Token-aware fuzzy match first so a real treatment's price carries over
        // (Timely's schedule export has no price column, so without this every
        // imported booking lands at £0 and "today's potential" reads far too low).
        treatment = bestTreatmentMatch(serviceName, treatments)
          || createdTreatmentByName.get(serviceKey)
          || null;
      }

      const rowPriceCents = parsePriceCents(row.price);
      const rowDuration = parseDuration(row.duration_minutes);

      if (!treatment) {
        const placeholderName = serviceName || 'Imported appointment';
        const placeholderKey = placeholderName.toLowerCase();
        treatment = createdTreatmentByName.get(placeholderKey) || null;

        if (!treatment) {
          const { data: createdT, error: tCreateErr } = await supabase
            .from('treatments')
            .insert({
              beautician_id: beauticianId,
              name: placeholderName.substring(0, 200),
              // Don't invent a duration/price. These are inactive placeholders that
              // only exist so historical appointments have a name to reference. A
              // blanket 60-min/GBP0 default made them look like real, set-up
              // services (and silently sized future bookings at an hour). Leave them
              // at 0 so the treatment list clearly flags them as "needs setup" and
              // the beautician sets the real values before booking from them.
              duration_minutes: rowDuration || 0,
              price_cents: rowPriceCents || 0,
              category: 'Imported',
              is_active: false,
              booking_enabled: false,
            })
            .select('id, name, price_cents, duration_minutes')
            .single();

          if (tCreateErr || !createdT) {
            logger.error({ err: tCreateErr, row: p.rowNum }, 'Timely import treatment insert failed');
            result.errors.push({ row: p.rowNum, reason: `Could not create a treatment for "${placeholderName}"` });
            continue;
          }
          treatment = {
            id: createdT.id,
            nameKey: (createdT.name || '').trim().toLowerCase(),
            price_cents: createdT.price_cents || 0,
            duration_minutes: createdT.duration_minutes || 60,
          };
          createdTreatmentByName.set(placeholderKey, treatment);
          if (serviceName) unmatchedServiceSet.add(serviceName);
        }
      }

      // 4. Insert the appointment. Plain insert, nothing else fires.
      const duration = rowDuration || treatment.duration_minutes || 60;
      const priceCents = rowPriceCents !== null ? rowPriceCents : (treatment.price_cents || 0);
      const endsAt = wallClock(p.date, p.time, duration);

      const noteBits = ['Imported from Timely'];
      if (row.staff) noteBits.push(`Staff: ${String(row.staff).trim()}`);
      if (row.notes) noteBits.push(String(row.notes).trim());

      const apptRow = {
        beautician_id: beauticianId,
        client_id: client.id,
        treatment_id: treatment.id,
        starts_at: p.startsAt,
        ends_at: endsAt,
        duration_minutes: duration,
        buffer_minutes: 0,
        price_cents: priceCents,
        deposit_cents: 0,
        status: 'confirmed',
        booked_via: bookedVia,
        client_notes: noteBits.join('. ').substring(0, 2000),
      };

      let { error: insErr } = await supabase.from('appointments').insert(apptRow);

      // booked_via 'import' needs migration 057. If the CHECK rejects it,
      // drop to 'manual' for this and every later row.
      if (insErr && insErr.code === '23514' && /booked_via/.test(insErr.message || '') && bookedVia === 'import') {
        bookedVia = 'manual';
        ({ error: insErr } = await supabase.from('appointments').insert({ ...apptRow, booked_via: 'manual' }));
      }

      if (insErr) {
        logger.error({ err: insErr, row: p.rowNum }, 'Timely import appointment insert failed');
        result.errors.push({ row: p.rowNum, reason: `Could not save the appointment (${insErr.message || 'database error'})` });
        continue;
      }

      addApptTime(client.id, p.startsAt);
      result.imported += 1;
    }

    result.unmatched_services = Array.from(unmatchedServiceSet);

    logger.info(
      { beauticianId, imported: result.imported, skipped: result.skipped_duplicates, clientsCreated: result.clients_created, errors: result.errors.length, bookedVia },
      'Timely appointment import complete'
    );
    res.json(result);
  } catch (err) {
    logger.error({ err, beauticianId }, 'Timely appointment import crashed');
    res.status(500).json({ error: 'Import failed. Your existing data is safe.' });
  }
});

export default router;
