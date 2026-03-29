import { useState, useRef } from 'react';
import { useBeautician, insertRow, isDevMode } from '../lib/supabase.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Client Import — migrate from Timely, Fresha, or a spreadsheet.
 *
 * Two modes:
 *   1. CSV upload — parse file, map columns, preview, import
 *   2. Manual bulk — paste names/phones from notes app
 *
 * CSV mapping handles common salon software exports:
 *   Timely, Fresha, Vagaro, Square, generic CSV
 */

const COLUMN_MAPS = {
  first_name: ['first name', 'firstname', 'first', 'name', 'client name', 'client'],
  last_name: ['last name', 'lastname', 'surname', 'last'],
  email: ['email', 'email address', 'e-mail'],
  phone: ['phone', 'mobile', 'telephone', 'phone number', 'cell', 'tel'],
  notes: ['notes', 'comments', 'memo', 'special notes'],
};

function guessColumn(header) {
  const h = header.toLowerCase().trim();
  for (const [field, aliases] of Object.entries(COLUMN_MAPS)) {
    if (aliases.includes(h)) return field;
  }
  return null;
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  // Detect delimiter
  const firstLine = lines[0];
  const delimiter = firstLine.includes('\t') ? '\t' : ',';

  const headers = firstLine.split(delimiter).map(h => h.replace(/^"|"$/g, '').trim());
  const rows = lines.slice(1).map(line => {
    const cells = line.split(delimiter).map(c => c.replace(/^"|"$/g, '').trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] || ''; });
    return obj;
  }).filter(row => Object.values(row).some(v => v));

  return { headers, rows };
}

