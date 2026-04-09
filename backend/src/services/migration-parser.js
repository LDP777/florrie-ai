/**
 * Migration Parser — auto-detects and parses exports from Fresha, Timely, Vagaro, or generic CSV.
 *
 * The goal is ONE UPLOAD, ONE CLICK. User drops a file, we figure out the rest.
 *
 * Detection strategy:
 *   1. Parse CSV headers
 *   2. Match against known column signatures for each platform
 *   3. Extract clients, treatments, and appointments in a normalised shape
 *
 * Each platform exports differently:
 *   - Fresha: "First Name", "Last Name", "Mobile Number", "Email", "Client Notes"
 *     Appointments: "Date", "Time", "Client", "Service", "Duration", "Price", "Status"
 *   - Timely: "First Name", "Last Name", "Phone Number", "Email", "Date of Birth", "VIP"
 *     Appointments: "Date", "Start Time", "End Time", "Customer", "Service", "Duration", "Revenue"
 *   - Vagaro: "Client First Name", "Client Last Name", "Cell Phone", "Email Address"
 *   - Generic: any CSV with recognisable column names
 */
import logger from '../lib/logger.js';

// ── Platform signatures ──────────────────────────────────

const PLATFORM_SIGNATURES = {
  fresha: {
    // Fresha uses "Mobile Number" specifically
    required: ['mobile number'],
    bonus: ['client notes', 'gender', 'fresha'],
    clientMap: {
      first_name: ['first name', 'firstname'],
      last_name: ['last name', 'lastname', 'surname'],
      email: ['email', 'email address'],
      phone: ['mobile number', 'mobile', 'phone'],
      notes: ['client notes', 'notes'],
      dob: ['date of birth', 'birthday', 'dob'],
      gender: ['gender'],
      external_id: ['client id', 'id'],
    },
    appointmentMap: {
      date: ['date', 'appointment date'],
      time: ['time', 'start time', 'appointment time'],
      client_name: ['client', 'client name', 'customer'],
      service: ['service', 'service name', 'treatment'],
      duration: ['duration', 'duration (mins)', 'duration (minutes)'],
      price: ['price', 'total', 'amount', 'service price'],
      status: ['status', 'appointment status'],
      staff: ['staff', 'staff member', 'employee'],
    },
    treatmentMap: {
      name: ['service', 'service name', 'treatment', 'treatment name'],
      price: ['price', 'service price', 'amount'],
      duration: ['duration', 'duration (mins)', 'duration (minutes)'],
      category: ['category', 'service category', 'group'],
    },
  },

  timely: {
    // Timely uses "Phone Number" and has "VIP" column
    required: ['phone number'],
    bonus: ['vip', 'date of birth', 'timely'],
    clientMap: {
      first_name: ['first name', 'firstname', 'name'],
      last_name: ['last name', 'lastname', 'surname'],
      email: ['email', 'email address'],
      phone: ['phone number', 'phone', 'mobile'],
      notes: ['notes', 'comments'],
      dob: ['date of birth', 'dob', 'birthday'],
      vip: ['vip'],
      external_id: ['customer id', 'client id', 'id'],
    },
    appointmentMap: {
      date: ['date', 'appointment date'],
      time: ['start time', 'time', 'start'],
      end_time: ['end time', 'end', 'finish'],
      client_name: ['customer', 'client', 'customer name', 'client name'],
      service: ['service', 'service name', 'treatment'],
      duration: ['duration', 'duration (mins)', 'hours'],
      price: ['revenue', 'price', 'total', 'amount'],
      status: ['status'],
      staff: ['staff', 'team member', 'employee', 'user'],
    },
    treatmentMap: {
      name: ['service', 'service name', 'treatment'],
      price: ['price', 'revenue', 'amount'],
      duration: ['duration', 'duration (mins)'],
      category: ['category', 'service category', 'group'],
    },
  },

  vagaro: {
    required: ['cell phone'],
    bonus: ['vagaro', 'client first name'],
    clientMap: {
      first_name: ['client first name', 'first name', 'firstname'],
      last_name: ['client last name', 'last name', 'lastname'],
      email: ['email address', 'email'],
      phone: ['cell phone', 'phone', 'mobile'],
      notes: ['notes', 'client notes'],
      dob: ['date of birth', 'birthday'],
      external_id: ['client id', 'id'],
    },
    appointmentMap: {
      date: ['date', 'appointment date'],
      time: ['time', 'start time'],
      client_name: ['client', 'client name'],
      service: ['service', 'service name'],
      duration: ['duration'],
      price: ['price', 'total'],
      status: ['status'],
      staff: ['staff', 'employee'],
    },
    treatmentMap: {
      name: ['service', 'service name'],
      price: ['price'],
      duration: ['duration'],
      category: ['category'],
    },
  },
};

