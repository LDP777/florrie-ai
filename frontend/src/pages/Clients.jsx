import { useState, useEffect } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useBeautician, insertRow, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import { todayLocal } from '../lib/dates.js';

function getToken() {
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
 * Wrap a #rrggbb hex with an alpha value. Used by tag chips so each chip
 * gets a soft tinted background that respects the parent palette.
 */
function hexWithAlpha(hex, alpha) {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) return hex;
  const trimmed = hex.replace('#', '');
  if (trimmed.length !== 6) return hex;
  const r = parseInt(trimmed.slice(0, 2), 16);
  const g = parseInt(trimmed.slice(2, 4), 16);
  const b = parseInt(trimmed.slice(4, 6), 16);
  if ([r, g, b].some(n => isNaN(n))) return hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Clients: view, search, filter, sort, multi-select, add, and manage the client list.
 * Wired to Supabase.
 */

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'cooling', label: 'Cooling' },
  { id: 'dormant', label: 'Dormant' },
  { id: 'new', label: 'New' },
];

const SORTS = [
  { id: 'recent', label: 'Recently visited' },
  { id: 'az', label: 'A to Z' },
  { id: 'visits', label: 'Most visits' },
  { id: 'added', label: 'Recently added' },
];

// Compute the bucket a client falls into based on last visit date.
function bucketFor(c) {
  if (!c.last_visit_at) return 'new';
  const days = Math.floor((Date.now() - new Date(c.last_visit_at).getTime()) / 86400000);
  if (days < 30) return 'active';
  if (days < 60) return 'cooling';
  return 'dormant';
}

