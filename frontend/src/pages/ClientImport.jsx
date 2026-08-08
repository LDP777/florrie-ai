import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import Icon, { iconName } from '../components/ui/Icon';
/**
 * Client Import: one-click migration from Fresha, Timely, Vagaro, or any CSV/XLSX.
 *
 * Flow:
 *   1. User picks platform (or "other")
 *   2. User uploads ONE file (csv, tsv, xls, xlsx)
 *   3. Backend auto-detects format, returns preview with warnings + skipped counts
 *   4. User can inline-edit any row before importing
 *   5. After import, user lands on /clients?just_imported=<batch_id>
 *
 * XLSX is decoded in the browser by ExcelJS, converted to CSV, then sent
 * through the existing /api/migrate/preview endpoint. This avoids a separate
 * multipart route on the backend.
 */

const PLATFORMS = [
  { id: 'fresha', name: 'Fresha', icon: 'heart', desc: 'Export, Clients, Download CSV' },
  { id: 'timely', name: 'GetTimely', icon: '⏱️', desc: 'Reports, Clients, Export' },
  { id: 'vagaro', name: 'Vagaro', icon: 'sparkles', desc: 'Customers, Export List' },
  { id: 'other', name: 'Other / CSV', icon: 'file', desc: 'Any spreadsheet or CSV file' },
];

function getToken() {
  // Supabase stores session under sb-<project-ref>-auth-token, find it by pattern
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return raw; }
}

/**
 * Read a file as ArrayBuffer for XLSX, or text for CSV.
 */
function readFile(file, asArrayBuffer) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Could not read the file'));
    if (asArrayBuffer) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  });
}

/**
 * One cell, as plain text. ExcelJS hands back rich text, formula results,
 * hyperlinks and Dates as objects, so flatten them all to something a CSV
 * parser can read.
 */
function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
    if (v.text !== undefined) return String(v.text);            // hyperlink
    if (v.result !== undefined) return String(v.result);         // formula
    if (v.error) return '';
    return '';
  }
  return String(v);
}

function csvEscape(s) {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Convert an XLSX arrayBuffer to CSV text. Picks the first sheet that has rows.
 *
 * Was SheetJS (xlsx@0.18.5), which carries 12 high-severity advisories with no
 * fixed version published to npm. ExcelJS does the same job here: we only ever
 * read an uploaded sheet and hand the rows to the existing CSV parser.
 */
async function xlsxToCsv(arrayBuffer) {
  // Loaded here rather than at module scope because ExcelJS is 940 KB minified,
  // roughly three times the whole app shell. Most imports are a CSV export from
  // Fresha or Vagaro, which never touches this function, so a static import made
  // every visitor to /import pay for a parser they were not going to use.
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(arrayBuffer);

  // First sheet with more than a header row wins, same rule as before.
  const sheet = wb.worksheets.find(w => (w.actualRowCount || w.rowCount || 0) > 1)
    || wb.worksheets[0];
  if (!sheet) return '';

  const width = sheet.actualColumnCount || sheet.columnCount || 0;
  const lines = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    for (let c = 1; c <= width; c++) cells.push(cellText(row.getCell(c)));
    if (cells.some(v => v !== '')) lines.push(cells.map(csvEscape).join(','));
  });
  return lines.join('\n');
}