// ── CSV Parser ──────────────────────────────────

/**
 * Parse CSV text handling quoted fields, commas inside quotes, newlines in quotes.
 */
export function parseCSV(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((char === ',' || char === '\t') && !inQuotes) {
      lines.push(current.trim());
      current = '';
      // If this was actually a newline boundary, we'd have caught it below
      continue;
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (current || lines.length) {
        lines.push(current.trim());
        current = '';
      }
      if (lines.length) {
        // We've accumulated a full row
        break; // Just kidding — we need a proper approach
      }
    } else {
      current += char;
    }
  }

  // Better approach: split properly
  return parseCSVProper(text);
}

function parseCSVProper(text) {
  // Detect delimiter
  const firstLine = text.split('\n')[0];
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const delimiter = tabCount > commaCount ? '\t' : ',';

  const rows = [];
  let current = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      current.push(field.trim());
      field = '';
    } else if ((ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) && !inQuotes) {
      current.push(field.trim());
      field = '';
      if (current.some(c => c)) rows.push(current);
      current = [];
      if (ch === '\r') i++; // skip \n after \r
    } else if (ch === '\r' && !inQuotes) {
      current.push(field.trim());
      field = '';
      if (current.some(c => c)) rows.push(current);
      current = [];
    } else {
      field += ch;
    }
  }
  // Last row
  if (field || current.length) {
    current.push(field.trim());
    if (current.some(c => c)) rows.push(current);
  }

  if (rows.length < 2) return { headers: [], rows: [] };

  const headers = rows[0];
  const dataRows = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });

  return { headers, rows: dataRows, delimiter };
}

// ── Platform Detection ──────────────────────────────────

/**
 * Detect which platform a CSV export came from.
 * Returns: { platform: 'fresha'|'timely'|'vagaro'|'generic', confidence: 0-1, fileType: 'clients'|'appointments'|'treatments' }
 */
export function detectPlatform(headers) {
  const normalised = headers.map(h => h.toLowerCase().trim());
  let bestMatch = { platform: 'generic', confidence: 0, fileType: 'clients' };

  for (const [platform, sig] of Object.entries(PLATFORM_SIGNATURES)) {
    let score = 0;
    let maxScore = sig.required.length + sig.bonus.length;

    // Check required columns
    const requiredHits = sig.required.filter(r => normalised.some(h => h.includes(r)));
    score += requiredHits.length * 2; // Required columns worth double

    // Check bonus columns
    const bonusHits = sig.bonus.filter(b => normalised.some(h => h.includes(b)));
    score += bonusHits.length;

    const confidence = score / (maxScore + sig.required.length); // normalise

    if (confidence > bestMatch.confidence) {
      bestMatch = { platform, confidence };
    }
  }

  // Detect file type: clients vs appointments vs treatments
  const hasDateCol = normalised.some(h => ['date', 'appointment date', 'start time'].includes(h));
  const hasClientCol = normalised.some(h => ['first name', 'firstname', 'client first name', 'name'].includes(h));
  const hasDurationCol = normalised.some(h => h.includes('duration'));
  const hasServiceCol = normalised.some(h => ['service', 'service name', 'treatment', 'treatment name'].includes(h));

  if (hasDateCol && (hasServiceCol || hasDurationCol)) {
    bestMatch.fileType = 'appointments';
  } else if (hasServiceCol && !hasDateCol && (hasDurationCol || normalised.some(h => h.includes('price')))) {
    bestMatch.fileType = 'treatments';
  } else {
    bestMatch.fileType = 'clients';
  }

  // If we couldn't match a specific platform, default to generic with basic mapping
  if (bestMatch.confidence < 0.3) {
    bestMatch.platform = 'generic';
  }

  return bestMatch;
}

// ── Data Extraction ──────────────────────────────────

function mapRow(row, columnMap, headers) {
  const normalised = {};
  headers.forEach(h => {
    const lower = h.toLowerCase().trim();
    normalised[lower] = row[h];
  });

  const result = {};
  for (const [field, aliases] of Object.entries(columnMap)) {
    for (const alias of aliases) {
      if (normalised[alias] !== undefined && normalised[alias] !== '') {
        result[field] = normalised[alias];
        break;
      }
    }
  }
  return result;
}

