/**
 * Migration Routes , one-upload, one-click import from Fresha / Timely / Vagaro / CSV.
 *
 * POST /api/migrate/preview  , parse CSV, auto-detect platform, return preview
 * POST /api/migrate/execute  , bulk insert clients + treatments + appointments
 */
import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { parseMigrationFile } from '../services/migration-parser.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * Normalise a phone number for dedup purposes , strip everything that isn't a
 * digit, then collapse a leading 44 / 0 so "07412...", "+447412...", "447412..."
 * all hash to the same value. Used for in-memory dedup only; we still store
 * whatever the user gave us.
 */
function normalisePhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('44') && digits.length >= 12) return '0' + digits.slice(2);
  return digits;
}

/**
 * POST /api/migrate/preview
 * Body: { csv: "<raw csv text>" }
 * Returns: { platform, confidence, fileType, summary, clients[], treatments[], appointments[] }
 */
router.post('/preview', requireAuth, async (req, res) => {
  const { csv } = req.body;
  if (!csv || typeof csv !== 'string') {
    return res.status(400).json({ error: 'Send the CSV contents in the "csv" field' });
  }

  if (csv.length > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'File too large (max 10 MB)' });
  }

  try {
    const result = parseMigrationFile(csv);
    if (result.error) return res.status(422).json({ error: result.error });
    logger.info({ beauticianId: req.beautician.id, platform: result.platform, summary: result.summary, warnings: result.warnings }, 'Migration preview');
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'Migration preview failed');
    res.status(500).json({ error: 'Could not parse the file' });
  }
});

/**
 * POST /api/migrate/execute
 * Body: { csv: "<raw csv text>" } OR { clients[], treatments[], appointments[], platform }
 *
 * If csv is provided, we parse it again (idempotent).
 * If pre-parsed data is provided, we use that directly.
 *
 * Returns: { imported: { clients, treatments, appointments }, errors[] }
 */
