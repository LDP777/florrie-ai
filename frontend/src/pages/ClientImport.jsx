import { useState, useRef } from 'react';
import { useBeautician } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';

/**
 * Client Import — one-click migration from Fresha, Timely, Vagaro, or any CSV.
 *
 * Flow:
 *   1. User picks platform (or "other")
 *   2. User uploads ONE file
 *   3. Backend auto-detects format, returns preview
 *   4. User sees summary → presses "Import everything"
 *   5. Done — all clients, treatments, and appointments land in Florrie
 *
 * This is the #1 onboarding selling point: "Switch in 60 seconds."
 */

const PLATFORMS = [
  { id: 'fresha', name: 'Fresha', icon: '💜', desc: 'Export → Clients → Download CSV' },
  { id: 'timely', name: 'GetTimely', icon: '⏱️', desc: 'Reports → Clients → Export' },
  { id: 'vagaro', name: 'Vagaro', icon: '💅', desc: 'Customers → Export List' },
  { id: 'other', name: 'Other / CSV', icon: '📄', desc: 'Any spreadsheet or CSV file' },
];

function getToken() {
  // Supabase stores session under sb-<project-ref>-auth-token — find it by pattern
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return raw; }
}

export default function ClientImport() {
  const { beautician } = useBeautician();
  const fileRef = useRef(null);

  const [step, setStep] = useState('platform'); // platform | uploading | preview | importing | done
  const [selectedPlatform, setSelectedPlatform] = useState(null);
  const [preview, setPreview] = useState(null);
  const [csvText, setCsvText] = useState('');
  const [error, setError] = useState(null);
  const [importResult, setImportResult] = useState(null);

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

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target.result;
      setCsvText(text);

      try {
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
        setStep('preview');
      } catch (err) {
        setError('Network error — check your connection');
        setStep('platform');
      }
    };
    reader.readAsText(file);
    // Reset input so same file can be re-selected
    e.target.value = '';
  }

  async function executeImport() {
    setStep('importing');
    setError(null);

    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/migrate/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ csv: csvText }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Import failed');
        setStep('preview');
        return;
      }

      setImportResult(data);
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
  }

  const platformLabel = PLATFORMS.find(p => p.id === selectedPlatform)?.name || 'your file';
  const detected = preview?.platform;
  const detectedLabel = detected && detected !== 'generic'
    ? detected.charAt(0).toUpperCase() + detected.slice(1)
    : null;

  const totalItems = preview
    ? (preview.summary.clients + preview.summary.treatments + preview.summary.appointments)
    : 0;

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
          <span style={{ fontSize: 14 }}>⚠️</span>
          <span style={styles.errorText}>{error}</span>
        </div>
      )}

      {/* ── STEP 1: Platform picker ── */}
      {step === 'platform' && (
        <>
          <p style={styles.intro}>
            Where are your clients right now? Pick your platform and upload the export file — we handle the rest.
          </p>

          <div style={styles.platformGrid}>
            {PLATFORMS.map(p => (
              <button
                key={p.id}
                onClick={() => pickPlatform(p.id)}
                style={{
                  ...styles.platformCard,
                  borderColor: selectedPlatform === p.id ? 'var(--accent, #C76B8A)' : 'var(--border, #EDE9E4)',
                }}
              >
                <span style={styles.platformIcon}>{p.icon}</span>
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
            <div style={styles.helpStep}><strong>Fresha:</strong> Clients → ⋯ menu → Export → Download CSV</div>
            <div style={styles.helpStep}><strong>GetTimely:</strong> Settings → Account → Data exports → Clients → CSV</div>
            <div style={styles.helpStep}><strong>Vagaro:</strong> Customers → All Customers → Export</div>
            <div style={styles.helpStep}><strong>Other:</strong> Export a CSV with names, phones, and emails</div>
          </div>

          {/* Manual paste fallback */}
          <button onClick={() => { setSelectedPlatform('manual'); setStep('manual'); }} style={styles.textBtn}>
            Or paste names manually
          </button>
        </>
      )}

      {/* ── STEP: Manual paste ── */}
      {step === 'manual' && <ManualPaste beautician={beautician} onDone={(result) => { setImportResult(result); setStep('done'); }} onBack={reset} />}

      {/* ── STEP 2: Uploading / parsing ── */}
      {step === 'uploading' && (
        <div style={styles.centreCard}>
          <div style={styles.spinner} />
          <p style={styles.centreText}>Reading {platformLabel}...</p>
          <p style={styles.centreSub}>Auto-detecting format</p>
        </div>
      )}

      {/* ── STEP 3: Preview ── */}
      {step === 'preview' && preview && (
        <div style={styles.previewContainer}>
          {/* Detection badge */}
          {detectedLabel && (
            <div style={styles.detectedBadge}>
              ✓ Detected as <strong>{detectedLabel}</strong> export
            </div>
          )}

          {/* Summary cards */}
          <div style={styles.summaryGrid}>
            {preview.summary.clients > 0 && (
              <div style={styles.summaryCard}>
                <span style={styles.summaryIcon}>👤</span>
                <span style={styles.summaryNum}>{preview.summary.clients}</span>
                <span style={styles.summaryLabel}>Clients</span>
              </div>
            )}
            {preview.summary.treatments > 0 && (
              <div style={styles.summaryCard}>
                <span style={styles.summaryIcon}>💆</span>
                <span style={styles.summaryNum}>{preview.summary.treatments}</span>
                <span style={styles.summaryLabel}>Treatments</span>
              </div>
            )}
            {preview.summary.appointments > 0 && (
              <div style={styles.summaryCard}>
                <span style={styles.summaryIcon}>📅</span>
                <span style={styles.summaryNum}>{preview.summary.appointments}</span>
                <span style={styles.summaryLabel}>Appointments</span>
              </div>
            )}
          </div>

          {/* Client preview list */}
          {preview.clients.length > 0 && (
            <div style={styles.previewSection}>
              <div style={styles.sectionTitle}>Client preview</div>
              <div style={styles.previewList}>
                {preview.clients.slice(0, 8).map((c, i) => (
                  <div key={i} style={styles.previewRow}>
                    <div style={styles.avatar}>{(c.first_name?.[0] || '?').toUpperCase()}</div>
                    <div style={{ flex: 1 }}>
                      <div style={styles.clientName}>{c.first_name} {c.last_name}</div>
                      <div style={styles.clientMeta}>{c.phone || c.email || 'No contact info'}</div>
                    </div>
                  </div>
                ))}
                {preview.clients.length > 8 && (
                  <div style={styles.moreLabel}>+ {preview.clients.length - 8} more</div>
                )}
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

          {/* CTA */}
          <button onClick={executeImport} style={styles.importBtn}>
            Import everything ({totalItems} items)
          </button>
          <button onClick={reset} style={styles.backBtn}>Start over</button>
        </div>
      )}

      {/* ── STEP 4: Importing ── */}
      {step === 'importing' && (
        <div style={styles.centreCard}>
          <div style={styles.spinner} />
          <p style={styles.centreText}>Importing into Florrie...</p>
          <p style={styles.centreSub}>This takes a few seconds</p>
        </div>
      )}

      {/* ── STEP 5: Done ── */}
      {step === 'done' && importResult && (
        <div style={styles.doneCard}>
          <span style={styles.doneEmoji}>🎉</span>
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
    </div>
  );
}

/**
 * Manual paste sub-component — paste names from notes/contacts.
 */
function ManualPaste({ beautician, onDone, onBack }) {
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

const styles = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg, #FAF8F5)',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
    padding: '0 16px 40px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary, #2D2A26)',
  },
  header: { paddingTop: 28, paddingBottom: 8 },
  title: {
    fontSize: 24,
    fontWeight: 700,
    margin: '0 0 2px',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  subtitle: { fontSize: 14, color: 'var(--accent, #C76B8A)', margin: 0, fontWeight: 500 },
  intro: { fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', margin: '4px 0 16px', lineHeight: 1.5 },

  // Error
  errorBanner: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 14px', borderRadius: 10,
    background: 'var(--danger-bg, #FDF0EF)',
    marginBottom: 12,
  },
  errorText: { fontSize: 13, color: 'var(--danger, #D4605C)' },

  // Platform picker
  platformGrid: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 },
  platformCard: {
    display: 'flex', alignItems: 'center', gap: 14,
    padding: '16px 18px', borderRadius: 14,
    background: 'var(--bg-card, #fff)',
    border: '2px solid var(--border, #EDE9E4)',
    cursor: 'pointer', fontFamily: 'inherit',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    textAlign: 'left',
  },
  platformIcon: { fontSize: 28, flexShrink: 0, width: 36, textAlign: 'center' },
  platformName: { fontSize: 15, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  platformDesc: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)', marginTop: 2 },

  // Help card
  helpCard: {
    background: 'var(--gold-light, #FDF8EE)', borderRadius: 12, padding: '14px 16px',
    marginBottom: 12,
  },
  helpTitle: { fontSize: 12, fontWeight: 700, color: 'var(--gold-text, #8A7245)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' },
  helpStep: { fontSize: 12, color: 'var(--gold-text, #8A7245)', lineHeight: 1.6 },

  textBtn: {
    display: 'block', width: '100%', textAlign: 'center',
    padding: 12, background: 'transparent', border: 'none',
    color: 'var(--accent, #C76B8A)', fontSize: 13, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Centre card (uploading / importing)
  centreCard: {
    textAlign: 'center', padding: 48,
    background: 'var(--bg-card, #fff)', borderRadius: 16,
    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
  },
  spinner: {
    width: 32, height: 32, border: '3px solid var(--border, #EDE9E4)',
    borderTopColor: 'var(--accent, #C76B8A)', borderRadius: '50%',
    margin: '0 auto 16px',
    animation: 'spin 0.8s linear infinite',
  },
  centreText: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
  centreSub: { fontSize: 12, color: 'var(--text-muted, #B5AFA8)', margin: 0 },

  // Preview
  previewContainer: { display: 'flex', flexDirection: 'column', gap: 14 },
  detectedBadge: {
    padding: '8px 14px', borderRadius: 10,
    background: 'var(--success-bg, #E8F5E9)',
    color: 'var(--success, #5BA97B)', fontSize: 13, fontWeight: 500,
  },
  summaryGrid: { display: 'flex', gap: 8 },
  summaryCard: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
    padding: '16px 8px', borderRadius: 14,
    background: 'var(--bg-card, #fff)',
    boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
  },
  summaryIcon: { fontSize: 20 },
  summaryNum: { fontSize: 24, fontWeight: 700, color: 'var(--text-primary, #2D2A26)' },
  summaryLabel: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)', fontWeight: 500 },

  previewSection: { marginTop: 4 },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: 'var(--text-muted, #B5AFA8)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 },
  previewList: {
    background: 'var(--bg-card, #fff)', borderRadius: 14,
    padding: '4px 14px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
  },
  previewRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '10px 0',
    borderBottom: '1px solid var(--bg-hover, #F5F2EF)',
  },
  avatar: {
    width: 32, height: 32, borderRadius: 16,
    background: 'var(--accent-light, #FFF0F3)', color: 'var(--accent, #C76B8A)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 13, fontWeight: 700, flexShrink: 0,
  },
  clientName: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  clientMeta: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)', marginTop: 1 },
  moreLabel: { textAlign: 'center', fontSize: 12, color: 'var(--accent, #C76B8A)', padding: '10px 0' },

  chipGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  chip: {
    padding: '6px 12px', borderRadius: 20,
    background: 'var(--accent-light, #FFF0F3)',
    color: 'var(--accent, #C76B8A)', fontSize: 12, fontWeight: 500,
    display: 'flex', alignItems: 'center', gap: 6,
  },
  chipPrice: { color: 'var(--text-muted, #B5AFA8)', fontWeight: 400 },

  importBtn: {
    display: 'block', width: '100%', padding: '16px 0', borderRadius: 14,
    border: 'none', background: 'var(--accent, #C76B8A)', color: '#fff',
    fontSize: 16, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'center', textDecoration: 'none',
    boxShadow: '0 2px 12px rgba(199, 107, 138, 0.3)',
  },
  backBtn: {
    display: 'block', width: '100%', padding: '14px 0', borderRadius: 12,
    border: 'none', background: 'var(--bg-hover, #F5F2EF)', color: 'var(--text-muted, #B5AFA8)',
    fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center',
  },

  // Done
  doneCard: {
    textAlign: 'center', padding: '40px 20px',
    background: 'var(--bg-card, #fff)', borderRadius: 16,
    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
  },
  doneEmoji: { fontSize: 48, display: 'block', marginBottom: 8 },
  doneTitle: {
    fontSize: 22, fontWeight: 700, margin: '0 0 16px',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  doneStats: { display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 16 },
  doneStat: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  doneNum: { fontSize: 28, fontWeight: 700, color: 'var(--accent, #C76B8A)' },
  doneLabel: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)', fontWeight: 500 },
  doneWarn: { fontSize: 12, color: 'var(--warning, #D4943A)', margin: '0 0 12px' },
  doneDesc: { fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', margin: '0 0 20px', lineHeight: 1.5 },
  doneActions: { display: 'flex', flexDirection: 'column', gap: 8 },

  // Manual paste
  manualCard: { display: 'flex', flexDirection: 'column', gap: 12 },
  exampleBox: {
    background: 'var(--bg-card, #fff)', borderRadius: 10, padding: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  exampleLine: { fontSize: 12, color: 'var(--text-muted, #B5AFA8)', fontFamily: 'monospace', lineHeight: 1.8 },
  textarea: {
    width: '100%', padding: 14, borderRadius: 12,
    border: '1.5px solid var(--border, #EDE9E4)',
    fontSize: 14, fontFamily: 'inherit', resize: 'vertical',
    outline: 'none', lineHeight: 1.6, boxSizing: 'border-box',
  },
};