/**
 * Extract clients from parsed CSV data.
 */
export function extractClients(headers, rows, platform) {
  const sig = PLATFORM_SIGNATURES[platform] || PLATFORM_SIGNATURES.fresha;
  const map = sig.clientMap;

  // For generic, build a map from common column names
  const genericMap = {
    first_name: ['first name', 'firstname', 'first', 'name', 'client name', 'client', 'client first name'],
    last_name: ['last name', 'lastname', 'surname', 'last', 'client last name'],
    email: ['email', 'email address', 'e-mail'],
    phone: ['phone', 'mobile', 'telephone', 'phone number', 'cell', 'tel', 'cell phone', 'mobile number'],
    notes: ['notes', 'comments', 'memo', 'special notes', 'client notes'],
    dob: ['date of birth', 'birthday', 'dob'],
    external_id: ['client id', 'id', 'customer id'],
  };

  const useMap = platform === 'generic' ? genericMap : map;

  return rows.map(row => {
    const mapped = mapRow(row, useMap, headers);

    // Handle single "name" column (split into first/last)
    if (!mapped.first_name && mapped.name) {
      const parts = mapped.name.split(/\s+/);
      mapped.first_name = parts[0];
      mapped.last_name = parts.slice(1).join(' ');
    }

    // Handle "Client Name" or "Customer" column (common in appointment exports)
    if (!mapped.first_name) {
      const nameCol = headers.find(h =>
        ['client name', 'customer', 'client', 'name'].includes(h.toLowerCase().trim())
      );
      if (nameCol && row[nameCol]) {
        const parts = row[nameCol].split(/\s+/);
        mapped.first_name = parts[0];
        mapped.last_name = parts.slice(1).join(' ');
      }
    }

    return {
      first_name: (mapped.first_name || '').trim(),
      last_name: (mapped.last_name || '').trim(),
      email: (mapped.email || '').trim().toLowerCase(),
      phone: (mapped.phone || '').replace(/\s/g, ''),
      notes: (mapped.notes || '').trim(),
      dob: mapped.dob || null,
      external_id: mapped.external_id || null,
    };
  }).filter(c => c.first_name); // Must have at least a first name
}

/**
 * Extract treatments/services from parsed CSV data.
 */
export function extractTreatments(headers, rows, platform) {
  const sig = PLATFORM_SIGNATURES[platform] || PLATFORM_SIGNATURES.fresha;
  const map = sig.treatmentMap;

  const genericMap = {
    name: ['service', 'service name', 'treatment', 'treatment name'],
    price: ['price', 'service price', 'amount', 'cost', 'revenue'],
    duration: ['duration', 'duration (mins)', 'duration (minutes)', 'time', 'length'],
    category: ['category', 'service category', 'group', 'type'],
  };

  const useMap = platform === 'generic' ? genericMap : map;

  const treatments = rows.map(row => {
    const mapped = mapRow(row, useMap, headers);
    if (!mapped.name) return null;

    // Parse price — handle "£25.00", "25", "25.00", "$25"
    let priceCents = 0;
    if (mapped.price) {
      const cleaned = mapped.price.replace(/[^0-9.]/g, '');
      const parsed = parseFloat(cleaned);
      if (!isNaN(parsed)) priceCents = Math.round(parsed * 100);
    }

    // Parse duration — handle "60", "60 mins", "1h", "1:00"
    let durationMins = 0;
    if (mapped.duration) {
      const cleaned = mapped.duration.replace(/[^0-9.:h]/gi, '');
      if (cleaned.includes('h')) {
        durationMins = Math.round(parseFloat(cleaned) * 60);
      } else if (cleaned.includes(':')) {
        const [h, m] = cleaned.split(':').map(Number);
        durationMins = (h || 0) * 60 + (m || 0);
      } else {
        durationMins = parseInt(cleaned) || 0;
      }
    }

    return {
      name: mapped.name.trim(),
      price_cents: priceCents,
      duration_minutes: durationMins,
      category: (mapped.category || 'General').trim(),
    };
  }).filter(Boolean);

  // Deduplicate treatments by name
  const unique = new Map();
  for (const t of treatments) {
    const key = t.name.toLowerCase();
    if (!unique.has(key)) unique.set(key, t);
  }

  return Array.from(unique.values());
}

/**
 * Extract appointments from parsed CSV data.
 */
