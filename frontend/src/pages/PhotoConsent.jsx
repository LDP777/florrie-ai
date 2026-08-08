/**
 * Photo Consent. GDPR-compliant photo permission management.
 *
 * Before sharing any before/after pics on Instagram or the booking
 * page, Ellie needs written consent. This page tracks who's given
 * permission, what type, and when it expires.
 */
import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Icon from '../components/ui/Icon';

const SCOPE_OPTIONS = [
  { value: 'portfolio', label: 'Portfolio', desc: 'Visible in your florrie.ai portfolio' },
  { value: 'booking-page', label: 'Booking Page', desc: 'Shown on your public booking page' },
  { value: 'instagram', label: 'Instagram', desc: 'Shared on your Instagram feed/stories' },
  { value: 'tiktok', label: 'TikTok', desc: 'Used in TikTok content' },
  { value: 'facebook', label: 'Facebook', desc: 'Shared on Facebook' },
  { value: 'training', label: 'Training', desc: 'Used in training materials' },
];

const STATUS_CONFIG = {
  granted: { label: 'Granted', bg: '#E8F5E9', color: '#4CAF50' },
  pending: { label: 'Pending', bg: '#FFF5E6', color: '#B8860B' },
  declined: { label: 'Declined', bg: '#FFEBEE', color: '#F44336' },
  expired: { label: 'Expired', bg: '#F0ECE8', color: 'var(--text-muted, #6B5D54)' },
};