export default function ClientImport() {
  const { beautician } = useBeautician();
  const [mode, setMode] = useState(null); // null | 'csv' | 'manual'
  const [step, setStep] = useState('upload'); // upload | map | preview | importing | done
  const fileRef = useRef(null);

  // CSV state
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [csvRows, setCsvRows] = useState([]);
  const [columnMap, setColumnMap] = useState({});
  const [importCount, setImportCount] = useState(0);

  // Manual state
  const [bulkText, setBulkText] = useState('');
  const [manualParsed, setManualParsed] = useState([]);

  // Progress
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errors, setErrors] = useState([]);

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const { headers, rows } = parseCSV(text);

      if (headers.length === 0 || rows.length === 0) {
        setErrors(['Could not parse the file. Make sure it\'s a CSV with headers.']);
        return;
      }

      setCsvHeaders(headers);
      setCsvRows(rows);

      // Auto-map columns
      const autoMap = {};
      headers.forEach(h => {
        const field = guessColumn(h);
        if (field) autoMap[h] = field;
      });
      setColumnMap(autoMap);
      setStep('map');
    };
    reader.readAsText(file);
  }

  function getMappedClients() {
    const reverseMap = {};
    Object.entries(columnMap).forEach(([csvCol, field]) => {
      if (field) reverseMap[field] = csvCol;
    });

    return csvRows.map(row => ({
      first_name: row[reverseMap.first_name] || '',
      last_name: row[reverseMap.last_name] || '',
      email: row[reverseMap.email] || '',
      phone: row[reverseMap.phone] || '',
      notes: row[reverseMap.notes] || '',
    })).filter(c => c.first_name.trim());
  }

  function parseManualText() {
    const lines = bulkText.split('\n').filter(l => l.trim());
    const parsed = lines.map(line => {
      // Try to extract name and phone from various formats:
      // "Sarah Jones 07xxx", "Sarah Jones, 07xxx", "Sarah - 07xxx"
      const parts = line.split(/[,\-–|]+/).map(p => p.trim());
      let name = parts[0] || '';
      let phone = parts[1] || '';

      // If phone looks like it's in the name part
      const phoneMatch = name.match(/(0\d{10,}|\+\d{10,})/);
      if (phoneMatch) {
        phone = phoneMatch[0];
        name = name.replace(phone, '').trim();
      }

      const nameParts = name.split(/\s+/);
      return {
        first_name: nameParts[0] || '',
        last_name: nameParts.slice(1).join(' ') || '',
        phone: phone.replace(/\s/g, ''),
        email: '',
        notes: '',
      };
    }).filter(c => c.first_name);

    setManualParsed(parsed);
    setStep('preview');
  }

  async function handleImport(clients) {
    setImporting(true);
    setProgress(0);
    setErrors([]);
    let imported = 0;
    const errs = [];

    for (let i = 0; i < clients.length; i++) {
      try {
        await insertRow('clients', {
          ...clients[i],
          beautician_id: beautician.id,
          status: 'active',
        });
        imported++;
      } catch (err) {
        errs.push(`Row ${i + 1}: ${err.message || 'Failed'}`);
      }
      setProgress(Math.round(((i + 1) / clients.length) * 100));
    }

    setImportCount(imported);
    setErrors(errs);
    setImporting(false);
    setStep('done');
  }

  const previewClients = mode === 'csv' ? getMappedClients() : manualParsed;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Import Clients</h1>
        <p style={styles.subtitle}>Migrate from anywhere</p>
      </div>

      {/* Mode selection */}
      {!mode && (
        <div style={styles.modeGrid}>
          <button onClick={() => { setMode('csv'); setStep('upload'); }} style={styles.modeCard}>
            <span style={{ fontSize: 28 }}>📄</span>
            <span style={styles.modeLabel}>Upload CSV</span>
            <span style={styles.modeDesc}>From Timely, Fresha, Vagaro, or any spreadsheet</span>
          </button>

          <button onClick={() => { setMode('manual'); setStep('upload'); }} style={styles.modeCard}>
            <span style={{ fontSize: 28 }}>📝</span>
            <span style={styles.modeLabel}>Paste names</span>
            <span style={styles.modeDesc}>Copy from your notes, contacts, or DMs</span>
          </button>
        </div>
      )}

      {/* Steps indicator */}
      {mode && step !== 'done' && (
        <div style={styles.steps}>
          {(mode === 'csv' ? ['Upload', 'Map', 'Preview', 'Import'] : ['Paste', 'Preview', 'Import']).map((s, i) => {
            const stepIndex = mode === 'csv'
              ? ['upload', 'map', 'preview', 'importing'].indexOf(step)
              : ['upload', 'preview', 'importing'].indexOf(step);
            return (
              <div key={s} style={styles.stepItem}>
                <div style={{
                  ...styles.stepDot,
                  background: i <= stepIndex ? 'var(--accent, #C76B8A)' : '#E0DBD5',
                }} />
                <span style={{
                  ...styles.stepLabel,
                  color: i <= stepIndex ? 'var(--accent, #C76B8A)' : 'var(--text-muted, var(--text-muted, #B5AFA8))',
                }}>{s}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* CSV Upload */}
      {mode === 'csv' && step === 'upload' && (
        <div style={styles.uploadCard}>
          <div style={styles.dropZone} onClick={() => fileRef.current?.click()}>
            <span style={{ fontSize: 32 }}>📂</span>
            <span style={styles.dropText}>Tap to select a CSV file</span>
            <span style={styles.dropHint}>Exports from Timely, Fresha, Vagaro, or any spreadsheet</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />

          {errors.length > 0 && (
            <div style={styles.errorCard}>
              {errors.map((e, i) => <p key={i} style={styles.errorText}>{e}</p>)}
            </div>
          )}

          <button onClick={() => setMode(null)} style={styles.backBtn}>Back</button>
        </div>
      )}

      {/* CSV Column mapping */}
      {mode === 'csv' && step === 'map' && (
        <div style={styles.mapCard}>
          <p style={styles.mapIntro}>
            Found {csvRows.length} client{csvRows.length !== 1 ? 's' : ''} and {csvHeaders.length} columns.
            Map each column to a florrie.ai field:
          </p>

          {csvHeaders.map(header => (
            <div key={header} style={styles.mapRow}>
              <span style={styles.mapHeader}>{header}</span>
              <select
                value={columnMap[header] || ''}
                onChange={e => setColumnMap(prev => ({ ...prev, [header]: e.target.value }))}
                style={styles.mapSelect}
              >
                <option value="">Skip</option>
                <option value="first_name">First name</option>
                <option value="last_name">Last name</option>
                <option value="email">Email</option>
                <option value="phone">Phone</option>
                <option value="notes">Notes</option>
              </select>
            </div>
          ))}

          <div style={styles.mapActions}>
            <button
              onClick={() => setStep('preview')}
              disabled={!Object.values(columnMap).includes('first_name')}
              style={{
                ...styles.primaryBtn,
                opacity: Object.values(columnMap).includes('first_name') ? 1 : 0.5,
              }}
            >
              Preview ({getMappedClients().length} clients)
            </button>
            <button onClick={() => setStep('upload')} style={styles.backBtn}>Back</button>
          </div>
        </div>
      )}

      {/* Manual paste */}
      {mode === 'manual' && step === 'upload' && (
        <div style={styles.manualCard}>
          <p style={styles.manualIntro}>
            Paste client names, one per line. Add phone numbers after a comma if you have them.
          </p>
          <div style={styles.manualExamples}>
            <span style={styles.exampleLabel}>Examples:</span>
            <span style={styles.exampleText}>Sarah Jones, 07912345678</span>
            <span style={styles.exampleText}>Daisy Smith</span>
            <span style={styles.exampleText}>Chloe R - 07898765432</span>
          </div>
          <textarea
            value={bulkText}
            onChange={e => setBulkText(e.target.value)}
            placeholder="Paste names here..."
            style={styles.manualTextarea}
            rows={8}
          />
          <div style={styles.mapActions}>
            <button
              onClick={parseManualText}
              disabled={!bulkText.trim()}
              style={{
                ...styles.primaryBtn,
                opacity: bulkText.trim() ? 1 : 0.5,
              }}
            >
              Parse & Preview
            </button>
            <button onClick={() => setMode(null)} style={styles.backBtn}>Back</button>
          </div>
        </div>
      )}

      {/* Preview */}
      {step === 'preview' && (
        <div style={styles.previewCard}>
          <p style={styles.previewIntro}>
            {previewClients.length} client{previewClients.length !== 1 ? 's' : ''} ready to import:
          </p>

          <div style={styles.previewList}>
            {previewClients.slice(0, 20).map((c, i) => (
              <div key={i} style={styles.previewRow}>
                <div style={styles.previewAvatar}>{(c.first_name[0] || '?').toUpperCase()}</div>
                <div style={{ flex: 1 }}>
                  <span style={styles.previewName}>{c.first_name} {c.last_name}</span>
                  {(c.phone || c.email) && (
                    <span style={styles.previewMeta}>{c.phone || c.email}</span>
                  )}
                </div>
              </div>
            ))}
            {previewClients.length > 20 && (
              <p style={styles.previewMore}>+ {previewClients.length - 20} more</p>
            )}
          </div>

          <div style={styles.mapActions}>
            <button
              onClick={() => handleImport(previewClients)}
              style={styles.primaryBtn}
            >
              Import {previewClients.length} clients
            </button>
            <button onClick={() => setStep(mode === 'csv' ? 'map' : 'upload')} style={styles.backBtn}>Back</button>
          </div>
        </div>
      )}

      {/* Importing progress */}
      {step === 'importing' && importing && (
        <div style={styles.progressCard}>
          <span style={{ fontSize: 32, display: 'block', marginBottom: 12 }}>⏳</span>
          <p style={styles.progressText}>Importing clients...</p>
          <div style={styles.progressBarTrack}>
            <div style={{ ...styles.progressBarFill, width: `${progress}%` }} />
          </div>
          <span style={styles.progressPct}>{progress}%</span>
        </div>
      )}

      {/* Done */}
      {step === 'done' && (
        <div style={styles.doneCard}>
          <span style={{ fontSize: 40, display: 'block', marginBottom: 12 }}>🎉</span>
          <h2 style={styles.doneTitle}>{importCount} client{importCount !== 1 ? 's' : ''} imported</h2>
          {errors.length > 0 && (
            <p style={styles.doneErrors}>{errors.length} skipped due to errors</p>
          )}
          <p style={styles.doneDesc}>
            They're now in your client list. florrie.ai will start building profiles as they book.
          </p>
          <button
            onClick={() => { setMode(null); setStep('upload'); setCsvHeaders([]); setCsvRows([]); setColumnMap({}); setBulkText(''); setManualParsed([]); }}
            style={styles.primaryBtn}
          >
            Import more
          </button>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--bg, var(--bg, #FAF8F5))', fontFamily: '"DM Sans", -apple-system, sans-serif', padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary, #2D2A26)' },
  header: { paddingTop: 28, paddingBottom: 12 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent, #C76B8A)', margin: 0, fontWeight: 500 },

  modeGrid: { display: 'flex', flexDirection: 'column', gap: 10 },
  modeCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
    padding: 24, borderRadius: 14, background: 'var(--bg-card, #fff)', border: 'none',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', cursor: 'pointer', fontFamily: 'inherit',
  },
  modeLabel: { fontSize: 16, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  modeDesc: { fontSize: 12, color: '#8A8580', textAlign: 'center', lineHeight: 1.4 },

  steps: { display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))' },
  stepItem: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 },
  stepDot: { width: 8, height: 8, borderRadius: 4 },
  stepLabel: { fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },

  uploadCard: { display: 'flex', flexDirection: 'column', gap: 12 },
  dropZone: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
    padding: 40, borderRadius: 14, border: '2px dashed #E0DBD5',
    cursor: 'pointer', background: 'var(--bg-card, #fff)',
  },
  dropText: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  dropHint: { fontSize: 11, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', textAlign: 'center' },

  errorCard: { background: '#FEF2F2', borderRadius: 10, padding: 12 },
  errorText: { fontSize: 12, color: '#E57373', margin: '0 0 4px' },

  mapCard: { display: 'flex', flexDirection: 'column', gap: 10 },
  mapIntro: { fontSize: 13, color: '#5A5550', margin: 0, lineHeight: 1.5 },
  mapRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'var(--bg-card, #fff)', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  mapHeader: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  mapSelect: { padding: '6px 10px', borderRadius: 8, border: '1.5px solid var(--border, var(--border, var(--border, #EDE9E4)))', fontSize: 12, fontFamily: 'inherit', background: 'var(--bg-card, #fff)', color: 'var(--text-primary, #2D2A26)' },
  mapActions: { display: 'flex', gap: 8, marginTop: 4 },

  manualCard: { display: 'flex', flexDirection: 'column', gap: 12 },
  manualIntro: { fontSize: 13, color: '#5A5550', margin: 0, lineHeight: 1.5 },
  manualExamples: { background: 'var(--bg-card, #fff)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 4, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  exampleLabel: { fontSize: 10, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', textTransform: 'uppercase', letterSpacing: '0.04em' },
  exampleText: { fontSize: 12, color: '#8A8580', fontFamily: 'monospace' },
  manualTextarea: { width: '100%', padding: 14, borderRadius: 12, border: '1.5px solid var(--border, var(--border, var(--border, #EDE9E4)))', fontSize: 14, fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.6, boxSizing: 'border-box' },

  previewCard: { display: 'flex', flexDirection: 'column', gap: 10 },
  previewIntro: { fontSize: 13, color: '#5A5550', margin: 0 },
  previewList: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: '8px 14px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)', maxHeight: 340, overflowY: 'auto' },
  previewRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--bg-hover, var(--bg-subtle, #F5F2EF))' },
  previewAvatar: { width: 30, height: 30, borderRadius: 15, background: 'var(--accent-light, #FFF0F3)', color: 'var(--accent, #C76B8A)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 },
  previewName: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  previewMeta: { display: 'block', fontSize: 11, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },
  previewMore: { textAlign: 'center', fontSize: 12, color: 'var(--accent, #C76B8A)', padding: 8, margin: 0 },

  progressCard: { textAlign: 'center', padding: 40, background: 'var(--bg-card, #fff)', borderRadius: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  progressText: { fontSize: 14, color: '#5A5550', margin: '0 0 16px' },
  progressBarTrack: { height: 6, borderRadius: 3, background: 'var(--bg-hover, var(--bg-subtle, #F5F2EF))', overflow: 'hidden' },
  progressBarFill: { height: '100%', borderRadius: 3, background: 'var(--accent, #C76B8A)', transition: 'width 0.3s ease' },
  progressPct: { display: 'block', fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', marginTop: 8 },

  doneCard: { textAlign: 'center', padding: 40, background: 'var(--bg-card, #fff)', borderRadius: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  doneTitle: { fontSize: 20, fontWeight: 700, margin: '0 0 4px' },
  doneErrors: { fontSize: 12, color: '#E57373', margin: '0 0 8px' },
  doneDesc: { fontSize: 13, color: '#8A8580', margin: '0 0 20px', lineHeight: 1.5 },

  primaryBtn: { flex: 1, padding: '14px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  backBtn: { padding: '14px 20px', borderRadius: 12, border: 'none', background: 'var(--bg-hover, var(--bg-subtle, #F5F2EF))', color: '#8A8580', fontSize: 15, cursor: 'pointer', fontFamily: 'inherit' },
};
