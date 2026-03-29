import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * CSV Escaping utility
 * Properly escapes CSV fields with quotes and handles commas, newlines, quotes
 */
function escapeCSVField(field) {
  if (field === null || field === undefined) {
    return '';
  }

  const str = String(field);

  // If field contains comma, newline, or quote, wrap in quotes and escape internal quotes
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Converts an array of objects to CSV format
 */
function toCSV(data, headers) {
  if (!data || data.length === 0) {
    return headers.join(',');
  }

  const rows = [headers.join(',')];

  for (const row of data) {
    const values = headers.map(header => escapeCSVField(row[header]));
    rows.push(values.join(','));
  }

  return rows.join('\n');
}

/**
 * GET /api/exports/clients
 * Export all clients as CSV
 */
router.get('/clients', requireAuth, async (req, res) => {
  try {
    const { data: clients, error } = await supabase
      .from('clients')
      .select('*')
      .eq('beautician_id', req.beautician.id)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error({ err: error }, 'Failed to export clients');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    const headers = [
      'id',
      'first_name',
      'last_name',
      'email',
      'phone',
      'preferred_channel',
      'status',
      'notes',
      'marketing_consent',
      'health_data_consent',
      'created_at',
      'updated_at',
      'last_visit_at'
    ];

    const csv = toCSV(clients || [], headers);

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `clients-${timestamp}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error({ err }, 'Failed to generate clients export');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/exports/appointments
 * Export appointments as CSV
 * Optional query params:
 *   - from=2026-03-24 (ISO date filter)
 *   - to=2026-03-30 (ISO date filter)
 */
router.get('/appointments', requireAuth, async (req, res) => {
  try {
    let query = supabase
      .from('appointments')
      .select('*, clients(first_name, last_name, email, phone), treatments(name, duration_minutes, price_cents)')
      .eq('beautician_id', req.beautician.id)
      .order('starts_at', { ascending: true });

    if (req.query.from) {
      query = query.gte('starts_at', req.query.from);
    }
    if (req.query.to) {
      query = query.lte('starts_at', req.query.to);
    }

    const { data: appointments, error } = await query;

    if (error) {
      logger.error({ err: error }, 'Failed to export appointments');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // Flatten nested relationships for CSV
    const flattenedData = (appointments || []).map(apt => ({
      id: apt.id,
      client_name: apt.clients ? `${apt.clients.first_name} ${apt.clients.last_name || ''}`.trim() : '',
      client_email: apt.clients?.email || '',
      client_phone: apt.clients?.phone || '',
      treatment_name: apt.treatments?.name || '',
      duration_minutes: apt.treatments?.duration_minutes || '',
      price_cents: apt.treatments?.price_cents || '',
      starts_at: apt.starts_at,
      ends_at: apt.ends_at,
      status: apt.status,
      notes: apt.notes,
      created_at: apt.created_at,
      updated_at: apt.updated_at
    }));

    const headers = [
      'id',
      'client_name',
      'client_email',
      'client_phone',
      'treatment_name',
      'duration_minutes',
      'price_cents',
      'starts_at',
      'ends_at',
      'status',
      'notes',
      'created_at',
      'updated_at'
    ];

    const csv = toCSV(flattenedData, headers);

    const timestamp = new Date().toISOString().split('T')[0];
    const fromDate = req.query.from ? req.query.from.split('T')[0] : '';
    const toDate = req.query.to ? req.query.to.split('T')[0] : '';
    const dateRange = fromDate && toDate ? `-${fromDate}-to-${toDate}` : '';
    const filename = `appointments${dateRange}-${timestamp}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error({ err }, 'Failed to generate appointments export');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