export default function PhotoConsent() {
  const [tab, setTab] = useState('all');
  const [showRequest, setShowRequest] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [consents, setConsents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState('');
  const [sending, setSending] = useState(false);
  const [modalError, setModalError] = useState('');
  const [revokingId, setRevokingId] = useState(null);
  const [requestForm, setRequestForm] = useState({ client: '', scope: ['portfolio', 'booking-page'], method: 'digital', message: '' });
  const [settings, setSettings] = useState({
    autoRequest: true,
    requestAfter: 'first-appointment',
    defaultScope: ['portfolio', 'booking-page'],
    consentDuration: 12,
    reminderBeforeExpiry: 30,
    consentMessage: "Hey {name}! I'd love to feature your results in my portfolio - would you be happy for me to share your before/after photos? You can choose exactly where they appear and withdraw consent any time xx",
  });

  // Fetch consents and clients
  const fetchData = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const session = await supabase.auth.getSession();
      if (!session.data.session) {
        setLoadError('Your session has expired. Please sign in again.');
        return;
      }

      const [consentsRes, clientsRes] = await Promise.all([
        fetch(`${API_BASE}/api/photo-consent`, {
          headers: { 'Authorization': `Bearer ${session.data.session.access_token}` }
        }),
        fetch(`${API_BASE}/api/clients`, {
          headers: { 'Authorization': `Bearer ${session.data.session.access_token}` }
        })
      ]);

      if (!consentsRes.ok) {
        throw new Error('consents');
      }

      const { data } = await consentsRes.json();
      const transformed = (data || []).map(c => ({
        id: c.id,
        clientId: c.client_id,
        client: c.client_name || c.clients?.first_name || 'Unknown',
        status: c.status,
        grantedDate: c.granted_at,
        scope: c.permitted_uses || [],
        expiresAt: c.expires_at,
        method: c.method,
        notes: c.notes || ''
      }));
      setConsents(transformed);

      if (clientsRes.ok) {
        const { data: clientData } = await clientsRes.json();
        setClients(clientData || []);
      }
    } catch (err) {
      setLoadError("Couldn't load photo consents. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Auto-dismiss the success toast after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const now = new Date();
  const consentsList = consents.map(c => {
    if (c.status === 'granted' && c.expiresAt && new Date(c.expiresAt) < now) {
      return { ...c, status: 'expired' };
    }
    return c;
  });

  const filtered = tab === 'all' ? consentsList : consentsList.filter(c => c.status === tab);

  const stats = {
    granted: consentsList.filter(c => c.status === 'granted').length,
    pending: consentsList.filter(c => c.status === 'pending').length,
    expired: consentsList.filter(c => c.status === 'expired').length,
    declined: consentsList.filter(c => c.status === 'declined').length,
  };

  const handleSendRequest = async () => {
    setModalError('');
    if (!requestForm.client || requestForm.scope.length === 0) {
      setModalError('Pick a client and at least one place the photos can be used.');
      return;
    }

    setSending(true);
    try {
      const session = await supabase.auth.getSession();
      if (!session.data.session) {
        setModalError('Your session has expired. Please sign in again.');
        return;
      }

      const selectedClient = clients.find(c => c.first_name === requestForm.client);
      if (!selectedClient) {
        setModalError("Couldn't find that client. Try reselecting.");
        return;
      }

      const res = await fetch(`${API_BASE}/api/photo-consent`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.data.session.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: selectedClient.id,
          permitted_uses: requestForm.scope,
          method: requestForm.method,
          notes: requestForm.message || settings.consentMessage
        })
      });

      if (!res.ok) throw new Error('Failed to send request');

      const { data: newConsent } = await res.json();
      setConsents([...consents, {
        id: newConsent.id,
        clientId: newConsent.client_id,
        client: newConsent.client_name || selectedClient.first_name,
        status: newConsent.status || 'pending',
        grantedDate: newConsent.granted_at,
        scope: newConsent.permitted_uses || [],
        expiresAt: newConsent.expires_at,
        method: newConsent.method,
        notes: newConsent.notes || ''
      }]);

      setShowRequest(false);
      setRequestForm({ client: '', scope: ['portfolio', 'booking-page'], method: 'digital', message: '' });
      setToast(`Consent request sent to ${selectedClient.first_name}.`);
    } catch (err) {
      setModalError("Couldn't send the request. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  const handleRevoke = async (consent) => {
    if (!confirm(`Revoke photo consent for ${consent.client}?`)) return;
    setRevokingId(consent.id);
    try {
      const session = await supabase.auth.getSession();
      if (!session.data.session) {
        setToast('Your session has expired. Please sign in again.');
        return;
      }

      const res = await fetch(`${API_BASE}/api/photo-consent/${consent.id}/revoke`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${session.data.session.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ notes: 'Consent withdrawn by client' })
      });

      if (!res.ok) throw new Error('Failed to revoke');

      setConsents(consents.map(c =>
        c.id === consent.id ? { ...c, status: 'declined', scope: [] } : c
      ));
      setToast(`Consent revoked for ${consent.client}.`);
    } catch (err) {
      setToast("Couldn't revoke consent. Please try again.");
    } finally {
      setRevokingId(null);
    }
  };

  const handleRequestRenewal = (consent) => {
    // Reuse the existing request flow, pre-filled for this client
    setModalError('');
    setRequestForm({
      client: consent.client,
      scope: consent.scope.length ? consent.scope : ['portfolio', 'booking-page'],
      method: 'digital',
      message: '',
    });
    setShowRequest(true);
  };

  if (loading) {
    return <PageLoader />;
  }

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h1 style={S.title}>Photo Consent</h1>
        <button style={S.reqBtn} onClick={() => { setModalError(''); setShowRequest(true); }}>+ Request</button>
      </div>

      {toast && <div style={S.toast}>{toast}</div>}

      {loadError && (
        <div style={S.errorBanner}>
          <span>{loadError}</span>
          <button style={S.retryBtn} onClick={fetchData}>Retry</button>
        </div>
      )}

      {/* Stats */}
      <div style={S.statsRow}>
        {[
          { label: 'Granted', value: stats.granted, colour: '#4CAF50' },
          { label: 'Pending', value: stats.pending, colour: '#B8860B' },
          { label: 'Expired', value: stats.expired, colour: 'var(--text-muted, #6B5D54)' },
          { label: 'Declined', value: stats.declined, colour: '#F44336' },
        ].map(s => (
          <div key={s.label} style={S.statCard}>
            <span style={{ ...S.statValue, color: s.colour }}>{s.value}</span>
            <span style={S.statLabel}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div style={S.tabs}>
        {['all', 'granted', 'pending', 'expired'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Consent list */}
      <div style={S.list}>
        {filtered.length === 0 && <EmptyState icon="camera" title="No photo consents yet" subtitle={tab === 'all' ? 'Tap + Request to ask a client for permission to share their photos.' : 'No consents in this category.'} />}
        {filtered.map(c => {
          const st = STATUS_CONFIG[c.status];
          const isExpanded = expanded === c.id;
          return (
            <div key={c.id} style={S.consentCard} onClick={() => setExpanded(isExpanded ? null : c.id)}>
              <div style={S.consentHeader}>
                <div style={S.consentLeft}>
                  <div style={S.avatar}>{c.client[0]}</div>
                  <div style={S.consentInfo}>
                    <span style={S.consentClient}>{c.client}</span>
                    {c.grantedDate && <span style={S.consentDate}>Since {formatDate(c.grantedDate)}</span>}
                  </div>
                </div>
                <span style={{ ...S.statusBadge, background: st.bg, color: st.color }}>{st.label}</span>
              </div>

              {/* Scope icons */}
              {c.scope.length > 0 && (
                <div style={S.scopeRow}>
                  {c.scope.map(s => {
                    const opt = SCOPE_OPTIONS.find(o => o.value === s);
                    return <span key={s} style={S.scopeTag}>{opt?.label || s}</span>;
                  })}
                </div>
              )}

              {isExpanded && (
                <div style={S.expandedSection}>
                  {c.notes && <p style={S.consentNotes}>{c.notes}</p>}
                  {c.expiresAt && (
                    <div style={S.detailRow}>
                      <span style={S.detailLabel}>Expires</span>
                      <span style={S.detailValue}>{formatDate(c.expiresAt)}</span>
                    </div>
                  )}
                  {c.method && (
                    <div style={S.detailRow}>
                      <span style={S.detailLabel}>Method</span>
                      <span style={S.detailValue}>{c.method === 'digital' ? 'Digital Signature' : 'Paper Form'}</span>
                    </div>
                  )}

                  {(c.status === 'granted' || c.status === 'expired') && (
                    <div style={S.actionRow}>
                      {c.status === 'granted' && (
                        <button style={{ ...S.actionBtn, ...(revokingId === c.id ? S.actionBtnBusy : {}) }} disabled={revokingId === c.id} onClick={(e) => { e.stopPropagation(); handleRevoke(c); }}>{revokingId === c.id ? 'Revoking...' : 'Revoke'}</button>
                      )}
                      {c.status === 'expired' && (
                        <button
                          style={{ ...S.actionBtn, background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)' }}
                          onClick={(e) => { e.stopPropagation(); handleRequestRenewal(c); }}
                        >
                          Request Renewal
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* GDPR notice */}
      <div style={S.gdprCard}>
        <span style={S.gdprTitle}><Icon name="list" size={14} inline /> GDPR Compliance</span>
        <p style={S.gdprText}>
          Photo consent is stored securely and clients can withdraw at any time. Consent is specific to the uses listed - using photos beyond the agreed scope requires additional consent.
        </p>
      </div>

      {/* Request consent modal */}
      {showRequest && (
        <div style={S.overlay} onClick={() => { setShowRequest(false); setModalError(''); }}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h2 style={S.modalTitle}>Request Photo Consent</h2>

            <div style={S.fieldLabel}>Client</div>
            <select style={S.select} value={requestForm.client} onChange={e => setRequestForm(f => ({ ...f, client: e.target.value }))}>
              <option value="">Select client</option>
              {clients.map(c => <option key={c.id} value={c.first_name}>{c.first_name} {c.last_name}</option>)}
            </select>

            <div style={S.fieldLabel}>What can you use their photos for?</div>
            {SCOPE_OPTIONS.map(opt => {
              const active = requestForm.scope.includes(opt.value);
              return (
                <div key={opt.value} style={S.scopeOption} onClick={() => {
                  setRequestForm(f => ({
                    ...f,
                    scope: active ? f.scope.filter(s => s !== opt.value) : [...f.scope, opt.value],
                  }));
                }}>
                  <div style={{ ...S.checkbox, background: active ? 'var(--accent, #92405e)' : 'var(--bg-card, #FFFCF9)', borderColor: active ? 'var(--accent, #92405e)' : '#E0DCD8' }}>
                    {active && <span style={S.checkmark}><Icon name="check" size={15} /></span>}
                  </div>
                  <div style={S.scopeOptionInfo}>
                    <span style={S.scopeOptionLabel}>{opt.label}</span>
                    <span style={S.scopeOptionDesc}>{opt.desc}</span>
                  </div>
                </div>
              );
            })}

            <div style={S.fieldLabel}>Method</div>
            <div style={S.chipRow}>
              {['digital', 'paper'].map(m => (
                <button key={m} onClick={() => setRequestForm(f => ({ ...f, method: m }))} style={{ ...S.chip, ...(requestForm.method === m ? S.chipActive : {}) }}>
                  {m === 'digital' ? 'Digital' : 'Paper'}
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Message to Client</div>
            <textarea style={S.textarea} rows={3} value={requestForm.message || settings.consentMessage} onChange={e => setRequestForm(f => ({ ...f, message: e.target.value }))} />

            {modalError && <div style={S.modalError}>{modalError}</div>}

            <button
              style={{ ...S.saveBtn, ...(sending ? S.saveBtnBusy : {}) }}
              disabled={sending}
              onClick={handleSendRequest}
            >
              {sending ? 'Sending...' : 'Send Request'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  // Accept both plain dates (YYYY-MM-DD) and full ISO timestamps. Only the
  // bare date form needs a time appended to avoid a UTC-midnight shift.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ? new Date(dateStr + 'T00:00:00')
    : new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #241B17)', margin: 0 },
  reqBtn: { background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', border: 'none', borderRadius: 22, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 },
  statCard: { background: 'var(--card, #FFFCF9)', borderRadius: 10, padding: '10px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 18, fontWeight: 700 },
  statLabel: { fontSize: 10, color: 'var(--text-muted, #6B5D54)' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #FFFCF9)', color: 'var(--text-muted, #6B5D54)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)' },

  list: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 },
  empty: { textAlign: 'center', color: 'var(--text-muted, #6B5D54)', fontSize: 14, padding: 32 },

  consentCard: { background: 'var(--card, #FFFCF9)', borderRadius: 16, padding: 14, cursor: 'pointer' },
  consentHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  consentLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 16, background: '#F0E6ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 600, color: 'var(--accent, #92405e)', flexShrink: 0 },
  consentInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  consentClient: { fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)' },
  consentDate: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  statusBadge: { padding: '4px 10px', borderRadius: 10, fontSize: 11, fontWeight: 600 },

  scopeRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  scopeTag: { padding: '3px 8px', borderRadius: 6, background: '#F0E6ED', color: 'var(--accent, #92405e)', fontSize: 11 },

  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #F0ECE8' },
  consentNotes: { fontSize: 13, color: '#8B6F5E', lineHeight: 1.4, margin: '0 0 10px', fontStyle: 'italic' },
  detailRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 0' },
  detailLabel: { fontSize: 12, color: 'var(--text-muted, #6B5D54)' },
  detailValue: { fontSize: 12, fontWeight: 600, color: 'var(--text, #241B17)' },
  actionRow: { display: 'flex', gap: 8, marginTop: 10 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 10, border: '1px solid #F0ECE8', background: 'var(--card, #FFFCF9)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #241B17)' },

  gdprCard: { background: '#F9F7F4', borderRadius: 10, padding: 14, marginTop: 4 },
  gdprTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text, #241B17)' },
  gdprText: { fontSize: 12, color: '#8B6F5E', lineHeight: 1.4, margin: '6px 0 0' },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 960, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg-card, #FFFCF9)', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary, #241B17)', margin: '0 0 16px' },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: '#8B6F5E', marginBottom: 6, marginTop: 12 },
  select: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', background: 'var(--bg-card, #FFFCF9)', outline: 'none', boxSizing: 'border-box' },
  scopeOption: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer' },
  checkbox: { width: 22, height: 22, borderRadius: 6, border: '2px solid', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  checkmark: { color: 'var(--bg-card, #FFFCF9)', fontSize: 13, fontWeight: 700 },
  scopeOptionInfo: { display: 'flex', flexDirection: 'column', gap: 1 },
  scopeOptionLabel: { fontSize: 13, fontWeight: 600, color: 'var(--text, #241B17)' },
  scopeOptionDesc: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  chipRow: { display: 'flex', gap: 8 },
  chip: { flex: 1, padding: '10px 0', borderRadius: 10, border: '1px solid #F0ECE8', background: 'var(--bg-card, #FFFCF9)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', textAlign: 'center' },
  chipActive: { background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', border: '1px solid #C76B8A' },
  textarea: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 13, fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', outline: 'none', resize: 'vertical', boxSizing: 'border-box' },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 },
  saveBtnBusy: { opacity: 0.6, cursor: 'default' },

  actionBtnBusy: { opacity: 0.6, cursor: 'default' },

  toast: { background: '#E8F5E9', color: '#2E7D32', borderRadius: 10, padding: '10px 14px', fontSize: 13, fontWeight: 500, marginBottom: 12 },

  errorBanner: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, background: '#FFEBEE', color: '#C62828', borderRadius: 10, padding: '10px 14px', fontSize: 13, fontWeight: 500, marginBottom: 12 },
  retryBtn: { background: '#C62828', color: '#fff', border: 'none', borderRadius: 10, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 },

  modalError: { background: '#FFEBEE', color: '#C62828', borderRadius: 10, padding: '10px 12px', fontSize: 13, fontWeight: 500, marginTop: 16 },
};
