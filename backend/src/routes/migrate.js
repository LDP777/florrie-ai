/**
 * Migration Routes — one-upload, one-click import from Fresha / Timely / Vagaro / CSV.
 *
 * POST /api/migrate/preview  — parse CSV, auto-detect platform, return preview
 * POST /api/migrate/execute  — bulk insert clients + treatments + appointments
 */
import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { parseMigrationFile } from '../services/migration-parser.js';
import logger from '../lib/logger.js';

const router = Router();

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
  } else {
    return res.status(400).json({ error: 'Provide csv text or pre-parsed data' });
  }

  const errors = [];
  const imported = { clients: 0, treatments: 0, appointments: 0 };

  try {
    // ── 1. Import clients ──────────────────────────────
    if (clients.length) {
      const clientRecords = clients.map(c => ({
        beautician_id: beauticianId,
        first_name: (c.first_name || '').substring(0, 100),
        last_name: (c.last_name || '').substring(0, 100) || null,
        email: (c.email || '').substring(0, 255).toLowerCase() || null,
        phone: (c.phone || '').substring(0, 30) || null,
        notes: c.notes || null,
        imported_from: platform || 'csv',
        external_id: c.external_id || null,
        status: 'active',
      }));

      // Batch upsert — skip rows where email already exists for this beautician
      // We do it in chunks of 100 to avoid payload limits
      const BATCH = 100;
      for (let i = 0; i < clientRecords.length; i += BATCH) {
        const batch = clientRecords.slice(i, i + BATCH);
        const { data, error } = await supabase
          .from('clients')
          .upsert(batch, { onConflict: 'beautician_id,email', ignoreDuplicates: true })
          .select('id, first_name, last_name, email');

        if (error) {
          logger.error({ err: error, batch: i }, 'Client batch import failed');
          errors.push(`Client batch ${i / BATCH + 1} failed to import (check logs)`);
        } else {
          imported.clients += data.length;
        }
      }
    }

    // ── 2. Import treatments ──────────────────────────────
    if (treatments.length) {
      const treatmentRecords = treatments.map(t => ({
        beautician_id: beauticianId,
        name: (t.name || '').substring(0, 200),
        price_cents: t.price_cents || 0,
        duration_minutes: t.duration_minutes || 60,
        category: (t.category || 'General').substring(0, 100),
        active: true,
      }));

      // Upsert treatments — skip if name already exists for this beautician
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

    // ── 3. Import appointments (historical) ──────────────────────────────
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
              // DD/MM/YYYY (UK format — month is second, but if > 12 it's day)
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

        apptRecords.push({
          beautician_id: beauticianId,
          client_id: clientId || null,
          treatment_id: treatmentId,
          starts_at: startsAt,
          duration_minutes: a.duration_minutes || 60,
          price_cents: a.price_cents || 0,
          status: a.status || 'completed',
          notes: a.staff ? `Migrated — staff: ${a.staff}` : 'Migrated from previous system',
          source: 'migration',
        });
      }

      // Batch insert appointments (no upsert — historical records)
      const BATCH = 100;
      for (let i = 0; i < apptRecords.length; i += BATCH) {
        const batch = apptRecords.slice(i, i + BATCH);
        const { data, error } = await supabase
          .from('appointments')
          .insert(batch)
          .select('id');

        if (error) {
          logger.error({ err: error, batch: i }, 'Appointment batch import failed');
          errors.push(`Appointments batch ${i / BATCH + 1} failed to import (check logs)`);
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
    res.status(500).json({ error: 'Migration failed — your existing data is safe' });
  }
});

export default router;