export default function Clients() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { beautician, loading: bLoading } = useBeautician();
  const [clients, setClients] = useState([]);
  // Day 5: { client_id: [{ id, name, color }] } so each card can render up
  // to 2 tag chips. Built from a single client_tag_assignments query.
  const [tagMap, setTagMap] = useState({});
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('recent');
  const [sortOpen, setSortOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [clientDetail, setClientDetail] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newClient, setNewClient] = useState({
    first_name: '', last_name: '', phone: '', email: '', notes: ''
  });
  const [saving, setSaving] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [toast, setToast] = useState(null);

  // Just-imported filter, read from URL so a deep-link from the import flow
  // keeps working after a refresh.
  const justImportedBatchId = searchParams.get('just_imported') || null;
  const justImportedAtRaw = searchParams.get('imported_at');
  const justImportedAt = justImportedAtRaw ? new Date(justImportedAtRaw) : null;
  const justImportedExpectedCount = parseInt(searchParams.get('count') || '0', 10) || null;
  const undoWindowOpen = justImportedAt
    ? (Date.now() - justImportedAt.getTime()) < 60 * 60 * 1000
    : false;

  useEffect(() => {
    if (beautician) loadClients();
  }, [beautician]);

  // Auto-open client panel when navigated here with { state: { clientId } }
  useEffect(() => {
    if (location.state?.clientId) {
      loadClientDetail(location.state.clientId);
    }
  }, [location.state?.clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search, server-side for text, client-side for filter chips.
  useEffect(() => {
    if (!beautician) return;
    const timer = setTimeout(() => { setLoading(true); loadClients(); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  /**
   * Day 5: hydrate tagMap from client_tag_assignments + client_tags.
   * Fails silent: an empty tag map just hides the chips, doesn't break
   * the list.
   */
  async function loadTagsFor(clientList) {
    if (!beautician) return;
    const ids = clientList.map(c => c.id);
    if (!ids.length) { setTagMap({}); return; }
    try {
      const { data, error: tagErr } = await supabase
        .from('client_tag_assignments')
        .select('client_id, tag_id, client_tags ( id, name, color )')
        .in('client_id', ids);
      if (tagErr) {
        logger.warn('Load tags:', tagErr);
        setTagMap({});
        return;
      }
      const next = {};
      (data || []).forEach(row => {
        const tag = row.client_tags;
        if (!tag) return;
        if (!next[row.client_id]) next[row.client_id] = [];
        // Cap each card at 2 chips so it stays scannable.
        if (next[row.client_id].length < 2) {
          next[row.client_id].push({ id: tag.id, name: tag.name, color: tag.color });
        }
      });
      setTagMap(next);
    } catch (err) {
      logger.warn('Tag map build failed:', err);
      setTagMap({});
    }
  }

  async function loadClients() {
    try {
      setError(null);

      let q = supabase
        .from('clients')
        .select('*')
        .eq('beautician_id', beautician.id)
        .order('last_visit_at', { ascending: false, nullsFirst: false });

      if (search) {
        // Search across name, email AND phone digits. We strip non-digits from
        // the search input and only run the phone match if there's something
        // numeric left, otherwise Postgres complains about an empty pattern.
        const digits = search.replace(/\D/g, '');
        const escaped = search.replace(/[%,]/g, '');
        const parts = [
          `first_name.ilike.%${escaped}%`,
          `last_name.ilike.%${escaped}%`,
          `email.ilike.%${escaped}%`,
        ];
        if (digits.length >= 3) parts.push(`phone.ilike.%${digits}%`);
        q = q.or(parts.join(','));
      }

      const { data, error: qError } = await q;
      if (qError) {
        logger.error('Load clients:', qError);
        setError(qError.message);
      } else {
        setClients(data || []);
        // Day 5: pull tags for these clients. Single roundtrip, joined.
        loadTagsFor(data || []);
      }
    } catch (err) {
      logger.error('Load clients error:', err);
      setError(err.message || 'Failed to load clients');
    } finally {
      setLoading(false);
    }
  }

  // Apply filter chip + sort on top of the loaded list (client-side).
  // The just-imported URL filter wins over the bucket chip so the user sees
  // exactly what just landed.
  function applyFilterSort(list) {
    let out = list;
    if (justImportedBatchId) {
      out = out.filter(c => c.import_batch_id === justImportedBatchId);
    } else if (filter !== 'all') {
      out = out.filter(c => bucketFor(c) === filter);
    }
    const sorted = [...out];
    if (justImportedBatchId) {
      // Imported batch: newest first inside the batch.
      sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    } else if (sort === 'az') {
      sorted.sort((a, b) => `${a.first_name} ${a.last_name || ''}`.localeCompare(`${b.first_name} ${b.last_name || ''}`));
    } else if (sort === 'visits') {
      sorted.sort((a, b) => (b.total_visits || 0) - (a.total_visits || 0));
    } else if (sort === 'added') {
      sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    } // 'recent' is already the default order from the query
    return sorted;
  }

  function clearJustImported() {
    const next = new URLSearchParams(searchParams);
    next.delete('just_imported');
    next.delete('imported_at');
    next.delete('count');
    setSearchParams(next, { replace: true });
  }

  async function undoLastImport() {
    if (!justImportedBatchId) return;
    const expected = justImportedExpectedCount || filtered.length;
    if (!window.confirm(`Permanently remove ${expected} ${expected === 1 ? 'client' : 'clients'}?`)) return;

    setUndoing(true);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/migrate/undo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ batch_id: justImportedBatchId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not undo the import');
        setUndoing(false);
        return;
      }
      setToast(`Import undone. ${data.undone || 0} ${data.undone === 1 ? 'client' : 'clients'} removed.`);
      setTimeout(() => setToast(null), 4000);
      clearJustImported();
      await loadClients();
    } catch (err) {
      logger.error('Undo error:', err);
      setError('Could not reach the server to undo this import.');
    } finally {
      setUndoing(false);
    }
  }

  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  function messageSelected() {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    const recipients = clients.filter(c => selectedIds.has(c.id));
    navigate('/messaging', { state: { recipients, prefilledFrom: 'clients' } });
  }

  // Count summary across the *full* loaded list, not the filtered one.
  const counts = clients.reduce((acc, c) => {
    const b = bucketFor(c);
    acc[b] = (acc[b] || 0) + 1;
    return acc;
  }, {});
  const filtered = applyFilterSort(clients);

  async function loadClientDetail(id) {
    try {
      const [clientRes, apptsRes, msgsRes] = await Promise.all([
        supabase.from('clients').select('*').eq('id', id).maybeSingle(),
        supabase.from('appointments').select('*, treatments(name)').eq('client_id', id).order('starts_at', { ascending: false }).limit(10),
        supabase.from('messages').select('*').eq('client_id', id).order('created_at', { ascending: false }).limit(5),
      ]);

      if (!clientRes.data) {
        logger.warn('Client not found for id:', id);
        return;
      }

      // Loyalty balance + progress, fail-soft: the panel works without it.
      let loyalty = null;
      try {
        const [{ data: cfg }, { data: ledger }] = await Promise.all([
          supabase.from('loyalty_config').select('is_active, reward_threshold').eq('beautician_id', beautician.id).maybeSingle(),
          supabase.from('loyalty_points').select('points').eq('client_id', id),
        ]);
        if (cfg?.is_active) {
          loyalty = {
            balance: (ledger || []).reduce((sum, row) => sum + (row.points || 0), 0),
            threshold: cfg.reward_threshold || 100,
          };
        }
      } catch { /* loyalty is optional, never block the panel */ }

      setClientDetail({
        client: clientRes.data,
        appointments: apptsRes.data || [],
        messages: msgsRes.data || [],
        loyalty,
      });
      setSelected(id);
    } catch (err) {
      logger.error('Client detail error:', err);
    }
  }

  async function handleAddClient() {
    if (!newClient.first_name.trim() || !beautician) return;
    setSaving(true);
    try {
      await insertRow('clients', { ...newClient, beautician_id: beautician.id });
      setNewClient({ first_name: '', last_name: '', phone: '', email: '', notes: '' });
      setShowAdd(false);
      loadClients();
    } catch (err) {
      logger.error('Add client error:', err);
    } finally {
      setSaving(false);
    }
  }

  async function handleExportCSV() {
    try {
      const session = await supabase.auth.getSession();
      if (!session.data.session) return;

      const res = await fetch(`${API_BASE}/api/exports/clients`, {
        headers: { 'Authorization': `Bearer ${session.data.session.access_token}` }
      });

      if (!res.ok) throw new Error('Export failed');

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clients-${todayLocal()}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      logger.error('Export error:', err);
      alert('Failed to export clients');
    }
  }

  const visitCount = (c) => c.total_visits || 0;
  const lastVisit = (c) => {
    if (!c.last_visit_at) return 'No visits yet';
    const d = new Date(c.last_visit_at);
    const now = new Date();
    const days = Math.floor((now - d) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 30) return `${days} days ago`;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };

  if (bLoading) return <PageLoader />;

  return (
    <div style={styles.page}>
      {error && <ErrorCard message={error} onDismiss={() => setError(null)} />}
      <div style={styles.header}>
        <h1 style={styles.title}>Clients</h1>
        <div style={styles.headerActions}>
          {!selectMode && (
            <>
              <button
                onClick={() => setSelectMode(true)}
                style={styles.exportBtn}
                aria-label="Select multiple clients"
              >Select</button>
              <button onClick={handleExportCSV} style={styles.exportBtn}>Export</button>
              <button onClick={() => setShowAdd(!showAdd)} style={styles.addBtn}>+ Add</button>
            </>
          )}
          {selectMode && (
            <button onClick={exitSelectMode} style={styles.addBtn}>Done</button>
          )}
        </div>
      </div>

      {/* Just-imported banner: shown above the list whenever a batch_id is in the URL */}
      {justImportedBatchId && (
        <div style={styles.justImportedBanner}>
          <div style={styles.justImportedTitle}>
            {filtered.length || justImportedExpectedCount || 0} just landed
          </div>
          <div style={styles.justImportedSub}>Tap any to add notes or correct mistakes.</div>
          <div style={styles.justImportedActions}>
            <button onClick={clearJustImported} style={styles.bannerLinkBtn}>Show all clients</button>
            {undoWindowOpen && (
              <button
                onClick={undoLastImport}
                disabled={undoing}
                style={{ ...styles.bannerLinkBtn, color: 'var(--danger, #D4605C)' }}
              >
                {undoing ? 'Undoing...' : 'Undo this import'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Toast for undo confirmation */}
      {toast && (
        <div style={styles.toast}>{toast}</div>
      )}

      {/* Count summary across the full loaded list */}
      {clients.length > 0 && !justImportedBatchId && (
        <div style={styles.countRow}>
          <span style={styles.countTotal}>{clients.length} total</span>
          <span style={styles.countSep}>·</span>
          <span style={styles.countActive}>{counts.active || 0} active</span>
          <span style={styles.countSep}>·</span>
          <span style={styles.countCooling}>{counts.cooling || 0} cooling</span>
          <span style={styles.countSep}>·</span>
          <span style={styles.countDormant}>{counts.dormant || 0} dormant</span>
        </div>
      )}

      {/* Search */}
      <div style={styles.searchWrap}>
        <input
          type="text"
          placeholder="Search by name, phone, or email..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={styles.searchInput}
        />
        {search && (
          <button onClick={() => setSearch('')} style={styles.clearBtn}>×</button>
        )}
      </div>

      {/* Filter chips + sort menu */}
      <div style={styles.controlsRow}>
        <div style={styles.chipsWrap}>
          {FILTERS.map(f => {
            const count = f.id === 'all' ? clients.length : (counts[f.id] || 0);
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                style={{
                  ...styles.chip,
                  background: active ? 'var(--accent)' : 'var(--bg-card)',
                  color: active ? '#fff' : 'var(--text-secondary)',
                  borderColor: active ? 'var(--accent)' : 'var(--border)',
                }}
              >
                {f.label} <span style={{ opacity: 0.75, fontWeight: 500 }}>{count}</span>
              </button>
            );
          })}
        </div>
        <div style={styles.sortWrap}>
          <button
            onClick={() => setSortOpen(o => !o)}
            style={styles.sortBtn}
            aria-haspopup="menu"
            aria-expanded={sortOpen}
          >
            Sort: {SORTS.find(s => s.id === sort)?.label || 'Recent'}
          </button>
          {sortOpen && (
            <div style={styles.sortMenu} role="menu">
              {SORTS.map(s => (
                <button
                  key={s.id}
                  onClick={() => { setSort(s.id); setSortOpen(false); }}
                  style={{
                    ...styles.sortItem,
                    background: sort === s.id ? 'var(--accent-light)' : 'transparent',
                    color: sort === s.id ? 'var(--accent)' : 'var(--text-primary)',
                  }}
                  role="menuitem"
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Add client form */}
      {showAdd && (
        <div style={styles.addForm}>
          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>First name</label>
              <input type="text" value={newClient.first_name} onChange={e => setNewClient(p => ({ ...p, first_name: e.target.value }))} placeholder="e.g. Sarah" style={styles.formInput} autoFocus />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Last name</label>
              <input type="text" value={newClient.last_name} onChange={e => setNewClient(p => ({ ...p, last_name: e.target.value }))} placeholder="e.g. Jones" style={styles.formInput} />
            </div>
          </div>
          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Phone</label>
            <input type="tel" value={newClient.phone} onChange={e => setNewClient(p => ({ ...p, phone: e.target.value }))} placeholder="07xxx xxx xxx" style={styles.formInput} />
          </div>
          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Email</label>
            <input type="email" value={newClient.email} onChange={e => setNewClient(p => ({ ...p, email: e.target.value }))} placeholder="Optional" style={styles.formInput} />
          </div>
          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Notes</label>
            <input type="text" value={newClient.notes} onChange={e => setNewClient(p => ({ ...p, notes: e.target.value }))} placeholder="e.g. Sensitive skin, prefers mornings" style={styles.formInput} />
          </div>
          <div style={styles.formActions}>
            <button onClick={handleAddClient} disabled={!newClient.first_name.trim() || saving} style={styles.saveBtn}>
              {saving ? 'Saving...' : 'Add Client'}
            </button>
            <button onClick={() => setShowAdd(false)} style={styles.cancelBtn}>Cancel</button>
          </div>
        </div>
      )}

      {/* Client list */}
      {loading && clients.length === 0 ? (
        <PageLoader message="Loading clients..." />
      ) : clients.length === 0 ? (
        <EmptyState
          icon="👥"
          title={search ? 'No matches' : 'No clients yet'}
          subtitle={search ? 'Try a different search.' : 'Add clients manually or import from your old scheduler.'}
          actionLabel={search ? null : 'Import clients'}
          onAction={search ? null : () => navigate('/import')}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="🔍"
          title="No clients in this view"
          subtitle={`Nothing matches ${FILTERS.find(f => f.id === filter)?.label || filter}${search ? ' and the current search' : ''}. Try a different filter.`}
          actionLabel="Show all"
          onAction={() => { setFilter('all'); setSearch(''); }}
        />
      ) : (
        <div style={{ ...styles.list, paddingBottom: selectMode && selectedIds.size > 0 ? 80 : 0 }}>
          {filtered.map(c => {
            const isChecked = selectedIds.has(c.id);
            return (
              <button
                key={c.id}
                onClick={() => selectMode ? toggleSelect(c.id) : loadClientDetail(c.id)}
                style={{
                  ...styles.clientCard,
                  borderLeftColor: (selected === c.id || isChecked) ? 'var(--accent)' : 'transparent',
                  background: isChecked ? 'var(--accent-light)' : 'var(--bg-card)',
                }}
              >
                {selectMode && (
                  <div style={{ ...styles.checkbox, background: isChecked ? 'var(--accent)' : 'transparent', borderColor: isChecked ? 'var(--accent)' : 'var(--border)' }}>
                    {isChecked && <span style={styles.checkmark}>✓</span>}
                  </div>
                )}
                <div style={styles.clientAvatar}>
                  {(c.first_name?.[0] || '?').toUpperCase()}
                </div>
                <div style={styles.clientInfo}>
                  <span style={styles.clientName}>
                    {c.first_name} {c.last_name || ''}
                    {c.imported_from && <span style={styles.importedChip}>imported</span>}
                  </span>
                  <span style={styles.clientMeta}>{visitCount(c)} visits · Last: {lastVisit(c)}</span>
                  {(tagMap[c.id]?.length || 0) > 0 && (
                    <span style={styles.tagChipRow}>
                      {tagMap[c.id].slice(0, 2).map(tag => (
                        <span
                          key={tag.id}
                          style={{
                            ...styles.tagChip,
                            background: hexWithAlpha(tag.color || '#C76B8A', 0.16),
                            color: tag.color || 'var(--accent)',
                            borderColor: hexWithAlpha(tag.color || '#C76B8A', 0.32),
                          }}
                        >
                          {tag.name}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                {!selectMode && <span style={styles.chevron}>›</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Floating action bar for multi-select */}
      {selectMode && selectedIds.size > 0 && (
        <div style={styles.actionBar}>
          <span style={styles.actionCount}>{selectedIds.size} selected</span>
          <button onClick={messageSelected} style={styles.actionBtnPrimary}>Message all</button>
        </div>
      )}

      {/* Client detail panel */}
      {clientDetail && selected && !selectMode && (
        <ClientDetailPanel
          detail={clientDetail}
          onClose={() => { setSelected(null); setClientDetail(null); }}
          onNavigate={navigate}
        />
      )}
    </div>
  );
}

/**
 * Enhanced client detail panel with tabs:
 * Overview: stats + tags + quick actions
 * History:  appointment timeline
 * Notes:    client notes + preferences
 * Messages: embedded conversation (Day 5)
 */
function ClientDetailPanel({ detail, onClose, onNavigate }) {
  const [detailTab, setDetailTab] = useState('overview');
  const client = detail.client;
  const appointments = detail.appointments || [];
  const messages = detail.messages || [];

  // Day 5: full thread loaded lazily when the Messages tab opens.
  const [thread, setThread] = useState(null); // { messages, default_channel }
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [replyChannel, setReplyChannel] = useState(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (detailTab !== 'messages' || !client?.id) return;
    let cancelled = false;
    async function load() {
      setThreadLoading(true);
      setThreadError(null);
      try {
        const token = getToken();
        const res = await fetch(`${API_BASE}/api/inbox/thread/${encodeURIComponent(client.id)}`, {
          headers: { Authorization: token ? `Bearer ${token}` : '' },
        });
        if (!res.ok) {
          setThreadError('Could not load the thread.');
          return;
        }
        const json = await res.json();
        if (cancelled) return;
        setThread(json);
        setReplyChannel(json.default_channel || 'sms');
      } catch {
        if (!cancelled) setThreadError('Could not reach the server.');
      } finally {
        if (!cancelled) setThreadLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [detailTab, client?.id]);

  async function sendReply() {
    if (!replyText.trim() || !client?.id || !replyChannel) return;
    setSending(true);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/inbox/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          client_id: client.id,
          channel: replyChannel,
          body: replyText.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setThreadError(data.error || 'Could not send.');
        return;
      }
      // Append the new bubble so the user sees it land instantly.
      setThread(prev => prev ? ({
        ...prev,
        messages: [...(prev.messages || []), {
          id: data.message?.id || `local-${Date.now()}`,
          channel: replyChannel,
          direction: 'outbound',
          body: replyText.trim(),
          content: replyText.trim(),
          created_at: new Date().toISOString(),
        }],
      }) : prev);
      setReplyText('');
    } catch {
      setThreadError('Could not reach the server.');
    } finally {
      setSending(false);
    }
  }

  // Client health score (simple heuristic)
  const daysSinceVisit = client?.last_visit_at
    ? Math.floor((Date.now() - new Date(client.last_visit_at).getTime()) / 86400000)
    : null;
  const healthLabel = daysSinceVisit === null ? 'New'
    : daysSinceVisit < 30 ? 'Active'
    : daysSinceVisit < 60 ? 'Cooling'
    : 'Dormant';
  const healthColor = healthLabel === 'Active' ? '#4CAF50'
    : healthLabel === 'Cooling' ? '#F5A623'
    : healthLabel === 'Dormant' ? '#E57373'
    : '#4A90D9';

  return (
    <div style={styles.detailOverlay} onClick={onClose}>
      <div style={styles.detailPanel} onClick={e => e.stopPropagation()}>
        <button onClick={onClose} style={styles.closeBtn}>×</button>

        {/* Header */}
        <div style={styles.detailHeader}>
          <div style={styles.detailAvatar}>
            {(client?.first_name?.[0] || '?').toUpperCase()}
          </div>
          <h2 style={styles.detailName}>{client?.first_name} {client?.last_name || ''}</h2>
          <div style={styles.detailBadges}>
            <span style={{
              ...styles.healthBadge,
              background: healthColor === '#4CAF50' ? 'var(--success-bg)'
                : healthColor === '#F5A623' ? 'var(--warning-bg)'
                : healthColor === '#E57373' ? 'var(--danger-bg)'
                : 'var(--accent-light)',
              color: healthColor === '#4CAF50' ? 'var(--success)'
                : healthColor === '#F5A623' ? 'var(--warning)'
                : healthColor === '#E57373' ? 'var(--danger)'
                : 'var(--accent)',
            }}>
              {healthLabel}
            </span>
            {client?.status === 'vip' && <span style={styles.tagVip}>VIP</span>}
            {client?.no_show_count > 0 && (
              <span style={styles.tagNoShow}>No-show {client.no_show_count}x</span>
            )}
          </div>
        </div>

        {/* Contact row */}
        <div style={styles.contactRow}>
          {client?.phone && (
            <a href={`tel:${client.phone}`} style={styles.contactChip}>📞 {client.phone}</a>
          )}
          {client?.email && (
            <a href={`mailto:${client.email}`} style={styles.contactChip}>✉️ {client.email}</a>
          )}
        </div>

        {/* Quick actions */}
        <div style={styles.quickActions}>
          <button style={styles.quickActionBtn} onClick={() => setDetailTab('messages')}>
            <span style={{ fontSize: 16 }}>💬</span>
            <span>Message</span>
          </button>
          <button style={styles.quickActionBtn} onClick={() => { onClose(); onNavigate && onNavigate('/calendar'); }}>
            <span style={{ fontSize: 16 }}>📅</span>
            <span>Rebook</span>
          </button>
          <button style={styles.quickActionBtn} onClick={() => { onClose(); onNavigate && onNavigate('/promos'); }}>
            <span style={{ fontSize: 16 }}>🎁</span>
            <span>Send Offer</span>
          </button>
        </div>

        {/* Detail tabs */}
        <div style={styles.detailTabs}>
          {['overview', 'history', 'notes', 'messages'].map(t => (
            <button
              key={t}
              onClick={() => setDetailTab(t)}
              style={{
                ...styles.detailTabBtn,
                borderBottomColor: detailTab === t ? 'var(--accent)' : 'transparent',
                color: detailTab === t ? 'var(--accent)' : 'var(--text-muted)',
              }}
            >
              {t === 'overview' ? 'Overview'
                : t === 'history' ? 'History'
                : t === 'notes' ? 'Notes'
                : 'Messages'}
            </button>
          ))}
        </div>

        {/* Overview tab */}
        {detailTab === 'overview' && (
          <>
            <div style={styles.statsRow}>
              <div style={styles.statBox}>
                <span style={styles.statNum}>{client?.total_visits || 0}</span>
                <span style={styles.statLabel}>Visits</span>
              </div>
              <div style={styles.statBox}>
                <span style={styles.statNum}>£{((client?.total_spend_cents || 0) / 100).toFixed(0)}</span>
                <span style={styles.statLabel}>Spent</span>
              </div>
              <div style={styles.statBox}>
                <span style={styles.statNum}>{client?.avg_rebooking_days || '...'}</span>
                <span style={styles.statLabel}>Rebook days</span>
              </div>
            </div>

            {daysSinceVisit !== null && (
              <div style={styles.lastVisitCard}>
                <span style={styles.lastVisitLabel}>Last visit</span>
                <span style={styles.lastVisitValue}>
                  {daysSinceVisit === 0 ? 'Today' : daysSinceVisit === 1 ? 'Yesterday' : `${daysSinceVisit} days ago`}
                </span>
              </div>
            )}

            {/* Loyalty balance, only when the programme is on */}
            {detail.loyalty && (
              <div
                style={{ ...styles.lastVisitCard, cursor: 'pointer' }}
                onClick={() => { onClose(); onNavigate && onNavigate('/loyalty'); }}
              >
                <span style={styles.lastVisitLabel}>Loyalty</span>
                <span style={{ ...styles.lastVisitValue, color: 'var(--accent)' }}>
                  {detail.loyalty.balance} pts
                  {detail.loyalty.balance >= detail.loyalty.threshold
                    ? ' · reward earned'
                    : ` · ${detail.loyalty.threshold - detail.loyalty.balance} to reward`}
                </span>
              </div>
            )}

            {/* AI insight */}
            <div style={styles.aiInsight}>
              <span style={{ fontSize: 14 }}>🤖</span>
              <span style={styles.aiInsightText}>
                {healthLabel === 'Dormant' ? `${client?.first_name} hasn't been in for ${daysSinceVisit} days. Send a comeback message?`
                  : healthLabel === 'Cooling' ? `${client?.first_name}'s visits are slowing down. A rebook nudge might help.`
                  : client?.total_visits >= 5 ? `${client?.first_name} is a loyal regular, ${client?.total_visits} visits. Consider a loyalty treat.`
                  : `${client?.first_name} is building a habit. Keep the experience great.`}
              </span>
            </div>

            {/* Recent messages preview */}
            {messages.length > 0 && (
              <div style={styles.historySection}>
                <h4 style={styles.sectionLabel}>Recent messages</h4>
                {messages.slice(0, 3).map(msg => (
                  <div key={msg.id} style={styles.msgBubble}>
                    <span style={styles.msgDir}>{msg.direction === 'inbound' ? '← In' : '→ Out'}</span>
                    <span style={styles.msgText}>{msg.content?.substring(0, 80)}</span>
                    <span style={styles.msgTime}>
                      {new Date(msg.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* History tab */}
        {detailTab === 'history' && (
          <div style={styles.historySection}>
            <h4 style={styles.sectionLabel}>Appointment history</h4>
            {appointments.length === 0 ? (
              <p style={styles.noHistory}>No appointments yet</p>
            ) : (
              <div style={styles.timeline}>
                {appointments.slice(0, 15).map((appt, i) => (
                  <div key={appt.id} style={styles.timelineItem}>
                    <div style={styles.timelineDot}>
                      <div style={{
                        ...styles.dot,
                        background: appt.status === 'completed' ? 'var(--success)'
                          : appt.status === 'no_show' ? 'var(--danger)'
                          : 'var(--warning)',
                      }} />
                      {i < appointments.length - 1 && <div style={styles.timelineLine} />}
                    </div>
                    <div style={styles.timelineContent}>
                      <span style={styles.historyTreatment}>{appt.treatments?.name || 'Appointment'}</span>
                      <span style={styles.historyDate}>
                        {new Date(appt.starts_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                      </span>
                      <span style={{
                        ...styles.historyStatusBadge,
                        background: appt.status === 'completed' ? 'var(--success-bg)'
                          : appt.status === 'no_show' ? 'var(--danger-bg)'
                          : 'var(--warning-bg)',
                        color: appt.status === 'completed' ? 'var(--success)'
                          : appt.status === 'no_show' ? 'var(--danger)'
                          : 'var(--warning)',
                      }}>
                        {appt.status?.replace(/_/g, ' ')}
                      </span>
                      {appt.price_cents > 0 && (
                        <span style={styles.historyPrice}>£{(appt.price_cents / 100).toFixed(0)}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Notes tab */}
        {detailTab === 'notes' && (
          <div style={styles.notesTab}>
            <div style={styles.notesSection}>
              <h4 style={styles.sectionLabel}>Client notes</h4>
              <p style={styles.notesText}>{client?.notes || 'No notes yet. Tap to add preferences, allergies, or anything to remember.'}</p>
            </div>

            <div style={styles.prefsSection}>
              <h4 style={styles.sectionLabel}>Preferences</h4>
              <div style={styles.prefRow}>
                <span style={styles.prefIcon}>🕐</span>
                <span style={styles.prefText}>
                  {client?.preferred_time ? `Prefers ${client.preferred_time}` : 'No time preference set'}
                </span>
              </div>
              <div style={styles.prefRow}>
                <span style={styles.prefIcon}>💅</span>
                <span style={styles.prefText}>
                  {client?.preferred_treatment ? client.preferred_treatment : 'No favourite treatment yet'}
                </span>
              </div>
              <div style={styles.prefRow}>
                <span style={styles.prefIcon}>⚠️</span>
                <span style={styles.prefText}>
                  {client?.allergies ? client.allergies : 'No allergies or sensitivities noted'}
                </span>
              </div>
            </div>

            <div style={styles.clientSince}>
              Client since {client?.created_at
                ? new Date(client.created_at).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
                : 'recently'}
            </div>
          </div>
        )}

        {/* Messages tab, Day 5: embedded conversation */}
        {detailTab === 'messages' && (
          <div style={styles.messagesTab}>
            {threadLoading && (
              <div style={styles.threadLoading}>Loading conversation</div>
            )}
            {threadError && !threadLoading && (
              <div style={styles.threadError}>{threadError}</div>
            )}
            {!threadLoading && !threadError && thread && (
              <>
                <div style={styles.bubbleStack}>
                  {(thread.messages || []).slice(-20).length === 0 ? (
                    <p style={styles.noHistory}>No messages yet.</p>
                  ) : (
                    (thread.messages || []).slice(-20).map(msg => (
                      <ClientBubble key={msg.id} msg={msg} />
                    ))
                  )}
                </div>

                <div style={styles.replyComposer}>
                  <div style={styles.channelToggle}>
                    {['whatsapp', 'sms', 'email'].map(ch => {
                      const active = replyChannel === ch;
                      const icon = ch === 'whatsapp' ? '💬' : ch === 'sms' ? '📱' : '✉️';
                      return (
                        <button
                          key={ch}
                          type="button"
                          onClick={() => setReplyChannel(ch)}
                          style={{
                            ...styles.channelChip,
                            background: active ? 'var(--accent)' : 'transparent',
                            color: active ? '#fff' : 'var(--text-muted)',
                            borderColor: active ? 'var(--accent)' : 'var(--border)',
                          }}
                        >
                          <span aria-hidden>{icon}</span>
                          <span style={{ textTransform: 'capitalize' }}>{ch}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div style={styles.composerRow}>
                    <textarea
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      placeholder="Type a reply"
                      rows={2}
                      style={styles.composerInput}
                    />
                    <button
                      type="button"
                      disabled={!replyText.trim() || sending}
                      onClick={sendReply}
                      style={{
                        ...styles.composerSend,
                        opacity: !replyText.trim() || sending ? 0.5 : 1,
                      }}
                    >
                      {sending ? '...' : 'Send'}
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => { onClose(); onNavigate && onNavigate(`/inbox?client=${encodeURIComponent(client.id)}`); }}
                    style={styles.fullThreadLink}
                  >
                    See full thread
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Day 5: chat bubble inside the client detail Messages tab. Mirrors the
 * styling on /inbox so the experience feels like one conversation regardless
 * of where the user opens it from.
 */
function ClientBubble({ msg }) {
  const out = msg.direction === 'outbound';
  const icon = msg.channel === 'whatsapp' ? '💬'
    : msg.channel === 'sms' ? '📱'
    : msg.channel === 'email' ? '✉️'
    : '·';
  const body = msg.body || msg.content || '';
  const time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' }) : '';
  return (
    <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', marginBottom: 6 }}>
      <div style={{
        maxWidth: '78%',
        padding: '8px 12px',
        borderRadius: 14,
        background: out ? 'var(--accent)' : 'var(--bg-card)',
        color: out ? '#fff' : 'var(--text-primary)',
        border: out ? '1px solid var(--accent)' : '1px solid #f0d2dd',
        borderBottomLeftRadius: out ? 14 : 4,
        borderBottomRightRadius: out ? 4 : 14,
        fontSize: 13,
        lineHeight: 1.4,
        wordBreak: 'break-word',
      }}>
        <div>{body}</div>
        <div style={{
          marginTop: 4,
          fontSize: 10,
          opacity: 0.78,
          display: 'flex',
          gap: 5,
          alignItems: 'center',
        }}>
          <span aria-hidden>{icon}</span>
          <span>{time}</span>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg)',
    fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)",
    padding: '0 16px 40px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 52px)', paddingBottom: 12 },
  title: {
    fontSize: 22,
    fontWeight: 700,
    fontStyle: 'italic',
    margin: 0,
    fontFamily: "'Noto Serif', Georgia, serif",
    color: 'var(--text-primary, #1d1b19)',
    lineHeight: 1.2,
  },
  headerActions: { display: 'flex', gap: 8, alignItems: 'center' },
  exportBtn: { padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  addBtn: { padding: '8px 16px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--bg-card)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  // Count summary
  countRow: {
    display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    fontSize: 12, color: 'var(--text-muted)', marginBottom: 10,
  },
  countTotal: { fontWeight: 600, color: 'var(--text-secondary)' },
  countActive: { color: 'var(--success, #5BA97B)', fontWeight: 600 },
  countCooling: { color: 'var(--warning, #D4943A)', fontWeight: 600 },
  countDormant: { color: 'var(--danger, #D4605C)', fontWeight: 600 },
  countSep: { color: 'var(--text-muted)' },

  // Filter chips + sort
  controlsRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  chipsWrap: { display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 0, overflowX: 'auto' },
  chip: {
    padding: '6px 12px', borderRadius: 20,
    border: '1px solid var(--border)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'inherit', whiteSpace: 'nowrap',
    display: 'inline-flex', alignItems: 'center', gap: 6,
    transition: 'background 0.15s, color 0.15s',
  },
  sortWrap: { position: 'relative', flexShrink: 0 },
  sortBtn: {
    padding: '6px 10px', borderRadius: 10,
    border: '1px solid var(--border)', background: 'var(--bg-card)',
    color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
  },
  sortMenu: {
    position: 'absolute', top: '110%', right: 0, zIndex: 50,
    background: 'var(--bg-card)', borderRadius: 10,
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    minWidth: 180, padding: 4,
  },
  sortItem: {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '8px 10px', borderRadius: 8, border: 'none',
    fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
  },

  // Multi-select
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    border: '2px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    transition: 'background 0.12s, border-color 0.12s',
  },
  checkmark: { color: '#fff', fontSize: 14, fontWeight: 700, lineHeight: 1 },

  // Floating action bar
  actionBar: {
    position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
    width: 'calc(100% - 32px)', maxWidth: 448,
    background: 'var(--bg-card)', borderRadius: 14,
    padding: '10px 14px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    boxShadow: '0 6px 24px rgba(0,0,0,0.16)',
    zIndex: 100,
  },
  actionCount: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  actionBtnPrimary: {
    padding: '8px 16px', borderRadius: 10, border: 'none',
    background: 'var(--accent)', color: '#fff',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },

  searchWrap: { position: 'relative', marginBottom: 14 },
  searchInput: { width: '100%', padding: '12px 36px 12px 14px', borderRadius: 12, border: '1.5px solid var(--border)', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', background: 'var(--bg-card)' },
  clearBtn: { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', fontSize: 20, color: 'var(--text-muted)', cursor: 'pointer' },
  addForm: { background: 'var(--bg-card)', borderRadius: 14, padding: 16, marginBottom: 14, boxShadow: 'var(--shadow-sm)' },
  formRow: { display: 'flex', gap: 10 },
  formGroup: { flex: 1, marginBottom: 10 },
  formLabel: { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500 },
  formInput: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  formActions: { display: 'flex', gap: 8, marginTop: 4 },
  saveBtn: { flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--bg-card)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  cancelBtn: { padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--border-light)', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
  list: { display: 'flex', flexDirection: 'column', gap: 6 },
  clientCard: { display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-card)', borderRadius: 12, padding: '12px 14px', boxShadow: 'var(--shadow-sm)', border: 'none', borderLeft: '3px solid transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', width: '100%' },
  clientAvatar: { width: 38, height: 38, borderRadius: 19, background: 'var(--accent-light)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, flexShrink: 0 },
  clientInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  clientName: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  clientMeta: { fontSize: 11, color: 'var(--text-muted)' },
  chevron: { fontSize: 18, color: 'var(--text-muted)', flexShrink: 0 },
  detailOverlay: { position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 200, display: 'flex', justifyContent: 'center', alignItems: 'flex-end' },
  detailPanel: { background: 'var(--bg)', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto', padding: '20px 16px 40px', position: 'relative' },
  closeBtn: { position: 'absolute', top: 12, right: 16, background: 'none', border: 'none', fontSize: 24, color: 'var(--text-muted)', cursor: 'pointer' },
  detailHeader: { textAlign: 'center', paddingTop: 8, paddingBottom: 16 },
  detailAvatar: { width: 56, height: 56, borderRadius: 28, background: 'var(--accent-light)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 700, margin: '0 auto 10px' },
  detailName: {
    fontSize: 20,
    fontWeight: 700,
    margin: '0 0 4px',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  detailContact: { display: 'block', fontSize: 13, color: 'var(--accent)', textDecoration: 'none' },
  detailContactSub: { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
  tagsSection: { display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 16, flexWrap: 'wrap' },
  tagVip: { padding: '4px 10px', borderRadius: 6, background: 'var(--warning-bg)', color: 'var(--warning)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  tagDormant: { padding: '4px 10px', borderRadius: 6, background: 'var(--danger-bg)', color: 'var(--danger)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  tagLate: { padding: '4px 10px', borderRadius: 6, background: 'var(--warning-bg)', color: 'var(--warning)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  tagNoShow: { padding: '4px 10px', borderRadius: 6, background: 'var(--danger-bg)', color: 'var(--danger)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  notesSection: { background: 'var(--bg-card)', borderRadius: 12, padding: 14, marginBottom: 12, boxShadow: 'var(--shadow-sm)' },
  sectionLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 8px' },
  notesText: { fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 },
  statsRow: { display: 'flex', gap: 10, marginBottom: 16 },
  statBox: { flex: 1, background: 'var(--bg-card)', borderRadius: 12, padding: '12px 10px', textAlign: 'center', boxShadow: 'var(--shadow-sm)' },
  statNum: { display: 'block', fontSize: 18, fontWeight: 700, color: 'var(--accent)' },
  statLabel: { display: 'block', fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', marginTop: 2 },
  historySection: { background: 'var(--bg-card)', borderRadius: 12, padding: 14, marginBottom: 12, boxShadow: 'var(--shadow-sm)' },
  noHistory: { fontSize: 13, color: 'var(--text-muted)', margin: 0 },
  historyItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--bg)' },
  historyTreatment: { display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' },
  historyDate: { display: 'block', fontSize: 11, color: 'var(--text-muted)' },
  historyStatus: { fontSize: 11, fontWeight: 600, textTransform: 'capitalize' },
  msgBubble: { padding: '8px 0', borderBottom: '1px solid var(--bg)', display: 'flex', gap: 8, alignItems: 'flex-start' },
  msgDir: { fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', marginTop: 2 },
  msgText: { fontSize: 12, color: 'var(--text-secondary)', flex: 1, lineHeight: 1.4 },
  msgTime: { fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' },
  loadingText: { textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 14, fontFamily: "var(--font-body, 'DM Sans', sans-serif)" },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 6px' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 },

  // Enhanced detail panel
  detailBadges: { display: 'flex', gap: 6, justifyContent: 'center', marginTop: 8, flexWrap: 'wrap' },
  healthBadge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  contactRow: { display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 12 },
  contactChip: { fontSize: 12, color: 'var(--text-secondary)', textDecoration: 'none', padding: '4px 10px', borderRadius: 8, background: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)' },
  quickActions: { display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 16 },
  quickActionBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    padding: '10px 16px', borderRadius: 10, border: 'none',
    background: 'var(--accent-light)', color: 'var(--accent)', fontSize: 11, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  detailTabs: { display: 'flex', gap: 20, borderBottom: '1px solid var(--border)', marginBottom: 14 },
  detailTabBtn: {
    padding: '8px 0', background: 'none', border: 'none',
    borderBottom: '2px solid transparent', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  lastVisitCard: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 14px', borderRadius: 10, background: 'var(--bg-card)',
    boxShadow: 'var(--shadow-sm)', marginBottom: 10,
  },
  lastVisitLabel: { fontSize: 12, color: 'var(--text-muted)' },
  lastVisitValue: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  aiInsight: {
    display: 'flex', gap: 8, alignItems: 'flex-start',
    padding: 12, borderRadius: 10, background: 'linear-gradient(135deg, var(--accent-light) 0%, #F5EFFC 100%)',
    marginBottom: 12,
  },
  aiInsightText: { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 },
  timeline: { display: 'flex', flexDirection: 'column' },
  timelineItem: { display: 'flex', gap: 12, minHeight: 50 },
  timelineDot: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12, flexShrink: 0 },
  dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  timelineLine: { width: 2, flex: 1, background: 'var(--border)', marginTop: 4 },
  timelineContent: { flex: 1, paddingBottom: 12 },
  historyStatusBadge: {
    display: 'inline-block', padding: '2px 8px', borderRadius: 4,
    fontSize: 10, fontWeight: 600, textTransform: 'capitalize', marginTop: 4,
  },
  historyPrice: { display: 'inline-block', fontSize: 12, color: 'var(--accent)', fontWeight: 600, marginLeft: 8, marginTop: 4 },
  notesTab: { display: 'flex', flexDirection: 'column', gap: 12 },
  prefsSection: { background: 'var(--bg-card)', borderRadius: 12, padding: 14, boxShadow: 'var(--shadow-sm)' },
  prefRow: { display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--bg)' },
  prefIcon: { fontSize: 16, flexShrink: 0 },
  prefText: { fontSize: 13, color: 'var(--text-secondary)' },
  clientSince: { textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', paddingTop: 8 },

  // Just-imported banner
  justImportedBanner: {
    background: 'var(--accent-light, #FFF0F3)',
    borderRadius: 12,
    padding: '12px 14px',
    marginBottom: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  justImportedTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--accent, #C76B8A)',
  },
  justImportedSub: {
    fontSize: 12,
    color: 'var(--text-secondary, #8B6F5E)',
    lineHeight: 1.4,
  },
  justImportedActions: {
    display: 'flex',
    gap: 14,
    marginTop: 6,
  },
  bannerLinkBtn: {
    background: 'none',
    border: 'none',
    padding: 0,
    color: 'var(--accent, #C76B8A)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textDecoration: 'underline',
  },
  importedChip: {
    display: 'inline-block',
    marginLeft: 6,
    padding: '1px 6px',
    borderRadius: 4,
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    background: 'var(--accent-light, #FFF0F3)',
    color: 'var(--accent, #C76B8A)',
    verticalAlign: 'middle',
  },
  tagChipRow: {
    display: 'inline-flex',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  tagChip: {
    display: 'inline-block',
    padding: '2px 7px',
    borderRadius: 999,
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.02em',
    border: '1px solid transparent',
    lineHeight: 1.3,
  },
  messagesTab: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    paddingTop: 8,
  },
  threadLoading: {
    fontSize: 12,
    color: 'var(--text-muted, #B5AFA8)',
    textAlign: 'center',
    padding: '14px 0',
  },
  threadError: {
    fontSize: 12,
    color: 'var(--danger, #c0464e)',
    textAlign: 'center',
    padding: '14px 0',
  },
  bubbleStack: {
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg, #fef8f4)',
    border: '1px solid rgba(146,64,94,0.08)',
    borderRadius: 14,
    padding: '12px 10px',
    maxHeight: 260,
    overflowY: 'auto',
  },
  replyComposer: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  channelToggle: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
  },
  channelChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 10px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    border: '1px solid',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  composerRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-end',
  },
  composerInput: {
    flex: 1,
    minWidth: 0,
    padding: '8px 10px',
    border: '1px solid rgba(146,64,94,0.18)',
    borderRadius: 10,
    fontFamily: 'inherit',
    fontSize: 13,
    resize: 'vertical',
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
  },
  composerSend: {
    padding: '8px 14px',
    background: 'var(--accent, #C76B8A)',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
  },
  fullThreadLink: {
    alignSelf: 'flex-end',
    background: 'transparent',
    border: 'none',
    color: 'var(--accent, #92405e)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: '4px 0',
    textDecoration: 'underline',
  },
  toast: {
    position: 'fixed',
    bottom: 80,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'var(--text-primary, #2D2A26)',
    color: '#fff',
    padding: '10px 16px',
    borderRadius: 10,
    fontSize: 13,
    fontWeight: 500,
    zIndex: 300,
    boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
  },
};