router.post('/execute', requireAuth, async (req, res) => {
  const beauticianId = req.beautician.id;
  let clients, treatments, appointments, platform;

  // Accept either raw CSV or pre-parsed data
  if (req.body.csv) {
    const parsed = parseMigrationFile(req.body.csv);
    if (parsed.error) return res.status(422).json({ error: parsed.error });
    ({ clients, treatments, appointments, platform } = parsed);
  } else if (req.body.clients || req.body.treatments || req.body.appointments) {
    clients = req.body.clients || [];
    treatments = req.body.treatments || [];
    appointments = req.body.appointments || [];
    platform = req.body.platform || 'csv';

    // Hard limits , prevent a bad actor hammering the DB via pre-parsed payloads
    if (clients.length > 5000) return res.status(400).json({ error: 'Too many clients (max 5,000 per import)' });
    if (treatments.length > 500) return res.status(400).json({ error: 'Too many treatments (max 500 per import)' });
    if (appointments.length > 50000) return res.status(400).json({ error: 'Too many appointments (max 50,000 per import)' });
  } else {
    return res.status(400).json({ error: 'Provide csv text or pre-parsed data' });
  }

  const errors = [];
  const imported = { clients: 0, treatments: 0, appointments: 0 };

  try {
    if (clients.length) {
      // The clients table has TWO unique constraints: (beautician_id, email)
      // AND (beautician_id, phone). A bulk upsert can only target one, so any
      // row that collides on the OTHER one gets rejected and silently drops
      // the rest of the batch. That's why Ellie's import looked like nothing
      // happened. We pre-load existing rows and dedup in JS, then plain insert
      // one row at a time for the survivors so a single bad row can't poison
      // the rest.
      const { data: existing } = await supabase
        .from('clients')
        .select('id, first_name, last_name, email, phone')
        .eq('beautician_id', beauticianId);

      const seenEmail = new Set();
      const seenPhone = new Set();
      const seenNameKey = new Set();
      (existing || []).forEach(e => {
        if (e.email) seenEmail.add(e.email.toLowerCase());
        if (e.phone) seenPhone.add(normalisePhone(e.phone));
        seenNameKey.add(`${(e.first_name || '').toLowerCase().trim()}|${(e.last_name || '').toLowerCase().trim()}`);
      });

      let skippedDup = 0;
      const fresh = [];
      for (const c of clients) {
        const first = (c.first_name || '').trim().substring(0, 100);
        if (!first) continue;
        const last = (c.last_name || '').trim().substring(0, 100);
        const email = (c.email || '').trim().toLowerCase().substring(0, 255);
        const rawPhone = (c.phone || '').trim().substring(0, 30);
        const phone = normalisePhone(rawPhone);
        const nameKey = `${first.toLowerCase()}|${last.toLowerCase()}`;

        // Dedup logic: a client is a duplicate if it matches an existing OR a
        // previously-queued row on email, on phone, or on (first+last) when
        // both contact fields are empty.
        if (email && seenEmail.has(email)) { skippedDup++; continue; }
        if (phone && seenPhone.has(phone)) { skippedDup++; continue; }
        if (!email && !phone && seenNameKey.has(nameKey)) { skippedDup++; continue; }

        if (email) seenEmail.add(email);
        if (phone) seenPhone.add(phone);
        seenNameKey.add(nameKey);

        fresh.push({
          beautician_id: beauticianId,
          first_name: first,
          last_name: last || null,
          email: email || null,
          phone: rawPhone || null,
          notes: c.notes ? String(c.notes).substring(0, 2000) : null,
          imported_from: platform || 'csv',
          external_id: c.external_id ? String(c.external_id).substring(0, 100) : null,
          status: 'active',
        });
      }

      // Plain insert in batches. A single row failure won't kill the batch
      // because we already filtered duplicates. Anything that still fails
      // gets logged so we can see exactly what the DB rejected.
      const BATCH = 100;
      for (let i = 0; i < fresh.length; i += BATCH) {
        const batch = fresh.slice(i, i + BATCH);
        const { data, error } = await supabase
          .from('clients')
          .insert(batch)
          .select('id');

        if (error) {
          // Batch-level rejection. Try one-by-one so good rows survive.
          logger.warn({ err: error, batchStart: i }, 'Client batch insert failed, falling back to row-by-row');
          for (const row of batch) {
            const { data: one, error: oneErr } = await supabase.from('clients').insert([row]).select('id');
            if (oneErr) {
              logger.error({ err: oneErr, row: { first_name: row.first_name, email: row.email, phone: row.phone } }, 'Client row insert failed');
              errors.push(`Could not import ${row.first_name} ${row.last_name || ''}: ${oneErr.message}`);
            } else if (one) {
              imported.clients += one.length;
            }
          }
        } else {
          imported.clients += (data || []).length;
        }
      }

      if (skippedDup > 0) {
        logger.info({ skippedDup, beauticianId }, 'Skipped duplicate clients');
      }
    }

    if (treatments.length) {
      const treatmentRecords = treatments.map(t => ({
        beautician_id: beauticianId,
        name: (t.name || '').substring(0, 200),
        price_cents: t.price_cents || 0,
        duration_minutes: t.duration_minutes || 60,
        category: (t.category || 'General').substring(0, 100),
        active: true,
      }));

      // Upsert treatments , skip if name already exists for this beautician
      const { data, error } = await supabase
        .from('treatments')
        .upsert(treatmentRecords, { onConflict: 'beautician_id,name', ignoreDuplicates: true })
        .select('id, name');

      if (error) {
        logger.error({ err: error }, 'Treatment import failed');
        errors.push(`Treatments failed to import (check logs)`);
      } else {
        imported.treatments += (data || []).length;
      }
    }

    if (appointments.length) {
      // First, build lookup maps for clients and treatments
      const { data: existingClients } = await supabase
        .from('clients')
        .select('id, first_name, last_name')
        .eq('beautician_id', beauticianId);

      const { data: existingTreatments } = await supabase
        .from('treatments')
        .select('id, name')
        .eq('beautician_id', beauticianId);

      const clientLookup = {};
      (existingClients || []).forEach(c => {
        const key = `${c.first_name} ${c.last_name || ''}`.trim().toLowerCase();
        clientLookup[key] = c.id;
      });

      const treatmentLookup = {};
      (existingTreatments || []).forEach(t => {
        treatmentLookup[t.name.toLowerCase()] = t.id;
      });

      const apptRecords = [];
      for (const a of appointments) {
        // Match client by name
        const clientKey = (a.client_name || '').toLowerCase().trim();
        const clientId = clientLookup[clientKey];

        // Match treatment by service name
        const treatmentKey = (a.service || '').toLowerCase().trim();
        const treatmentId = treatmentLookup[treatmentKey];

        if (!treatmentId) continue; // Can't import appointment without treatment

        // Build starts_at from date + time
        let startsAt;
        try {
          const dateStr = a.date || '';
          const timeStr = a.time || '09:00';
          // Handle various date formats: DD/MM/YYYY, YYYY-MM-DD, MM/DD/YYYY, DD-MM-YYYY
          let parsed;
          if (dateStr.includes('/')) {
            const parts = dateStr.split('/');
            if (parts[0].length === 4) {
              parsed = new Date(`${parts[0]}-${parts[1]}-${parts[2]}`);
            } else if (parseInt(parts[1]) > 12) {
              // DD/MM/YYYY (UK format , month is second, but if > 12 it's day)
              parsed = new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
            } else {
              // Assume DD/MM/YYYY (UK format)
              parsed = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
            }
          } else {
            parsed = new Date(dateStr);
          }

          if (isNaN(parsed.getTime())) continue;

          // Attach time
          const [hours, mins] = timeStr.split(':').map(Number);
          parsed.setHours(hours || 9, mins || 0, 0, 0);
          startsAt = parsed.toISOString();
        } catch {
          continue;
        }

        // client_id is NOT NULL on the appointments table, so we cannot insert
        // an appointment we couldn't match to a client. Skip rather than crash.
        if (!clientId) continue;

        // Normalise status to the values the appointments check constraint accepts.
        // The parser emits "cancelled" but the column only allows
        // cancelled_by_client / cancelled_by_beautician.
        const rawStatus = (a.status || 'completed');
        let status = rawStatus;
        if (rawStatus === 'cancelled') status = 'cancelled_by_client';
        if (!['pending', 'confirmed', 'in_progress', 'completed',
              'cancelled_by_client', 'cancelled_by_beautician',
              'no_show', 'rescheduled'].includes(status)) {
          status = 'completed';
        }

        // ends_at is NOT NULL , derive from starts_at + duration.
        const duration = a.duration_minutes || 60;
        const endsAt = new Date(new Date(startsAt).getTime() + duration * 60000).toISOString();

        // Use beautician_notes (which exists) , there's no plain "notes" column.
        // booked_via must be one of the allowed values; "manual" is the closest fit for migrated history.
        apptRecords.push({
          beautician_id: beauticianId,
          client_id: clientId,
          treatment_id: treatmentId,
          starts_at: startsAt,
          ends_at: endsAt,
          duration_minutes: duration,
          price_cents: a.price_cents || 0,
          status,
          beautician_notes: a.staff ? `Migrated, staff: ${a.staff}` : 'Migrated from previous system',
          booked_via: 'manual',
        });
      }

      // Batch insert appointments (no upsert , historical records)
      const BATCH = 100;
      for (let i = 0; i < apptRecords.length; i += BATCH) {
        const batch = apptRecords.slice(i, i + BATCH);
        const { data, error } = await supabase
          .from('appointments')
          .insert(batch)
          .select('id');

        if (error) {
          // Fall back to row-by-row so a single bad row doesn't kill the whole batch.
          logger.warn({ err: error, batchStart: i }, 'Appointment batch insert failed, falling back row-by-row');
          for (const row of batch) {
            const { data: one, error: oneErr } = await supabase.from('appointments').insert([row]).select('id');
            if (oneErr) {
              logger.error({ err: oneErr, row: { starts_at: row.starts_at, status: row.status } }, 'Appointment row insert failed');
              errors.push(`Could not import appointment on ${row.starts_at}: ${oneErr.message}`);
            } else if (one) {
              imported.appointments += one.length;
            }
          }
        } else {
          imported.appointments += (data || []).length;
        }
      }
    }

    logger.info({ beauticianId, imported, platform }, 'Migration complete');

    res.json({
      success: true,
      platform,
      imported,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    logger.error({ err }, 'Migration execution failed');
    res.status(500).json({ error: 'Migration failed , your existing data is safe' });
  }
});

export default router;
