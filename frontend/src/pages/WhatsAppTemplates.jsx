import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';

/**
 * WhatsAppTemplates
 *
 * Manages Meta-side WhatsApp message templates on Florrie's shared WABA.
 * Distinct from /templates (Supabase-stored internal copy library). Each
 * action here calls Meta's Graph API, so it exercises the
 * whatsapp_business_management permission used in the App Review screencast.
 */

const CATEGORY_OPTIONS = [
  { value: 'UTILITY', label: 'Utility (booking, reminders, receipts)' },
  { value: 'MARKETING', label: 'Marketing (promos, offers, win-back)' },
  { value: 'AUTHENTICATION', label: 'Authentication (one-time codes)' },
];

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'en_GB', label: 'English (UK)' },
  { value: 'en_US', label: 'English (US)' },
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

function statusStyle(status) {
  const s = (status || '').toUpperCase();
  if (s === 'APPROVED') {
    return { bg: '#E8F5E9', border: '#C8E6C9', color: '#2E7D32' };
  }
  if (s === 'REJECTED' || s === 'DISABLED' || s === 'PAUSED') {
    return { bg: '#FDECEA', border: '#F5C6C0', color: '#8A2A1C' };
  }
  // PENDING_REVIEW, IN_APPEAL, anything else
  return { bg: '#FFF8E1', border: '#FFE082', color: '#7B5E00' };
}

function bodyPreview(components) {
  if (!Array.isArray(components)) return '';
  const body = components.find((c) => (c.type || '').toUpperCase() === 'BODY');
  return body?.text || '';
}

function headerPreview(components) {
  if (!Array.isArray(components)) return '';
  const header = components.find((c) => (c.type || '').toUpperCase() === 'HEADER');
  return header?.text || '';
}

function footerPreview(components) {
  if (!Array.isArray(components)) return '';
  const footer = components.find((c) => (c.type || '').toUpperCase() === 'FOOTER');
  return footer?.text || '';
}

