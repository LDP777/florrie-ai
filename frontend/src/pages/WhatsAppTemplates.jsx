import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import { templateDisplay, isClientTemplate, humanise, STARTER_NAMES, templateBase } from '../lib/templates.js';

/**
 * WhatsAppTemplates
 *
 * Manages the Meta-side WhatsApp templates on the WABA that owns the
 * beautician's sending phone (resolved server-side, same as the send path).
 *
 * The page is built around one idea a beautician actually cares about:
 * "what can Florrie send my clients, and does it sound like me?"
 *  - Starter pack: one tap submits the five standard messages with the
 *    salon's name written into every body.
 *  - Templates are grouped by what they mean: Live / In review / Needs attention.
 *  - Every template is shown as the WhatsApp bubble the client would see.
 */

const CATEGORY_OPTIONS = [
  { value: 'UTILITY', label: 'Booking admin (confirmations, reminders)' },
  { value: 'MARKETING', label: 'Keeping in touch (offers, invites, hellos)' },
];

async function apiFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const res = await fetch(`${API_BASE}/api/whatsapp${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || 'Request failed');
    err.body = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

const STATUS_GROUPS = {
  live: { title: 'Live', hint: 'Florrie can send these right now.' },
  review: { title: 'In review', hint: 'Meta checks new templates, usually within a few hours.' },
  attention: { title: 'Needs attention', hint: "Meta didn't approve these. Remove them or try different wording." },
};

function groupOf(status) {
  const s = (status || '').toUpperCase();
  if (s === 'APPROVED') return 'live';
  if (['REJECTED', 'DISABLED', 'PAUSED'].includes(s)) return 'attention';
  return 'review';
}

function chipStyle(group) {
  if (group === 'live') return { background: 'var(--success-bg, #EDF7F0)', color: 'var(--success, #2E7D6B)' };
  if (group === 'attention') return { background: 'var(--danger-bg, #ffdad6)', color: 'var(--danger, #8A2A1C)' };
  return { background: '#FFF8E1', color: '#7B5E00' };
}

function chipLabel(group) {
  if (group === 'live') return 'Live';
  if (group === 'attention') return 'Not approved';
  return 'In review';
}

/** The little WhatsApp-style bubble preview every template gets. */
function Bubble({ text }) {
  if (!text) return null;
  return (
    <div style={styles.bubbleStrip}>
      <div style={styles.bubble}>
        {text}
        <span style={styles.bubbleMeta}>12:30 ✓✓</span>
      </div>
    </div>
  );
}

function TemplateCard({ template, onDelete, deleting }) {
  const { label, blurb, preview } = templateDisplay(template);
  const group = groupOf(template.status);
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.cardName}>{label}</div>
          {blurb && <div style={styles.cardBlurb}>{blurb}</div>}
        </div>
        <span style={{ ...styles.statusChip, ...chipStyle(group) }}>{chipLabel(group)}</span>
      </div>
      <Bubble text={preview} />
      <div style={styles.cardActions}>
        <button
          type="button"
          onClick={() => onDelete(template)}
          disabled={deleting}
          style={styles.removeBtn}
        >
          {deleting ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </div>
  );
}

/**
 * Starter pack card. Shown until all five personalised templates exist.
 */
function StarterPackCard({ pack, businessName, onSubmitted }) {
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  const missing = pack.filter((t) => !t.existing_status);
  if (missing.length === 0 && !results) return null;

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/meta-templates/starter-pack', { method: 'POST' });
      setResults(res.results || []);
      onSubmitted();
    } catch (err) {
      logger.error('Starter pack failed:', err);
      setError(err.message || 'Could not submit the starter pack, try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.packCard}>
      <div style={styles.packEyebrow}>Recommended</div>
      <h2 style={styles.packTitle}>Sign every message with {businessName || 'your salon name'}</h2>
      <p style={styles.packDesc}>
        WhatsApp only shows your business name on your contact card, so the message itself
        should say who it's from. This submits {missing.length === 1 ? 'the missing standard message' : `${missing.length} standard messages`}, and
        Florrie drops your salon name into each one as it sends. She switches over
        automatically once Meta approves them.
      </p>

      <div style={styles.packPreviews}>
        {missing.slice(0, 2).map((t) => (
          <Bubble key={t.name} text={humanise(t.body)} />
        ))}
        {missing.length > 2 && (
          <div style={styles.packMore}>+ {missing.length - 2} more, same idea: confirmation, reminder, gap offer, rebook invite, quick hello</div>
        )}
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      {results ? (
        <div style={styles.packResults}>
          {results.map((r) => (
            <div key={r.name} style={styles.packResultRow}>
              <span>{r.label}</span>
              <span style={{
                ...styles.statusChip,
                ...(r.action === 'failed' ? chipStyle('attention')
                  : r.action === 'created' ? chipStyle('review') : chipStyle('live')),
              }}>
                {r.action === 'created' ? 'Sent for review'
                  : r.action === 'failed' ? 'Failed'
                  : 'Ready to use'}
              </span>
            </div>
          ))}
          <div style={styles.packNote}>Meta usually approves within a few hours. Nothing else to do.</div>
        </div>
      ) : (
        <button type="button" onClick={submit} disabled={submitting} style={styles.packBtn}>
          {submitting ? 'Submitting to Meta…' : `Submit ${missing.length === 1 ? 'it' : `all ${missing.length}`} for review`}
        </button>
      )}
    </div>
  );
}

function CreateModal({ open, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('UTILITY');
  const [bodyText, setBodyText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setCategory('UTILITY');
      setBodyText('');
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  function handleNameChange(e) {
    // Meta naming rules: lowercase, underscores, nothing fancy.
    const normalised = e.target.value
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
    setName(normalised);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!name.trim()) { setError('Give it a short name.'); return; }
    if (!bodyText.trim()) { setError('Write the message first.'); return; }

    setSubmitting(true);
    try {
      await apiFetch('/meta-templates', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          category,
          language: 'en',
          body_text: bodyText.trim(),
        }),
      });
      onCreated();
      onClose();
    } catch (err) {
      logger.error('Create template failed:', err);
      setError(err.message || 'Could not create the template, try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <h2 style={styles.modalTitle}>New template</h2>
          <button type="button" onClick={onClose} style={styles.modalClose} aria-label="Close">&times;</button>
        </div>

        <form onSubmit={handleSubmit} style={styles.modalBody}>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Name</label>
            <input
              type="text"
              value={name}
              onChange={handleNameChange}
              placeholder="aftercare_check_in"
              style={styles.input}
              disabled={submitting}
              autoFocus
            />
            <div style={styles.helper}>Just for you, clients never see it. Spaces become underscores.</div>
          </div>

          <div style={styles.fieldGroup}>
            <label style={styles.label}>What's it for?</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={styles.input}
              disabled={submitting}
            >
              {CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div style={styles.fieldGroup}>
            <label style={styles.label}>Message</label>
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              placeholder={"Hi {{1}}! It's Ellindigo 🌸 Just checking in after your appointment…"}
              style={{ ...styles.input, minHeight: 110, fontFamily: 'inherit', resize: 'vertical' }}
              disabled={submitting}
              maxLength={1024}
            />
            <div style={styles.helper}>
              {'{{1}}'} fills in the client's name when it sends. Tip: open with who you are, names don't always show on WhatsApp.
            </div>
          </div>

          {bodyText.trim() && (
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Your client sees</label>
              <Bubble text={humanise(bodyText)} />
            </div>
          )}

          {error && <div style={styles.errorBox}>{error}</div>}

          <div style={styles.modalFooter}>
            <button type="button" onClick={onClose} disabled={submitting} style={styles.cancelBtn}>Cancel</button>
            <button type="submit" disabled={submitting} style={styles.submitBtn}>
              {submitting ? 'Submitting to Meta…' : 'Submit for review'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function WhatsAppTemplates() {
  const [templates, setTemplates] = useState([]);
  const [waba, setWaba] = useState(null);
  const [starter, setStarter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [deletingName, setDeletingName] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, pack] = await Promise.all([
        apiFetch('/meta-templates'),
        apiFetch('/meta-templates/starter-pack').catch(() => null),
      ]);
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
      setWaba(data.waba || null);
      setStarter(pack);
    } catch (err) {
      logger.error('Load templates failed:', err);
      setError(err.message || 'Could not load templates.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(template) {
    const ok = confirm(`Remove "${templateDisplay(template).label}"? Messages already sent stay in your clients' chats.`);
    if (!ok) return;
    setDeletingName(template.name);
    try {
      await apiFetch(`/meta-templates/${encodeURIComponent(template.name)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      logger.error('Delete template failed:', err);
      alert(err.message || 'Could not remove it, try again.');
    } finally {
      setDeletingName(null);
    }
  }

  const visible = templates.filter((t) => isClientTemplate(t.name));
  // One card per message: when the current shared version of a message is on
  // the account, hide the older versions of the same thing. The newest is what
  // Florrie actually sends.
  const names = new Set(visible.map((t) => (t.name || '').toLowerCase()));
  const deduped = visible.filter((t) => {
    const name = (t.name || '').toLowerCase();
    const current = `${templateBase(name)}_v4`;
    return name === current || !STARTER_NAMES.includes(current) || !names.has(current);
  });
  const grouped = { live: [], review: [], attention: [] };
  for (const t of deduped) grouped[groupOf(t.status)].push(t);

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <div style={styles.crumb}>
            <Link to="/whatsapp" style={styles.crumbLink}>&larr; WhatsApp Business</Link>
          </div>
          <h1 style={styles.title}>Message templates</h1>
          <p style={styles.subtitle}>
            The pre-approved messages Florrie can send anytime, even when a client
            hasn't texted you in over 24 hours (a WhatsApp rule, not ours).
          </p>
        </div>
        <button type="button" onClick={() => setModalOpen(true)} style={styles.primaryBtn}>
          + New template
        </button>
      </div>

      {loading && <PageLoader />}

      {!loading && error && (
        <div style={styles.errorBanner}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Could not load templates</div>
          <div style={{ fontSize: 13 }}>{error}</div>
          <button type="button" onClick={load} style={{ ...styles.cancelBtn, marginTop: 10 }}>Try again</button>
        </div>
      )}

      {!loading && !error && (
        <>
          {starter?.pack && (
            <StarterPackCard
              pack={starter.pack}
              businessName={starter.business_name}
              onSubmitted={load}
            />
          )}

          {deduped.length === 0 && (
            <div style={styles.emptyState}>
              <div style={styles.emptyTitle}>No templates yet</div>
              <div style={styles.emptyDesc}>
                Start with the pack above, it covers confirmations, reminders and
                rebooking invites, all signed with your name.
              </div>
            </div>
          )}

          {['live', 'review', 'attention'].map((g) => (
            grouped[g].length > 0 && (
              <section key={g} style={styles.section}>
                <div style={styles.sectionHeader}>
                  <h2 style={styles.sectionTitle}>{STATUS_GROUPS[g].title}</h2>
                  <span style={styles.sectionHint}>{STATUS_GROUPS[g].hint}</span>
                </div>
                <div style={styles.list}>
                  {grouped[g].map((t) => (
                    <TemplateCard
                      key={`${t.name}__${t.language}`}
                      template={t}
                      onDelete={handleDelete}
                      deleting={deletingName === t.name}
                    />
                  ))}
                </div>
              </section>
            )
          ))}
        </>
      )}

      <CreateModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={load} />
    </div>
  );
}

const styles = {
  page: {
    padding: '16px 16px 32px',
    maxWidth: 720,
    margin: '0 auto',
    fontFamily: 'var(--font-body, "Plus Jakarta Sans", sans-serif)',
    color: 'var(--text-primary, #241B17)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 18,
    flexWrap: 'wrap',
  },
  crumb: { marginBottom: 4 },
  crumbLink: {
    fontSize: 12,
    color: 'var(--text-muted, #8A7A72)',
    textDecoration: 'none',
    fontWeight: 500,
  },
  title: {
    fontSize: 26,
    fontWeight: 600,
    margin: 0,
    fontFamily: 'var(--font-display, "Fraunces", Georgia, serif)',
  },
  subtitle: {
    fontSize: 13.5,
    lineHeight: 1.55,
    color: 'var(--text-secondary, #4D423D)',
    margin: '6px 0 0',
    maxWidth: 440,
  },
  primaryBtn: {
    padding: '10px 16px',
    borderRadius: 999,
    border: 'none',
    background: 'var(--accent, #92405e)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: 'var(--shadow-sm, 0 1px 3px rgba(146,64,94,.15))',
    whiteSpace: 'nowrap',
  },

  // Starter pack
  packCard: {
    background: 'var(--accent-light, #F6E7EC)',
    border: '1px solid var(--border, #ECD5DD)',
    borderRadius: 18,
    padding: '18px 18px 16px',
    marginBottom: 22,
  },
  packEyebrow: {
    fontSize: 10.5,
    fontWeight: 800,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: 'var(--accent, #92405e)',
    marginBottom: 8,
  },
  packTitle: {
    fontSize: 19,
    fontWeight: 600,
    margin: '0 0 6px',
    fontFamily: 'var(--font-display, "Fraunces", Georgia, serif)',
  },
  packDesc: {
    fontSize: 13.5,
    lineHeight: 1.6,
    color: 'var(--text-secondary, #4D423D)',
    margin: '0 0 14px',
  },
  packPreviews: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 },
  packMore: {
    fontSize: 12,
    color: 'var(--text-muted, #8A7A72)',
    paddingLeft: 4,
  },
  packBtn: {
    width: '100%',
    padding: '13px 16px',
    borderRadius: 12,
    border: 'none',
    background: 'var(--accent, #92405e)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  packResults: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 12,
    padding: '6px 12px',
  },
  packResultRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 0',
    fontSize: 13.5,
    fontWeight: 600,
  },
  packNote: {
    fontSize: 12,
    color: 'var(--text-muted, #8A7A72)',
    padding: '8px 0 6px',
    borderTop: '1px solid var(--border-light, #ede7e3)',
  },

  // Sections
  section: { marginBottom: 22 },
  sectionHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: 700,
    margin: 0,
  },
  sectionHint: { fontSize: 12, color: 'var(--text-muted, #8A7A72)' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },

  // Cards
  card: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 16,
    border: '1px solid var(--border-light, #ede7e3)',
    padding: 14,
    boxShadow: 'var(--shadow-xs, 0 1px 2px rgba(146,64,94,.04))',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 10,
  },
  cardName: { fontSize: 15.5, fontWeight: 700 },
  cardBlurb: { fontSize: 12.5, color: 'var(--text-muted, #8A7A72)', marginTop: 2 },
  statusChip: {
    fontSize: 11,
    fontWeight: 700,
    padding: '4px 10px',
    borderRadius: 999,
    whiteSpace: 'nowrap',
  },

  // WhatsApp bubble preview
  bubbleStrip: {
    background: '#EAE2DA',
    borderRadius: 12,
    padding: '10px 12px',
  },
  bubble: {
    background: '#DCF8C6',
    borderRadius: '12px 12px 4px 12px',
    padding: '8px 10px',
    fontSize: 13,
    lineHeight: 1.5,
    color: '#1d1b19',
    maxWidth: '92%',
    marginLeft: 'auto',
    whiteSpace: 'pre-wrap',
    boxShadow: '0 1px 1px rgba(0,0,0,.06)',
  },
  bubbleMeta: {
    display: 'inline-block',
    fontSize: 10,
    color: 'rgba(29,27,25,.45)',
    marginLeft: 8,
    transform: 'translateY(1px)',
  },

  cardActions: { display: 'flex', justifyContent: 'flex-end', marginTop: 10 },
  removeBtn: {
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid var(--border-light, #ede7e3)',
    background: 'transparent',
    color: 'var(--text-muted, #8A7A72)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  errorBanner: {
    background: 'var(--danger-bg, #ffdad6)',
    border: '1px solid #F5C6C0',
    borderRadius: 12,
    padding: 14,
    color: '#8A2A1C',
    marginBottom: 12,
  },
  errorBox: {
    background: 'var(--danger-bg, #ffdad6)',
    border: '1px solid #F5C6C0',
    borderRadius: 10,
    padding: 10,
    fontSize: 13,
    color: '#8A2A1C',
    marginBottom: 10,
  },
  emptyState: {
    background: 'var(--bg-card, #fff)',
    border: '1px dashed var(--border, #ECD5DD)',
    borderRadius: 16,
    padding: 28,
    textAlign: 'center',
    marginBottom: 22,
  },
  emptyTitle: { fontSize: 16, fontWeight: 700, marginBottom: 6 },
  emptyDesc: {
    fontSize: 13,
    color: 'var(--text-secondary, #4D423D)',
    lineHeight: 1.55,
    maxWidth: 380,
    margin: '0 auto',
  },

  // Modal
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'var(--overlay, rgba(29,27,25,.3))',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'var(--bg-card, #fff)',
    borderRadius: '20px 20px 0 0',
    width: '100%',
    maxWidth: 560,
    maxHeight: '92vh',
    overflowY: 'auto',
    boxShadow: '0 -6px 24px rgba(0,0,0,0.18)',
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px 10px',
    borderBottom: '1px solid var(--border-light, #ede7e3)',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 600,
    margin: 0,
    fontFamily: 'var(--font-display, "Fraunces", Georgia, serif)',
  },
  modalClose: {
    border: 'none',
    background: 'none',
    fontSize: 28,
    lineHeight: 1,
    color: 'var(--text-muted, #8A7A72)',
    cursor: 'pointer',
    padding: 4,
  },
  modalBody: { padding: 20, display: 'flex', flexDirection: 'column', gap: 14 },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 12, fontWeight: 700, color: 'var(--text-secondary, #4D423D)' },
  input: {
    width: '100%',
    padding: '11px 12px',
    borderRadius: 10,
    border: '1.5px solid var(--border, #ECD5DD)',
    fontSize: 14,
    fontFamily: 'inherit',
    color: 'var(--text-primary, #241B17)',
    background: 'var(--bg-input, #f8f2ef)',
    outline: 'none',
    boxSizing: 'border-box',
  },
  helper: { fontSize: 11.5, color: 'var(--text-muted, #8A7A72)', lineHeight: 1.5 },
  cancelBtn: {
    padding: '10px 16px',
    borderRadius: 10,
    border: '1px solid var(--border, #ECD5DD)',
    background: 'var(--bg, #FBF6F1)',
    color: 'var(--text-secondary, #4D423D)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  submitBtn: {
    padding: '10px 16px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--accent, #92405e)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