export function extractAppointments(headers, rows, platform) {
  const sig = PLATFORM_SIGNATURES[platform] || PLATFORM_SIGNATURES.fresha;
  const map = sig.appointmentMap;

  const genericMap = {
    date: ['date', 'appointment date', 'booking date'],
    time: ['time', 'start time', 'appointment time', 'start'],
    client_name: ['client', 'client name', 'customer', 'customer name'],
    service: ['service', 'service name', 'treatment', 'treatment name'],
    duration: ['duration', 'duration (mins)', 'duration (minutes)'],
    price: ['price', 'total', 'amount', 'revenue', 'service price'],
    status: ['status', 'appointment status', 'booking status'],
    staff: ['staff', 'staff member', 'employee', 'team member', 'user'],
  };

  const useMap = platform === 'generic' ? genericMap : map;

  return rows.map(row => {
    const mapped = mapRow(row, useMap, headers);
    if (!mapped.date || !mapped.service) return null;

    // Parse price
    let priceCents = 0;
    if (mapped.price) {
      const cleaned = mapped.price.replace(/[^0-9.]/g, '');
      const parsed = parseFloat(cleaned);
      if (!isNaN(parsed)) priceCents = Math.round(parsed * 100);
    }

    // Parse duration
    let durationMins = 0;
    if (mapped.duration) {
      const cleaned = mapped.duration.replace(/[^0-9.:h]/gi, '');
      if (cleaned.includes('h')) {
        durationMins = Math.round(parseFloat(cleaned) * 60);
      } else if (cleaned.includes(':')) {
        const [h, m] = cleaned.split(':').map(Number);
        durationMins = (h || 0) * 60 + (m || 0);
      } else {
        durationMins = parseInt(cleaned) || 0;
      }
    }

    // Parse status — normalise to Florrie statuses
    const rawStatus = (mapped.status || '').toLowerCase();
    let status = 'completed';
    if (rawStatus.includes('cancel')) status = 'cancelled';
    else if (rawStatus.includes('no show') || rawStatus.includes('noshow') || rawStatus.includes('no-show')) status = 'no_show';
    else if (rawStatus.includes('pending') || rawStatus.includes('confirm')) status = 'confirmed';

    return {
      date: mapped.date,
      time: mapped.time || '09:00',
      client_name: (mapped.client_name || '').trim(),
      service: (mapped.service || '').trim(),
      duration_minutes: durationMins,
      price_cents: priceCents,
      status,
      staff: (mapped.staff || '').trim(),
    };
  }).filter(Boolean);
}

/**
 * Master migration function — takes raw CSV text, returns everything.
 *
 * Returns: {
 *   platform: string,
 *   confidence: number,
 *   fileType: string,
 *   clients: [],
 *   treatments: [],
 *   appointments: [],
 *   summary: { clients: number, treatments: number, appointments: number }
 * }
 */
export function parseMigrationFile(csvText) {
  const { headers, rows } = parseCSVProper(csvText);

  if (!headers.length || !rows.length) {
    return { error: 'Could not parse the file. Make sure it has headers and data.' };
  }

  const detection = detectPlatform(headers);
  logger.info({ platform: detection.platform, confidence: detection.confidence, fileType: detection.fileType, rows: rows.length }, 'Migration file detected');

  const result = {
    platform: detection.platform,
    confidence: detection.confidence,
    fileType: detection.fileType,
    headers,
    rowCount: rows.length,
    clients: [],
    treatments: [],
    appointments: [],
  };

  // Extract based on file type
  if (detection.fileType === 'clients') {
    result.clients = extractClients(headers, rows, detection.platform);
  } else if (detection.fileType === 'appointments') {
    result.appointments = extractAppointments(headers, rows, detection.platform);
    // Also extract unique clients and treatments from appointment data
    const clientNames = new Set();
    result.appointments.forEach(a => {
      if (a.client_name) clientNames.add(a.client_name);
    });
    result.clients = Array.from(clientNames).map(name => {
      const parts = name.split(/\s+/);
      return { first_name: parts[0], last_name: parts.slice(1).join(' '), email: '', phone: '', notes: '' };
    });
    result.treatments = extractTreatments(headers, rows, detection.platform);
  } else if (detection.fileType === 'treatments') {
    result.treatments = extractTreatments(headers, rows, detection.platform);
  }

  result.summary = {
    clients: result.clients.length,
    treatments: result.treatments.length,
    appointments: result.appointments.length,
  };

  return result;
}