export default function ClientImport() {
  const { beautician } = useBeautician();
  const navigate = useNavigate();
  const fileRef = useRef(null);

  const [step, setStep] = useState('platform'); // platform | uploading | preview | importing | done
  const [selectedPlatform, setSelectedPlatform] = useState(null);
  const [preview, setPreview] = useState(null);
  const [csvText, setCsvText] = useState('');
  const [error, setError] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [editingIndex, setEditingIndex] = useState(null);
  const [removedIdx, setRemovedIdx] = useState(new Set());

  function pickPlatform(platformId) {
    setSelectedPlatform(platformId);
    setError(null);
    // Immediately open file picker
    setTimeout(() => fileRef.current?.click(), 100);
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setStep('uploading');
    setError(null);

    const name = file.name.toLowerCase();
    const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xls');

    try {
      let text;
      if (isXlsx) {
        const buf = await readFile(file, true);
        text = await xlsxToCsv(buf);
        if (!text || text.trim().split('\n').length < 2) {
          setError('That spreadsheet looks empty. Try the file with your client list.');
          setStep('platform');
          e.target.value = '';
          return;
        }
      } else {
        text = await readFile(file, false);
      }

      setCsvText(text);

      const token = getToken();
      const res = await fetch(`${API_BASE}/api/migrate/preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ csv: text }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not parse the file');
        setStep('platform');
        return;
      }

      setPreview(data);
      setRemovedIdx(new Set());
      setEditingIndex(null);
      setStep('preview');
    } catch (err) {
      setError(err.message || 'Network error. Check your connection.');
      setStep('platform');
    } finally {
      // Reset input so same file can be re-selected
      e.target.value = '';
    }
  }

  function updateClient(i, patch) {
    setPreview(prev => {
      if (!prev) return prev;
      const next = { ...prev, clients: prev.clients.map((c, idx) => idx === i ? { ...c, ...patch } : c) };
      return next;
    });
  }

  function removeClient(i) {
    setRemovedIdx(prev => {
      const next = new Set(prev);
      next.add(i);
      return next;
    });
    if (editingIndex === i) setEditingIndex(null);
  }

  async function executeImport() {
    setStep('importing');
    setError(null);

    // Build the final clients list from the (possibly edited) preview state,
    // dropping any rows the user removed. Send pre-parsed so edits stick.
    const finalClients = preview.clients
      .map((c, i) => removedIdx.has(i) ? null : c)
      .filter(Boolean);

    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/migrate/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          clients: finalClients,
          treatments: preview.treatments || [],
          appointments: preview.appointments || [],
          platform: preview.platform || 'csv',
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Import failed');
        setStep('preview');
        return;
      }

      setImportResult(data);

      // If we got a batch ID, hop straight to the filtered Clients view so the
      // user sees what landed and can edit or undo immediately.
      if (data.batch_id) {
        navigate(`/clients?just_imported=${encodeURIComponent(data.batch_id)}&imported_at=${encodeURIComponent(data.imported_at || new Date().toISOString())}&count=${data.imported?.clients || 0}`);
        return;
      }
      setStep('done');
    } catch (err) {
      setError('Network error during import');
      setStep('preview');
    }
  }

  function reset() {
    setStep('platform');
    setSelectedPlatform(null);
    setPreview(null);
    setCsvText('');
    setError(null);
    setImportResult(null);
    setEditingIndex(null);
    setRemovedIdx(new Set());
  }

  const platformLabel = PLATFORMS.find(p => p.id === selectedPlatform)?.name || 'your file';
  const detected = preview?.platform;
  const detectedLabel = detected && detected !== 'generic'
    ? detected.charAt(0).toUpperCase() + detected.slice(1)
    : null;

  const liveClientCount = preview
    ? preview.clients.filter((_, i) => !removedIdx.has(i)).length
    : 0;
  const totalItems = preview
    ? (liveClientCount + (preview.summary.treatments || 0) + (preview.summary.appointments || 0))
    : 0;

  // Build a "skipped" summary line if the parser gave us counts.
  const skippedBits = [];
  if (preview?.skipped?.no_name) skippedBits.push(`${preview.skipped.no_name} had no name`);
  if (preview?.skipped?.duplicate_in_file) skippedBits.push(`${preview.skipped.duplicate_in_file} ${preview.skipped.duplicate_in_file === 1 ? 'was a duplicate of an earlier row' : 'were duplicates of earlier rows'} in your file`);
  const skippedTotal = (preview?.skipped?.no_name || 0) + (preview?.skipped?.duplicate_in_file || 0);

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Switch to Florrie</h1>
        <p style={styles.subtitle}>Import everything in 60 seconds</p>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.tsv,.txt,.xls,.xlsx"
        onChange={handleFile}
        style={{ display: 'none' }}
      />

      {/* Error banner */}
      {error && (
        <div style={styles.errorBanner}>
          <span style={{ fontSize: 14 }}><Icon name="alert-triangle" size={15} /></span>
          <span style={styles.errorText}>{error}</span>
        </div>
      )}

      {/* STEP 1: Platform picker */}
      {step === 'platform' && (
        <>
          <p style={styles.intro}>
            Where are your clients right now? Pick your platform and upload the export file. We handle the rest.
          </p>

          <div style={styles.platformGrid}>
            {PLATFORMS.map(p => (
              <button
                key={p.id}
                onClick={() => pickPlatform(p.id)}
                style={{ ...styles.platformCard,
                  borderColor: selectedPlatform === p.id ? 'var(--accent, #92405e)' : 'var(--border, #E8DDD4)',
                }}
              >
                <span style={styles.platformIcon}><Icon name={iconName(p.icon)} inline /></span>
                <div>
                  <div style={styles.platformName}>{p.name}</div>
                  <div style={styles.platformDesc}>{p.desc}</div>
                </div>
              </button>
            ))}
          </div>

          {/* How to export guides */}
          <div style={styles.helpCard}>
            <div style={styles.helpTitle}>How to export from your current system</div>
            <div style={styles.helpStep}><strong>Fresha:</strong> Clients, ⋯ menu, Export, Download CSV</div>
            <div style={styles.helpStep}><strong>GetTimely:</strong> Settings, Account, Data exports, Clients, CSV</div>
            <div style={styles.helpStep}><strong>Vagaro:</strong> Customers, All Customers, Export</div>
            <div style={styles.helpStep}><strong>Other:</strong> Export a CSV or Excel file with names, phones, and emails</div>
          </div>

          {/* Manual paste fallback */}
          <button onClick={() => { setSelectedPlatform('manual'); setStep('manual'); }} style={styles.textBtn}>
            Or paste names manually
          </button>
        </>
      )}

      {/* STEP: Manual paste */}
      {step === 'manual' && <ManualPaste beautician={beautician} navigate={navigate} onDone={(result) => { setImportResult(result); setStep('done'); }} onBack={reset} />}

      {/* STEP 2: Uploading / parsing */}
      {step === 'uploading' && (
        <div style={styles.centreCard}>
          <div style={styles.spinner} />
          <p style={styles.centreText}>Reading {platformLabel}...</p>
          <p style={styles.centreSub}>Auto-detecting format</p>
        </div>
      )}

      {/* STEP 3: Preview */}
      {step === 'preview' && preview && (
        <div style={styles.previewContainer}>
          {/* Detection badge */}
          {detectedLabel && (
            <div style={styles.detectedBadge}>
              Detected as <strong>{detectedLabel}</strong> export
            </div>
          )}

          {/* Warnings from the parser */}
          {preview.warnings && preview.warnings.length > 0 && (
            <div style={styles.warnBlock}>
              {preview.warnings.map((w, i) => (
                <div key={i} style={styles.warnLine}>{w}</div>
              ))}
            </div>
          )}

          {/* Nothing came through */}
          {totalItems === 0 && (
            <div style={styles.warnBlock}>
              <div style={styles.warnLine}>
                We read the file but didn't find any clients, treatments, or appointments. Make sure you exported the customer list (not bookings), then try again.
              </div>
            </div>
          )}

          {/* Summary cards */}
          <div style={styles.summaryGrid}>
            {liveClientCount > 0 && (
              <div style={styles.summaryCard}>
                <span style={styles.summaryIcon}><Icon name="user" size={15} /></span>
                <span style={styles.summaryNum}>{liveClientCount}</span>
                <span style={styles.summaryLabel}>Clients</span>
              </div>
            )}
            {preview.summary.treatments > 0 && (
              <div style={styles.summaryCard}>
                <span style={styles.summaryIcon}><Icon name="flower" size={15} /></span>
                <span style={styles.summaryNum}>{preview.summary.treatments}</span>
                <span style={styles.summaryLabel}>Treatments</span>
              </div>
            )}
            {preview.summary.appointments > 0 && (
              <div style={styles.summaryCard}>
                <span style={styles.summaryIcon}><Icon name="calendar" size={15} /></span>
                <span style={styles.summaryNum}>{preview.summary.appointments}</span>
                <span style={styles.summaryLabel}>Appointments</span>
              </div>
            )}
          </div>

          {/* Client preview list (editable) */}
          {preview.clients.length > 0 && (
            <div style={styles.previewSection}>
              <div style={styles.sectionTitle}>Client preview · tap to edit</div>
              <div style={styles.previewList}>
                {preview.clients.map((c, i) => {
                  if (removedIdx.has(i)) return null;
                  const isEditing = editingIndex === i;
                  return (
                    <div key={i} style={styles.previewRow}>
                      {isEditing ? (
                        <div style={styles.editGrid}>
                          <div style={styles.editRowTop}>
                            <div style={styles.avatar}>{(c.first_name?.[0] || '?').toUpperCase()}</div>
                            <button
                              onClick={() => removeClient(i)}
                              style={styles.removeBtn}
                              aria-label="Remove this client from the import"
                            >Remove</button>
                          </div>
                          <div style={styles.editPair}>
                            <input
                              value={c.first_name || ''}
                              onChange={e => updateClient(i, { first_name: e.target.value })}
                              placeholder="First name"
                              style={styles.editInput}
                            />
                            <input
                              value={c.last_name || ''}
                              onChange={e => updateClient(i, { last_name: e.target.value })}
                              placeholder="Last name"
                              style={styles.editInput}
                            />
                          </div>
                          <input
                            value={c.phone || ''}
                            onChange={e => updateClient(i, { phone: e.target.value })}
                            placeholder="Phone"
                            type="tel"
                            style={styles.editInput}
                          />
                          <input
                            value={c.email || ''}
                            onChange={e => updateClient(i, { email: e.target.value })}
                            placeholder="Email"
                            type="email"
                            style={styles.editInput}
                          />
                          <button onClick={() => setEditingIndex(null)} style={styles.doneBtn}>Done</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setEditingIndex(i)}
                          style={styles.previewRowBtn}
                        >
                          <div style={styles.avatar}>{(c.first_name?.[0] || '?').toUpperCase()}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={styles.clientName}>{c.first_name} {c.last_name}</div>
                            <div style={styles.clientMeta}>{c.phone || c.email || 'No contact info'}</div>
                          </div>
                          <span style={styles.pencil} aria-hidden><Icon name="edit" size={15} /></span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Treatment preview */}
          {preview.treatments.length > 0 && (
            <div style={styles.previewSection}>
              <div style={styles.sectionTitle}>Treatment preview</div>
              <div style={styles.chipGrid}>
                {preview.treatments.slice(0, 12).map((t, i) => (
                  <div key={i} style={styles.chip}>
                    {t.name}
                    {t.price_cents > 0 && <span style={styles.chipPrice}>£{(t.price_cents / 100).toFixed(0)}</span>}
                  </div>
                ))}
                {preview.treatments.length > 12 && (
                  <div style={styles.chip}>+{preview.treatments.length - 12} more</div>
                )}
              </div>
            </div>
          )}

          {/* Skipped-row footer */}
          {skippedTotal > 0 && (
            <div style={styles.skippedFooter}>
              {skippedTotal} {skippedTotal === 1 ? 'row' : 'rows'} skipped: {skippedBits.join(', ')}.
            </div>
          )}

          {/* CTA */}
          <button
            onClick={executeImport}
            disabled={totalItems === 0}
            style={{ ...styles.importBtn, opacity: totalItems === 0 ? 0.5 : 1, cursor: totalItems === 0 ? 'not-allowed' : 'pointer' }}
          >
            {totalItems === 0 ? 'Nothing to import' : `Import everything (${totalItems} items)`}
          </button>
          <button onClick={reset} style={styles.backBtn}>Start over</button>
        </div>
      )}

      {/* STEP 4: Importing */}
      {step === 'importing' && (
        <div style={styles.centreCard}>
          <div style={styles.spinner} />
          <p style={styles.centreText}>Importing into Florrie...</p>
          <p style={styles.centreSub}>This takes a few seconds</p>
        </div>
      )}

      {/* STEP 5: Done (fallback path when there's no batch_id, e.g. manual paste) */}
      {step === 'done' && importResult && (
        <div style={styles.doneCard}>
          <span style={styles.doneEmoji}><Icon name="sparkles" size={32} /></span>
          <h2 style={styles.doneTitle}>You're on Florrie now</h2>

          <div style={styles.doneStats}>
            {importResult.imported?.clients > 0 && (
              <div style={styles.doneStat}>
                <span style={styles.doneNum}>{importResult.imported.clients}</span>
                <span style={styles.doneLabel}>clients</span>
              </div>
            )}
            {importResult.imported?.treatments > 0 && (
              <div style={styles.doneStat}>
                <span style={styles.doneNum}>{importResult.imported.treatments}</span>
                <span style={styles.doneLabel}>treatments</span>
              </div>
            )}
            {importResult.imported?.appointments > 0 && (
              <div style={styles.doneStat}>
                <span style={styles.doneNum}>{importResult.imported.appointments}</span>
                <span style={styles.doneLabel}>appointments</span>
              </div>
            )}
          </div>

          {importResult.errors?.length > 0 && (
            <p style={styles.doneWarn}>
              {importResult.errors.length} item{importResult.errors.length > 1 ? 's' : ''} skipped (duplicates or missing data)
            </p>
          )}

          <p style={styles.doneDesc}>
            Florrie is already learning your clients. Booking intelligence will build up from here.
          </p>

          <div style={styles.doneActions}>
            <a href="/clients" style={styles.importBtn}>View your clients</a>
            <button onClick={reset} style={styles.backBtn}>Import more</button>
          </div>
        </div>
      )}

      {/* Timely appointment import lives below the client flow on the landing step */}
      {step === 'platform' && <TimelyAppointmentsImport />}
    </div>
  );
}

/**
 * Manual paste sub-component. Paste names from notes/contacts.
 */
function ManualPaste({ beautician, navigate, onDone, onBack }) {
  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);

  async function handleImport() {
    const lines = text.split('\n').filter(l => l.trim());
    if (!lines.length) return;

    const clients = lines.map(line => {
      const parts = line.split(/[,\-–|]+/).map(p => p.trim());
      let name = parts[0] || '';
      let phone = parts[1] || '';
      const phoneMatch = name.match(/(0\d{10,}|\+\d{10,})/);
      if (phoneMatch) { phone = phoneMatch[0]; name = name.replace(phone, '').trim(); }
      const nameParts = name.split(/\s+/);
      return {
        first_name: nameParts[0] || '',
        last_name: nameParts.slice(1).join(' ') || '',
        phone: phone.replace(/\s/g, ''),
      };
    }).filter(c => c.first_name);

    setImporting(true);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/migrate/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ clients, platform: 'manual' }),
      });
      const data = await res.json();
      if (data.batch_id && navigate) {
        navigate(`/clients?just_imported=${encodeURIComponent(data.batch_id)}&imported_at=${encodeURIComponent(data.imported_at || new Date().toISOString())}&count=${data.imported?.clients || 0}`);
        return;
      }
      onDone(data);
    } catch {
      setImporting(false);
    }
  }

  return (
    <div style={styles.manualCard}>
      <p style={styles.intro}>Paste client names, one per line. Add phone after a comma if you have it.</p>
      <div style={styles.exampleBox}>
        <div style={styles.exampleLine}>Sarah Jones, 07912345678</div>
        <div style={styles.exampleLine}>Daisy Smith</div>
        <div style={styles.exampleLine}>Chloe R - 07898765432</div>
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Paste names here..."
        style={styles.textarea}
        rows={8}
      />
      <button
        onClick={handleImport}
        disabled={!text.trim() || importing}
        style={{ ...styles.importBtn, opacity: text.trim() && !importing ? 1 : 0.5 }}
      >
        {importing ? 'Importing...' : `Import ${text.split('\n').filter(l => l.trim()).length} clients`}
      </button>
      <button onClick={onBack} style={styles.backBtn}>Back</button>
    </div>
  );
}

/* ============================================================
 * Appointments from Timely
 *
 * Parses Timely's Reports > Appointment Schedule CSV in the browser,
 * maps its (varying) column names, previews what was found, then sends
 * the rows to POST /api/import/appointments in chunks. Imported
 * appointments never send confirmations, reminders, or charge anyone.
 * ============================================================ */

/** Quote-aware CSV parser. Returns an array of rows (arrays of cells). */
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c && String(c).trim() !== ''));
}

/**
 * Map Timely's varying header names to our fields by case-insensitive
 * "contains" matching. Returns { field: columnIndex } with -1 for missing.
 */
function mapTimelyHeaders(headerRow) {
  const lower = headerRow.map(h => String(h || '').trim().toLowerCase());
  const find = (pred) => lower.findIndex(pred);
  let start = find(h => h.includes('start') && !h.includes('end'));
  if (start === -1) start = find(h => h === 'time');
  if (start === -1) start = find(h => h.includes('time') && !h.includes('end'));
  let name = find(h => h.includes('customer') || h.includes('client'));
  if (name === -1) name = find(h => h.includes('name') && !h.includes('staff') && !h.includes('service') && !h.includes('business'));
  return {
    date: find(h => h.includes('date') && !h.includes('end')),
    start_time: start,
    client_name: name,
    phone: find(h => h.includes('mobile') || h.includes('phone')),
    email: find(h => h.includes('email')),
    service: find(h => h.includes('service') || h.includes('treatment')),
    duration_minutes: find(h => h.includes('duration')),
    price: find(h => h.includes('price') || h.includes('amount') || h.includes('total')),
    staff: find(h => h.includes('staff')),
    notes: find(h => h.includes('note')),
  };
}

const TIMELY_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Light date check for the preview. Returns a local-midnight Date or null. */
function parseDateLite(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (+m[2] >= 1 && +m[2] <= 12) return new Date(year, +m[2] - 1, +m[1]);
    return null;
  }
  m = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
  if (m && TIMELY_MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) {
    return new Date(+m[3], TIMELY_MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  }
  m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && TIMELY_MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) {
    return new Date(+m[3], TIMELY_MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  }
  return null;
}

/** Light time check for the preview. True if it looks like a readable time. */
function looksLikeTime(raw) {
  return /^\d{1,2}([:.]\d{2})?(:\d{2})?\s*([AaPp]\.?[Mm]\.?)?$/.test(String(raw || '').trim());
}

function TimelyAppointmentsImport() {
  const fileRef = useRef(null);
  const [phase, setPhase] = useState('idle'); // idle | parsed | importing | done
  const [rows, setRows] = useState([]);
  const [unreadable, setUnreadable] = useState(0);
  const [pastCount, setPastCount] = useState(0);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  function resetTimely() {
    setPhase('idle');
    setRows([]);
    setUnreadable(0);
    setPastCount(0);
    setProgress({ done: 0, total: 0 });
    setResult(null);
    setError(null);
  }

  async function handleTimelyFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);

    try {
      let text;
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        const buf = await readFile(file, true);
        text = await xlsxToCsv(buf);
      } else {
        text = await readFile(file, false);
      }

      const grid = parseCsvText(text || '');
      if (grid.length < 2) {
        setError('That file looks empty. Export the Appointment Schedule report from Timely and try again.');
        return;
      }

      const cols = mapTimelyHeaders(grid[0]);
      if (cols.date === -1 || cols.client_name === -1 || cols.start_time === -1) {
        const missing = [];
        if (cols.date === -1) missing.push('a date column');
        if (cols.start_time === -1) missing.push('a start time column');
        if (cols.client_name === -1) missing.push('a customer column');
        setError(`We could not find ${missing.join(', ')} in that file. Make sure it is the Appointment Schedule report from Timely.`);
        return;
      }

      const cell = (r, idx) => (idx >= 0 && r[idx] !== undefined ? String(r[idx]).trim() : '');
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const good = [];
      let bad = 0;
      let past = 0;
      for (const r of grid.slice(1)) {
        const date = cell(r, cols.date);
        const time = cell(r, cols.start_time);
        const name = cell(r, cols.client_name);
        const parsedDate = parseDateLite(date);
        if (!parsedDate || !name || !looksLikeTime(time)) { bad++; continue; }
        if (parsedDate < today) { past++; continue; }
        good.push({
          date,
          start_time: time,
          client_name: name,
          phone: cell(r, cols.phone) || undefined,
          email: cell(r, cols.email) || undefined,
          service: cell(r, cols.service) || undefined,
          duration_minutes: cell(r, cols.duration_minutes) || undefined,
          price: cell(r, cols.price) || undefined,
          staff: cell(r, cols.staff) || undefined,
          notes: cell(r, cols.notes) || undefined,
        });
      }

      setRows(good);
      setUnreadable(bad);
      setPastCount(past);
      setPhase('parsed');
    } catch (err) {
      setError(err.message || 'Could not read that file');
    } finally {
      e.target.value = '';
    }
  }

  async function runImport() {
    setPhase('importing');
    setError(null);

    const CHUNK = 100; // backend caps at 500 per call, smaller chunks give real progress
    const totals = { imported: 0, skipped_duplicates: 0, clients_created: 0, unmatched_services: new Set(), errors: [] };
    setProgress({ done: 0, total: rows.length });

    try {
      const token = getToken();
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const res = await fetch(`${API_BASE}/api/import/appointments`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ rows: chunk }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Import failed part way through. Anything already imported is safe.');
          setPhase('parsed');
          return;
        }
        totals.imported += data.imported || 0;
        totals.skipped_duplicates += data.skipped_duplicates || 0;
        totals.clients_created += data.clients_created || 0;
        (data.unmatched_services || []).forEach(s => totals.unmatched_services.add(s));
        (data.errors || []).forEach(er => totals.errors.push({ row: (er.row || 0) + i, reason: er.reason }));
        setProgress({ done: Math.min(i + CHUNK, rows.length), total: rows.length });
      }

      setResult({
        imported: totals.imported,
        skipped_duplicates: totals.skipped_duplicates,
        clients_created: totals.clients_created,
        unmatched_services: Array.from(totals.unmatched_services),
        errors: totals.errors,
      });
      setPhase('done');
    } catch {
      setError('Network error during import. Anything already imported is safe.');
      setPhase('parsed');
    }
  }

  return (
    <div style={styles.timelySection}>
      <div style={styles.timelyDivider} />
      <h2 style={styles.timelyTitle}>Appointments from Timely</h2>
      <p style={styles.intro}>
        Bring your upcoming bookings across so your Florrie calendar is ready from day one.
        Imported appointments are view-only history: Florrie will not message anyone about them,
        and nothing gets charged.
      </p>

      <div style={styles.helpCard}>
        <div style={styles.helpTitle}>How to export from Timely</div>
        <div style={styles.helpStep}>1. In Timely, go to Reports, then Appointment Schedule</div>
        <div style={styles.helpStep}>2. Set the date range to today onwards</div>
        <div style={styles.helpStep}>3. Download the CSV and upload it here</div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.tsv,.txt,.xls,.xlsx"
        onChange={handleTimelyFile}
        style={{ display: 'none' }}
      />

      {error && (
        <div style={styles.errorBanner}>
          <span style={{ fontSize: 14 }}><Icon name="alert-triangle" size={15} /></span>
          <span style={styles.errorText}>{error}</span>
        </div>
      )}

      {phase === 'idle' && (
        <button onClick={() => fileRef.current?.click()} style={styles.timelyUploadBtn}>
          Upload appointment CSV
        </button>
      )}

      {phase === 'parsed' && (
        <div style={styles.timelyPreviewCard}>
          <div style={styles.timelyPreviewLine}>
            <strong>{rows.length}</strong> future {rows.length === 1 ? 'appointment' : 'appointments'} found
            {unreadable > 0 && <>, <strong>{unreadable}</strong> {unreadable === 1 ? 'row' : 'rows'} unreadable</>}
            {pastCount > 0 && <>, {pastCount} in the past (skipped)</>}
          </div>
          {rows.length > 0 ? (
            <>
              <div style={styles.timelyPreviewSub}>
                First up: {rows[0].client_name}{rows[0].service ? `, ${rows[0].service}` : ''} on {rows[0].date} at {rows[0].start_time}
              </div>
              <button onClick={runImport} style={styles.importBtn}>
                Import {rows.length} {rows.length === 1 ? 'appointment' : 'appointments'}
              </button>
            </>
          ) : (
            <div style={styles.timelyPreviewSub}>
              Nothing from today onwards in that file. Check the date range on the Timely report.
            </div>
          )}
          <button onClick={resetTimely} style={styles.backBtn}>Choose a different file</button>
        </div>
      )}

      {phase === 'importing' && (
        <div style={styles.timelyPreviewCard}>
          <div style={styles.timelyPreviewLine}>Importing appointments...</div>
          <div style={styles.timelyProgressTrack}>
            <div style={{ ...styles.timelyProgressFill, width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
          </div>
          <div style={styles.timelyPreviewSub}>{progress.done} of {progress.total} sent</div>
        </div>
      )}

      {phase === 'done' && result && (
        <div style={styles.timelyPreviewCard}>
          <div style={styles.timelyPreviewLine}>
            {result.imported > 0
              ? `${result.imported} ${result.imported === 1 ? 'appointment is' : 'appointments are'} now in your calendar.`
              : 'No new appointments were imported.'}
          </div>
          <div style={styles.timelyResultList}>
            {result.skipped_duplicates > 0 && (
              <div style={styles.timelyResultLine}>{result.skipped_duplicates} skipped because {result.skipped_duplicates === 1 ? 'it was' : 'they were'} already in Florrie.</div>
            )}
            {result.clients_created > 0 && (
              <div style={styles.timelyResultLine}>{result.clients_created} new {result.clients_created === 1 ? 'client was' : 'clients were'} created along the way.</div>
            )}
            {result.unmatched_services.length > 0 && (
              <div style={styles.timelyResultLine}>
                {result.unmatched_services.length} {result.unmatched_services.length === 1 ? 'service was' : 'services were'} not on your menu, so Florrie saved {result.unmatched_services.length === 1 ? 'it' : 'them'} as hidden treatments you can tidy up later: {result.unmatched_services.join(', ')}.
              </div>
            )}
            {result.errors.length > 0 && (
              <div style={styles.timelyResultLine}>
                {result.errors.length} {result.errors.length === 1 ? 'row' : 'rows'} could not be imported:
                {result.errors.slice(0, 8).map((er, i) => (
                  <div key={i} style={styles.timelyErrorLine}>Row {er.row}: {er.reason}</div>
                ))}
                {result.errors.length > 8 && <div style={styles.timelyErrorLine}>and {result.errors.length - 8} more.</div>}
              </div>
            )}
            <div style={styles.timelyResultLine}>
              No messages were sent. Imported appointments never trigger confirmations, reminders, deposits, or charges.
            </div>
          </div>
          <a href="/calendar" style={styles.importBtn}>View your calendar</a>
          <button onClick={resetTimely} style={styles.backBtn}>Import another file</button>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: 'var(--shell-viewport)',
    background: 'var(--bg, #FBF6F1)',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
    padding: '0 16px var(--scroll-pad-bottom)',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary, #241B17)',
  },
  header: { paddingTop: 8, paddingBottom: 8 },
  title: {
    fontSize: 24,
    fontWeight: 700,
    margin: '0 0 2px',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  subtitle: { fontSize: 14, color: 'var(--accent, #92405e)', margin: 0, fontWeight: 500 },
  intro: { fontSize: 13, color: 'var(--text-secondary, #574A42)', margin: '4px 0 16px', lineHeight: 1.5 },

  // Error
  errorBanner: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 14px', borderRadius: 10,
    background: 'var(--danger-bg, #F7E4E4)',
    marginBottom: 12,
  },
  errorText: { fontSize: 13, color: 'var(--danger, #9E2B32)' },

  // Parser warnings
  warnBlock: {
    padding: '10px 14px', borderRadius: 10,
    background: 'var(--warning-bg, #F7EEDD)',
    border: '1px solid var(--warning, #8A6420)',
    display: 'flex', flexDirection: 'column', gap: 6,
  },
  warnLine: { fontSize: 12, color: 'var(--warning-text, #8A6420)', lineHeight: 1.5 },

  // Platform picker
  platformGrid: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 },
  platformCard: {
    display: 'flex', alignItems: 'center', gap: 14,
    padding: '16px 18px', borderRadius: 16,
    background: 'var(--bg-card, #FFFCF9)',
    border: '2px solid var(--border, #E8DDD4)',
    cursor: 'pointer', fontFamily: 'inherit',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    textAlign: 'left',
  },
  platformIcon: { fontSize: 28, flexShrink: 0, width: 36, textAlign: 'center' },
  platformName: { fontSize: 15, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  platformDesc: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', marginTop: 2 },

  // Help card
  helpCard: {
    background: 'var(--gold-light, #ffdea4)', borderRadius: 10, padding: '14px 16px',
    marginBottom: 12,
  },
  helpTitle: { fontSize: 12, fontWeight: 700, color: 'var(--gold-text, #795f2b)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' },
  helpStep: { fontSize: 12, color: 'var(--gold-text, #795f2b)', lineHeight: 1.6 },

  textBtn: {
    display: 'block', width: '100%', textAlign: 'center',
    padding: 12, background: 'transparent', border: 'none',
    color: 'var(--accent, #92405e)', fontSize: 13, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Centre card (uploading / importing)
  centreCard: {
    textAlign: 'center', padding: 48,
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16,
    boxShadow: 'var(--elev-2)',
  },
  spinner: {
    width: 32, height: 32, border: '3px solid var(--border, #E8DDD4)',
    borderTopColor: 'var(--accent, #92405e)', borderRadius: '50%',
    margin: '0 auto 16px',
    animation: 'spin 0.8s linear infinite',
  },
  centreText: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
  centreSub: { fontSize: 12, color: 'var(--text-muted, #6B5D54)', margin: 0 },

  // Preview
  previewContainer: { display: 'flex', flexDirection: 'column', gap: 14 },
  detectedBadge: {
    padding: '8px 14px', borderRadius: 10,
    background: 'var(--success-bg, #E9F0EB)',
    color: 'var(--success, #3F7D5C)', fontSize: 13, fontWeight: 500,
  },
  summaryGrid: { display: 'flex', gap: 8 },
  summaryCard: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
    padding: '16px 8px', borderRadius: 16,
    background: 'var(--bg-card, #FFFCF9)',
    boxShadow: 'var(--elev-1)',
  },
  summaryIcon: { fontSize: 20 },
  summaryNum: { fontSize: 24, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  summaryLabel: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', fontWeight: 500 },

  previewSection: { marginTop: 4 },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 },
  previewList: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16,
    padding: '4px 14px', boxShadow: 'var(--elev-1)',
    maxHeight: 360, overflowY: 'auto',
  },
  previewRow: {
    display: 'flex', alignItems: 'stretch', gap: 10,
    padding: '8px 0',
    borderBottom: '1px solid var(--bg-hover, #f3ede9)',
  },
  previewRowBtn: {
    display: 'flex', alignItems: 'center', gap: 10,
    flex: 1, border: 'none', background: 'transparent',
    padding: 0, textAlign: 'left', cursor: 'pointer',
    fontFamily: 'inherit',
  },
  avatar: {
    width: 32, height: 32, borderRadius: 16,
    background: 'var(--accent-light, #F6E7EC)', color: 'var(--accent, #92405e)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 13, fontWeight: 700, flexShrink: 0,
  },
  clientName: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  clientMeta: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', marginTop: 1 },
  pencil: { fontSize: 14, color: 'var(--text-muted, #6B5D54)', flexShrink: 0, paddingLeft: 4 },

  // Inline-edit state
  editGrid: {
    display: 'flex', flexDirection: 'column', gap: 8,
    width: '100%', padding: '4px 0',
  },
  editRowTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  editPair: { display: 'flex', gap: 8 },
  editInput: {
    flex: 1, padding: '8px 10px', borderRadius: 10,
    border: '1.5px solid var(--border, #E8DDD4)',
    fontSize: 13, fontFamily: 'inherit', outline: 'none',
    boxSizing: 'border-box',
  },
  removeBtn: {
    padding: '4px 10px', borderRadius: 10, border: 'none',
    background: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger, #9E2B32)',
    fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },
  doneBtn: {
    padding: '8px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent-light, #F6E7EC)', color: 'var(--accent, #92405e)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },

  chipGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  chip: {
    padding: '6px 12px', borderRadius: 22,
    background: 'var(--accent-light, #F6E7EC)',
    color: 'var(--accent, #92405e)', fontSize: 12, fontWeight: 500,
    display: 'flex', alignItems: 'center', gap: 6,
  },
  chipPrice: { color: 'var(--text-muted, #6B5D54)', fontWeight: 400 },

  skippedFooter: {
    fontSize: 11, color: 'var(--text-muted, #6B5D54)',
    padding: '4px 4px 0', lineHeight: 1.5,
  },

  importBtn: {
    display: 'block', width: '100%', padding: '16px 0', borderRadius: 16,
    border: 'none', background: 'var(--accent, #92405e)', color: '#fff',
    fontSize: 16, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'center', textDecoration: 'none',
    boxShadow: 'var(--elev-2)',
  },
  backBtn: {
    display: 'block', width: '100%', padding: '14px 0', borderRadius: 10,
    border: 'none', background: 'var(--bg-hover, #f3ede9)', color: 'var(--text-muted, #6B5D54)',
    fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center',
  },

  // Done
  doneCard: {
    textAlign: 'center', padding: '40px 20px',
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16,
    boxShadow: 'var(--elev-2)',
  },
  doneEmoji: { fontSize: 48, display: 'block', marginBottom: 8 },
  doneTitle: {
    fontSize: 22, fontWeight: 700, margin: '0 0 16px',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  doneStats: { display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 16 },
  doneStat: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  doneNum: { fontSize: 28, fontWeight: 700, color: 'var(--accent, #92405e)' },
  doneLabel: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', fontWeight: 500 },
  doneWarn: { fontSize: 12, color: 'var(--warning, #8A6420)', margin: '0 0 12px' },
  doneDesc: { fontSize: 13, color: 'var(--text-secondary, #574A42)', margin: '0 0 20px', lineHeight: 1.5 },
  doneActions: { display: 'flex', flexDirection: 'column', gap: 8 },

  // Manual paste
  manualCard: { display: 'flex', flexDirection: 'column', gap: 12 },
  exampleBox: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 10, padding: 12,
    boxShadow: 'var(--elev-1)',
  },
  exampleLine: { fontSize: 12, color: 'var(--text-muted, #6B5D54)', fontFamily: 'monospace', lineHeight: 1.8 },
  textarea: {
    width: '100%', padding: 14, borderRadius: 10,
    border: '1.5px solid var(--border, #E8DDD4)',
    fontSize: 14, fontFamily: 'inherit', resize: 'vertical',
    outline: 'none', lineHeight: 1.6, boxSizing: 'border-box',
  },

  // Timely appointment import
  timelySection: { marginTop: 32, display: 'flex', flexDirection: 'column', gap: 12 },
  timelyDivider: { height: 1, background: 'var(--border, #E8DDD4)', marginBottom: 4 },
  timelyTitle: {
    fontSize: 19, fontWeight: 700, margin: 0,
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  timelyUploadBtn: {
    display: 'block', width: '100%', padding: '14px 0', borderRadius: 16,
    border: '2px solid var(--accent, #92405e)', background: 'transparent',
    color: 'var(--accent, #92405e)', fontSize: 15, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center',
  },
  timelyPreviewCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16,
    padding: '16px 18px', boxShadow: 'var(--elev-1)',
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  timelyPreviewLine: { fontSize: 14, color: 'var(--text-primary, #241B17)', lineHeight: 1.5 },
  timelyPreviewSub: { fontSize: 12, color: 'var(--text-muted, #6B5D54)', lineHeight: 1.5 },
  timelyProgressTrack: {
    height: 8, borderRadius: 6, background: 'var(--bg-hover, #f3ede9)', overflow: 'hidden',
  },
  timelyProgressFill: {
    height: '100%', borderRadius: 6, background: 'var(--accent, #92405e)',
    transition: 'width 0.3s ease',
  },
  timelyResultList: { display: 'flex', flexDirection: 'column', gap: 8 },
  timelyResultLine: { fontSize: 13, color: 'var(--text-secondary, #574A42)', lineHeight: 1.5 },
  timelyErrorLine: { fontSize: 12, color: 'var(--danger, #9E2B32)', lineHeight: 1.6, paddingLeft: 8 },
};
