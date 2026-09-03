/**
 * Reading a client list somebody exported from Fresha, Timely, Treatwell or
 * a spreadsheet.
 *
 * The onboarding importer split each line on commas. "Smith, Jane" in a
 * quoted name column shifted every field after it, so half the rows landed
 * with a phone number in the email column and a surname of `Jane"`. Real
 * exports quote fields, use Windows line endings, and sometimes use
 * semicolons. This handles those, and nothing more exotic.
 */

/** Parse CSV text into rows of strings. Handles quotes, escaped quotes, CRLF, and ; delimiters. */
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  // A file with more semicolons than commas on its header line is a
  // European export; Excel writes those on a Continental locale.
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  return rows.map(r => r.map(v => v.trim()));
}

/** A UK mobile as +44..., or the value as typed if it is not obviously a UK number. */
export function normaliseUkPhone(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (/^\+44\d{10}$/.test(digits)) return digits;
  if (/^0044\d{10}$/.test(digits)) return `+44${digits.slice(4)}`;
  if (/^44\d{10}$/.test(digits)) return `+${digits}`;
  if (/^0\d{10}$/.test(digits)) return `+44${digits.slice(1)}`;
  if (/^7\d{9}$/.test(digits)) return `+44${digits}`;
  return String(raw || '').trim();
}

/**
 * Turn parsed rows into client records, finding the columns by name.
 * Returns the records plus counts of what was skipped and why, so the owner
 * is told "38 imported, 2 had no name, 1 duplicate" rather than "Imported 38".
 */
export function clientsFromCsv(rows) {
  if (!rows.length) return { clients: [], skipped: { noName: 0, duplicate: 0 }, columns: null };
  const headers = rows[0].map(h => h.toLowerCase());
  const find = (...needles) => headers.findIndex(h => needles.some(n => h.includes(n)));
  let firstIdx = find('first name', 'firstname', 'first', 'forename', 'given');
  const lastIdx = find('last name', 'lastname', 'surname', 'last', 'family');
  const fullIdx = find('full name', 'client name', 'customer name', 'name');
  const emailIdx = find('email', 'e-mail');
  const phoneIdx = find('mobile', 'phone', 'tel', 'number');
  const notesIdx = find('notes', 'note', 'comments');
  if (firstIdx < 0 && fullIdx < 0) firstIdx = 0;

  const seen = new Set();
  const clients = [];
  const skipped = { noName: 0, duplicate: 0 };
  for (const cols of rows.slice(1)) {
    let first = firstIdx >= 0 ? cols[firstIdx] || '' : '';
    let last = lastIdx >= 0 ? cols[lastIdx] || '' : '';
    if (!first && fullIdx >= 0 && cols[fullIdx]) {
      const parts = cols[fullIdx].split(/\s+/);
      first = parts.shift() || '';
      last = last || parts.join(' ');
    }
    if (!first) { skipped.noName++; continue; }
    const email = emailIdx >= 0 ? (cols[emailIdx] || '').toLowerCase() : '';
    const phone = phoneIdx >= 0 ? normaliseUkPhone(cols[phoneIdx]) : '';
    const key = phone || email || `${first.toLowerCase()}|${last.toLowerCase()}`;
    if (seen.has(key)) { skipped.duplicate++; continue; }
    seen.add(key);
    clients.push({
      first_name: first,
      last_name: last,
      email,
      phone,
      ...(notesIdx >= 0 && cols[notesIdx] ? { notes: cols[notesIdx] } : {}),
    });
  }
  return { clients, skipped, columns: { firstIdx, lastIdx, fullIdx, emailIdx, phoneIdx } };
}