function TemplateCard({ template, onDelete, deleting }) {
  const s = statusStyle(template.status);
  const body = bodyPreview(template.components);
  const header = headerPreview(template.components);
  const footer = footerPreview(template.components);

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.cardName}>{template.name}</div>
          <div style={styles.cardMeta}>
            <span style={styles.metaPill}>{template.category || 'UTILITY'}</span>
            <span style={styles.metaPill}>{template.language}</span>
          </div>
        </div>
        <span style={{
          ...styles.statusBadge,
          background: s.bg,
          border: `1px solid ${s.border}`,
          color: s.color,
        }}>
          {template.status || 'UNKNOWN'}
        </span>
      </div>

      {(header || body || footer) && (
        <div style={styles.previewBlock}>
          {header && (
            <div style={styles.previewHeader}>{header}</div>
          )}
          {body && (
            <div style={styles.previewBody}>{body}</div>
          )}
          {footer && (
            <div style={styles.previewFooter}>{footer}</div>
          )}
        </div>
      )}

      <div style={styles.cardActions}>
        <button
          type="button"
          onClick={() => onDelete(template)}
          disabled={deleting}
          style={styles.deleteBtn}
        >
          {deleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

function CreateModal({ open, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('UTILITY');
  const [language, setLanguage] = useState('en');
  const [bodyText, setBodyText] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [footerText, setFooterText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setCategory('UTILITY');
      setLanguage('en');
      setBodyText('');
      setHeaderText('');
      setFooterText('');
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  function handleNameChange(e) {
    // Auto-normalise to Meta's naming rules: lowercase, underscores instead
    // of spaces, strip anything that isn't a letter, number, or underscore.
    const raw = e.target.value;
    const normalised = raw
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
    setName(normalised);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!bodyText.trim()) {
      setError('Body text is required.');
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch('/meta-templates', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          category,
          language,
          body_text: bodyText.trim(),
          header_text: headerText.trim() || undefined,
          footer_text: footerText.trim() || undefined,
        }),
      });
      onCreated();
      onClose();
    } catch (err) {
      logger.error('Create template failed:', err);
      setError(err.message || 'Could not create template, try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <h2 style={styles.modalTitle}>Create WhatsApp template</h2>
          <button type="button" onClick={onClose} style={styles.modalClose} aria-label="Close">
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} style={styles.modalBody}>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Template name</label>
            <input
              type="text"
              value={name}
              onChange={handleNameChange}
              placeholder="booking_confirmation"
              style={styles.input}
              disabled={submitting}
              autoFocus
            />
            <div style={styles.helper}>
              Lowercase, no spaces. Spaces become underscores automatically.
            </div>
          </div>

          <div style={styles.row}>
            <div style={{ ...styles.fieldGroup, flex: 1 }}>
              <label style={styles.label}>Category</label>
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

            <div style={{ ...styles.fieldGroup, flex: 1 }}>
              <label style={styles.label}>Language</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                style={styles.input}
                disabled={submitting}
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={styles.fieldGroup}>
            <label style={styles.label}>Header (optional)</label>
            <input
              type="text"
              value={headerText}
              onChange={(e) => setHeaderText(e.target.value)}
              placeholder="Booking confirmed"
              style={styles.input}
              disabled={submitting}
              maxLength={60}
            />
          </div>

          <div style={styles.fieldGroup}>
            <label style={styles.label}>Body</label>
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              placeholder="Hi {{1}}, your appointment is confirmed for {{2}} at {{3}}."
              style={{ ...styles.input, minHeight: 120, fontFamily: 'inherit', resize: 'vertical' }}
              disabled={submitting}
              maxLength={1024}
            />
            <div style={styles.helper}>
              Use double-curly placeholders like {'{{1}}'}, {'{{2}}'} for dynamic fields.
            </div>
          </div>

          <div style={styles.fieldGroup}>
            <label style={styles.label}>Footer (optional)</label>
            <input
              type="text"
              value={footerText}
              onChange={(e) => setFooterText(e.target.value)}
              placeholder="Reply STOP to opt out"
              style={styles.input}
              disabled={submitting}
              maxLength={60}
            />
          </div>

          {error && (
            <div style={styles.errorBox}>{error}</div>
          )}

          <div style={styles.modalFooter}>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              style={styles.cancelBtn}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              style={styles.submitBtn}
            >
              {submitting ? 'Submitting to Meta...' : 'Submit for review'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function WhatsAppTemplates() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [deletingName, setDeletingName] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch('/meta-templates');
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
    } catch (err) {
      logger.error('Load templates failed:', err);
      setError(err.message || 'Could not load templates.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDelete(template) {
    const ok = confirm(`Delete the "${template.name}" template? This removes every language variant. Messages already sent stay in your clients chat history.`);
    if (!ok) return;
    setDeletingName(template.name);
    try {
      await apiFetch(`/meta-templates/${encodeURIComponent(template.name)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      logger.error('Delete template failed:', err);
      alert(err.message || 'Could not delete template, try again.');
    } finally {
      setDeletingName(null);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <div style={styles.crumb}>
            <Link to="/whatsapp" style={styles.crumbLink}>&larr; WhatsApp Business</Link>
          </div>
          <h1 style={styles.title}>Message templates</h1>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          style={styles.primaryBtn}
        >
          + Create new template
        </button>
      </div>

      <div style={styles.explainer}>
        These are your approved WhatsApp message templates. Meta reviews each one
        and approves it within a few hours. Approved templates can be sent to
        clients outside the 24-hour conversation window.
      </div>

      {loading && <PageLoader />}

      {!loading && error && (
        <div style={styles.errorBanner}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Could not load templates</div>
          <div style={{ fontSize: 13 }}>{error}</div>
          <button
            type="button"
            onClick={load}
            style={{ ...styles.cancelBtn, marginTop: 10 }}
          >
            Try again
          </button>
        </div>
      )}

      {!loading && !error && templates.length === 0 && (
        <div style={styles.emptyState}>
          <div style={styles.emptyIcon}>?</div>
          <div style={styles.emptyTitle}>No templates yet</div>
          <div style={styles.emptyDesc}>
            Create your first template to send proactive messages, like booking
            confirmations and reminders, outside the 24-hour window.
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            style={{ ...styles.primaryBtn, marginTop: 16 }}
          >
            + Create your first template
          </button>
        </div>
      )}

      {!loading && !error && templates.length > 0 && (
        <div style={styles.list}>
          {templates.map((t) => (
            <TemplateCard
              key={`${t.name}__${t.language}`}
              template={t}
              onDelete={handleDelete}
              deleting={deletingName === t.name}
            />
          ))}
        </div>
      )}

      <CreateModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={load}
      />
    </div>
  );
}

const styles = {
  page: {
    padding: '16px 16px 100px',
    maxWidth: 720,
    margin: '0 auto',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
    color: 'var(--text, #2D2A26)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: 12,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  crumb: { marginBottom: 4 },
  crumbLink: {
    fontSize: 12,
    color: 'var(--text-muted, #AAA5A0)',
    textDecoration: 'none',
    fontWeight: 500,
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: 'var(--text, #2D2A26)',
    margin: 0,
    fontFamily: '"Playfair Display", Georgia, serif',
  },
  primaryBtn: {
    padding: '10px 16px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--accent, #92405e)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.2)',
  },
  explainer: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 12,
    padding: '12px 14px',
    border: '1px solid var(--border, #F0ECE8)',
    fontSize: 13,
    lineHeight: 1.55,
    color: 'var(--text-secondary, #8B6F5E)',
    marginBottom: 16,
  },
  errorBanner: {
    background: '#FDECEA',
    border: '1px solid #F5C6C0',
    borderRadius: 12,
    padding: 14,
    color: '#8A2A1C',
    marginBottom: 12,
  },
  emptyState: {
    background: 'var(--bg-card, #fff)',
    border: '1px dashed var(--border, #E8E4E0)',
    borderRadius: 14,
    padding: 32,
    textAlign: 'center',
  },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    background: 'var(--bg, #FAF8F5)',
    color: 'var(--accent, #92405e)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
    fontWeight: 700,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--text, #2D2A26)',
    marginBottom: 6,
  },
  emptyDesc: {
    fontSize: 13,
    color: 'var(--text-secondary, #8B6F5E)',
    lineHeight: 1.55,
    maxWidth: 380,
    margin: '0 auto',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  card: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 14,
    border: '1px solid var(--border, #F0ECE8)',
    padding: 14,
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 10,
  },
  cardName: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text, #2D2A26)',
    wordBreak: 'break-all',
  },
  cardMeta: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
    marginTop: 4,
  },
  metaPill: {
    fontSize: 11,
    fontWeight: 500,
    padding: '2px 8px',
    borderRadius: 6,
    background: 'var(--border, #F0ECE8)',
    color: 'var(--text-secondary, #8B6F5E)',
    letterSpacing: '0.02em',
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '4px 8px',
    borderRadius: 6,
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
  },
  previewBlock: {
    background: 'var(--bg, #FAF8F5)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    border: '1px solid var(--border, #F0ECE8)',
  },
  previewHeader: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text, #2D2A26)',
    marginBottom: 6,
  },
  previewBody: {
    fontSize: 13,
    lineHeight: 1.55,
    color: 'var(--text, #2D2A26)',
    whiteSpace: 'pre-wrap',
  },
  previewFooter: {
    fontSize: 11,
    color: 'var(--text-muted, #AAA5A0)',
    marginTop: 8,
    fontStyle: 'italic',
  },
  cardActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  },
  deleteBtn: {
    padding: '7px 12px',
    borderRadius: 8,
    border: '1px solid #F5C6C0',
    background: '#fff',
    color: '#8A2A1C',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  // Modal
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(45, 42, 38, 0.45)',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 0,
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
    padding: '16px 20px 8px',
    borderBottom: '1px solid var(--border, #F0ECE8)',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--text, #2D2A26)',
    margin: 0,
    fontFamily: '"Playfair Display", Georgia, serif',
  },
  modalClose: {
    border: 'none',
    background: 'none',
    fontSize: 28,
    lineHeight: 1,
    color: 'var(--text-muted, #AAA5A0)',
    cursor: 'pointer',
    padding: 4,
  },
  modalBody: {
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  modalFooter: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 8,
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  row: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap',
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary, #8B6F5E)',
  },
  input: {
    width: '100%',
    padding: '11px 12px',
    borderRadius: 10,
    border: '1.5px solid var(--border, #E8E4E0)',
    fontSize: 14,
    fontFamily: 'inherit',
    color: 'var(--text, #2D2A26)',
    background: 'var(--bg, #FAF8F5)',
    outline: 'none',
    boxSizing: 'border-box',
  },
  helper: {
    fontSize: 11,
    color: 'var(--text-muted, #AAA5A0)',
  },
  errorBox: {
    background: '#FDECEA',
    border: '1px solid #F5C6C0',
    borderRadius: 10,
    padding: 10,
    fontSize: 13,
    color: '#8A2A1C',
  },
  cancelBtn: {
    padding: '10px 16px',
    borderRadius: 10,
    border: '1px solid var(--border, #E8E4E0)',
    background: 'var(--bg, #FAF8F5)',
    color: 'var(--text-secondary, #8B6F5E)',
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
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.25)',
  },
};
