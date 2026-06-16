import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Campaigns, AI-powered client outreach.
 *
 * Types:
 *   Reactivation , "We miss you" messages to dormant clients
 *   Rescue        , Saves cancellations / no-shows with rebooking offer
 *   Weather       , "Rain = pamper day" triggered by forecast
 *   Bank Holiday  , Holiday promo blasts
 *   Event         , Christmas, Valentine's, Mother's Day, etc
 *   Custom        , One-off campaign from scratch
 *
 * Flow: AI drafts → beautician approves → sent via WhatsApp/SMS
 */

const TYPE_CONFIG = {
  reactivation: { label: 'Comeback', icon: '💌', color: 'var(--accent, #C76B8A)', desc: 'Win back clients who haven\'t visited in a while' },
  rescue: { label: 'Rescue', icon: '🆘', color: 'var(--danger, #D4605C)', desc: 'Save a cancellation with a quick rebook offer' },
  weather: { label: 'Weather', icon: '🌧️', color: 'var(--info, #4A90D9)', desc: 'Bad weather = pamper day. Triggered by forecast' },
  bank_holiday: { label: 'Bank Holiday', icon: '🎉', color: 'var(--warning, #D4943A)', desc: 'Promo blast before long weekends' },
  event: { label: 'Seasonal', icon: '🎄', color: 'var(--success, #5BA97B)', desc: 'Christmas, Valentine\'s, Mother\'s Day specials' },
  custom: { label: 'Custom', icon: '✏️', color: 'var(--text-secondary, #8A8580)', desc: 'Write your own campaign from scratch' },
};

const STATUS_LABELS = {
  draft: { label: 'Draft', color: 'var(--warning, #D4943A)', bg: 'var(--warning-bg, #FFF8E1)' },
  approved: { label: 'Ready', color: 'var(--info, #4A90D9)', bg: 'var(--info-bg, #EEF4FC)' },
  sending: { label: 'Sending', color: 'var(--accent, #C76B8A)', bg: 'var(--accent-light, #FFF0F3)' },
  sent: { label: 'Sent', color: 'var(--success, #5BA97B)', bg: 'var(--success-bg, #EDF7F0)' },
  cancelled: { label: 'Cancelled', color: 'var(--text-muted, #AAA5A0)', bg: 'var(--bg-subtle, #F5F2EF)' },
};

// Message templates per type (Ellie's tone)
const MESSAGE_TEMPLATES = {
  reactivation: [
    "Hey {name} 💕 It's been a while since your last appointment! I'd love to get you booked back in. I've got availability this week if you fancy it, DM me or book via my link xx",
    "Hey {name}, miss your face! ✨ Fancy getting your brows done? I've got a few slots open this week. Let me know xx",
    "Hey lovely, just checking in! It's been {days} days since your last visit. Shall I pop you in for your usual? xx",
  ],
  rescue: [
    "Hey {name}, I saw your cancellation, no worries at all! If you want to rebook for another day this week I can squeeze you in. Let me know xx",
    "No stress about cancelling {name} 💕 Want me to move you to later this week instead? I've got {day} free xx",
  ],
  weather: [
    "Rainy day = perfect pamper day ☔✨ I've got last-minute slots today and tomorrow. Fancy treating yourself? DM me xx",
    "This weather is grim but at least your brows can look incredible 😂 Got availability today, grab it while you can xx",
  ],
  bank_holiday: [
    "Bank holiday weekend sorted? ✨ Get your brows done before the long weekend, limited slots left! Book now xx",
    "Long weekend coming up! Make sure your brows are on point 💕 I've got a few slots left, first come first served xx",
  ],
  event: [
    "Christmas party season is here ✨ Get your brows looking perfect for all those dos! Booking up fast xx",
    "Valentine's ready? 💕 Treat yourself to gorgeous brows before the big day. DM me to book xx",
    "Mother's Day gift idea 💝 A brow treatment voucher! DM me if you want to grab one for your mum xx",
  ],
  custom: [
    "Hey {name}, ",
  ],
};

export default function Campaigns() {
  const { beautician, loading: bLoading } = useBeautician();
  const [campaigns, setCampaigns] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('active'); // active | history | create
  const [creating, setCreating] = useState(false);
  const [selectedType, setSelectedType] = useState(null);
  const [form, setForm] = useState({ name: '', message: '', targetCount: 0 });
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);

  useEffect(() => { if (beautician && !bLoading) loadCampaigns(); }, [beautician, bLoading]);

  async function loadCampaigns() {
    setLoading(true);
    try {
      const [campaignData, clientData] = await Promise.all([
        fetchRows('campaigns', beautician.id, { order: 'created_at', ascending: false }),
        fetchRows('clients', beautician.id),
      ]);
      setCampaigns(campaignData);
      setClients(clientData || []);
    } catch (err) {
      logger.error('Load campaigns:', err);
    }
    setLoading(false);
  }

  // Real audience size for a campaign type, derived from loaded clients.
  function audienceForType(type) {
    if (type === 'reactivation') {
      const cutoff = Date.now() - 30 * 86400000;
      return clients.filter(c =>
        c.status === 'dormant' || c.status === 'lost' ||
        (c.last_visit_at && new Date(c.last_visit_at).getTime() < cutoff)
      ).length;
    }
    // Rescue targets a single client who just cancelled - the recipient is chosen
    // at send time, so we don't claim a count up front.
    if (type === 'rescue') return null;
    // Broadcast types reach the active client base.
    return clients.filter(c => c.status !== 'lost').length;
  }

  function startCreate(type) {
    const templates = MESSAGE_TEMPLATES[type] || MESSAGE_TEMPLATES.custom;
    const template = templates[Math.floor(Math.random() * templates.length)];
    const cfg = TYPE_CONFIG[type];

    // Real audience size from loaded clients (null = chosen at send time).
    const targetCount = audienceForType(type);

    setForm({
      name: `${cfg.label}, ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
      message: template,
      targetCount,
    });
    setSelectedType(type);
    setCreating(true);
    setTab('create');
  }

  async function handleSave() {
    if (!form.message.trim() || !beautician) return;
    setSaving(true);
    try {
      const campaign = await insertRow('campaigns', {
        beautician_id: beautician.id,
        type: selectedType,
        name: form.name,
        message_template: form.message,
        target_count: form.targetCount,
        status: 'draft',
      });
      setCampaigns(prev => [campaign, ...prev]);
      setCreating(false);
      setTab('active');
    } catch (err) {
      logger.error('Save campaign:', err);
    }
    setSaving(false);
  }

  async function handleApprove(id) {
    try {
      await updateRow('campaigns', id, { status: 'approved', approved_at: new Date().toISOString() });
      setCampaigns(prev => prev.map(c => c.id === id ? { ...c, status: 'approved' } : c));
    } catch (err) {
      logger.error('Approve campaign:', err);
    }
  }

  async function handleCancel(id) {
    try {
      await updateRow('campaigns', id, { status: 'cancelled' });
      setCampaigns(prev => prev.map(c => c.id === id ? { ...c, status: 'cancelled' } : c));
    } catch (err) {
      logger.error('Cancel campaign:', err);
    }
  }

  const active = campaigns.filter(c => ['draft', 'approved', 'sending'].includes(c.status));
  const history = campaigns.filter(c => ['sent', 'cancelled'].includes(c.status));

  // Compute a contextual AI suggestion based on actual campaign state
  const nextBankHoliday = (() => {
    const now = new Date();
    const year = now.getFullYear();
    // UK bank holidays (approximate, covers the common ones)
    const holidays = [
      new Date(year, 0, 1), new Date(year, 3, 18), new Date(year, 3, 21),
      new Date(year, 4, 5), new Date(year, 4, 26), new Date(year, 7, 25),
      new Date(year, 11, 25), new Date(year, 11, 26),
    ];
    return holidays.find(h => h > now && (h - now) / 86400000 <= 14);
  })();

  function getAiSuggestion() {
    if (nextBankHoliday) {
      const dayName = nextBankHoliday.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
      return { type: 'bank_holiday', text: `Bank holiday coming up on ${dayName}. A promo blast before the long weekend could fill your book.` };
    }
    return { type: 'reactivation', text: 'Some of your clients haven\'t visited in a while. A comeback campaign could bring them back.' };
  }
  const aiSuggestion = getAiSuggestion();

  return (
    <div style={styles.page}>
      <PageHeader title="Campaigns" subtitle="Your Growth Engine" />

      {/* Tabs */}
      <div style={styles.tabs}>
        {[
          { key: 'active', label: `Active${active.length ? ` (${active.length})` : ''}` },
          { key: 'history', label: 'History' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setCreating(false); }}
            style={{
              ...styles.tab,
              borderBottomColor: tab === t.key || (tab === 'create' && t.key === 'active') ? 'var(--accent, #C76B8A)' : 'transparent',
              color: tab === t.key || (tab === 'create' && t.key === 'active') ? 'var(--accent, #C76B8A)' : 'var(--text-muted, #AAA5A0)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══ CREATE FLOW ═══ */}
      {tab === 'create' && creating && (
        <div style={styles.createFlow}>
          {/* Type header */}
          <div style={{ ...styles.typeHeader, borderLeftColor: TYPE_CONFIG[selectedType]?.color }}>
            <span style={{ fontSize: 24 }}>{TYPE_CONFIG[selectedType]?.icon}</span>
            <div>
              <span style={styles.typeHeaderLabel}>{TYPE_CONFIG[selectedType]?.label} Campaign</span>
              <span style={styles.typeHeaderDesc}>{TYPE_CONFIG[selectedType]?.desc}</span>
            </div>
          </div>

          {/* Name */}
          <input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Campaign name"
            style={styles.nameInput}
          />

          {/* Message */}
          <div style={styles.msgSection}>
            <label style={styles.fieldLabel}>Message</label>
            <textarea
              value={form.message}
              onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
              style={styles.msgTextarea}
              rows={5}
              placeholder="Write your message..."
            />
            <button
              onClick={() => {
                const templates = MESSAGE_TEMPLATES[selectedType] || MESSAGE_TEMPLATES.custom;
                setForm(f => ({ ...f, message: templates[Math.floor(Math.random() * templates.length)] }));
              }}
              style={styles.shuffleBtn}
            >
              Shuffle template
            </button>
          </div>

          {/* Target count */}
          <div style={styles.targetCard}>
            <span style={styles.targetIcon}>👥</span>
            <div>
              <span style={styles.targetLabel}>
                {form.targetCount == null
                  ? 'Recipient chosen when you send'
                  : `${form.targetCount} client${form.targetCount !== 1 ? 's' : ''} will receive this`}
              </span>
              <span style={styles.targetHint}>
                {selectedType === 'reactivation' ? 'Clients inactive 30+ days' :
                 selectedType === 'rescue' ? 'Pick the client who just cancelled' :
                 'Your active clients'}
              </span>
            </div>
          </div>

          {/* Actions */}
          <div style={styles.createActions}>
            <button onClick={handleSave} disabled={!form.message.trim() || saving} style={{
              ...styles.primaryBtn,
              opacity: !form.message.trim() ? 0.5 : 1,
            }}>
              {saving ? 'Saving...' : 'Save as Draft'}
            </button>
            <button onClick={() => { setCreating(false); setTab('active'); }} style={styles.cancelBtn}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ═══ ACTIVE TAB ═══ */}
      {(tab === 'active') && !creating && (
        <div style={styles.body}>
          {/* Campaign type selector */}
          <div style={styles.typeGrid}>
            {Object.entries(TYPE_CONFIG).map(([type, cfg]) => (
              <button
                key={type}
                onClick={() => startCreate(type)}
                style={styles.typeCard}
              >
                <span style={{ fontSize: 22 }}>{cfg.icon}</span>
                <span style={styles.typeLabel}>{cfg.label}</span>
              </button>
            ))}
          </div>

          {/* AI suggestion card */}
          <div style={styles.aiCard}>
            <div style={styles.aiCardHeader}>
              <span style={{ fontSize: 16 }}>🤖</span>
              <span style={styles.aiCardTitle}>AI Suggestion</span>
            </div>
            <p style={styles.aiCardText}>{aiSuggestion.text}</p>
            <button
              onClick={() => startCreate(aiSuggestion.type)}
              style={styles.aiCardBtn}
            >
              Draft it for me
            </button>
          </div>

          {/* Active campaigns */}
          {active.length > 0 && (
            <div style={styles.section}>
              <h3 style={styles.sectionTitle}>Active campaigns</h3>
              {active.map(c => (
                <CampaignCard
                  key={c.id}
                  campaign={c}
                  onApprove={() => handleApprove(c.id)}
                  onCancel={() => handleCancel(c.id)}
                  onView={() => setDetail(c)}
                />
              ))}
            </div>
          )}

          {active.length === 0 && (
            <div style={styles.emptyHint}>
              <p style={styles.emptyText}>No active campaigns. Tap a type above to create one, or let the AI suggest one.</p>
            </div>
          )}
        </div>
      )}

      {/* ═══ HISTORY TAB ═══ */}
      {tab === 'history' && (
        <div style={styles.body}>
          {history.length === 0 ? (
            <div style={styles.emptyState}>
              <span style={{ fontSize: 36, display: 'block', marginBottom: 12 }}>📬</span>
              <p style={styles.emptyTitle}>No campaign history yet</p>
              <p style={styles.emptyDesc}>Sent and cancelled campaigns will appear here with performance stats.</p>
            </div>
          ) : (
            history.map(c => (
              <CampaignCard key={c.id} campaign={c} onView={() => setDetail(c)} />
            ))
          )}
        </div>
      )}

      {/* ═══ DETAIL MODAL ═══ */}
      {detail && (
        <div style={styles.overlay} onClick={() => setDetail(null)}>
          <div style={styles.detailPanel} onClick={e => e.stopPropagation()}>
            <button onClick={() => setDetail(null)} style={styles.closeBtn}>×</button>

            <div style={styles.detailHeader}>
              <span style={{ fontSize: 28 }}>{TYPE_CONFIG[detail.type]?.icon}</span>
              <h2 style={styles.detailName}>{detail.name}</h2>
              <StatusBadge status={detail.status} />
            </div>

            <div style={styles.detailMsgCard}>
              <span style={styles.detailMsgLabel}>Message</span>
              <p style={styles.detailMsgText}>{detail.message_template}</p>
            </div>

            {/* Performance stats (for sent campaigns) */}
            {detail.status === 'sent' && (
              <div style={styles.perfGrid}>
                <PerfStat label="Delivered" value={detail.delivered_count || 0} />
                <PerfStat label="Opened" value={detail.opened_count || 0} />
                <PerfStat label="Replied" value={detail.responded_count || 0} />
                <PerfStat label="Booked" value={detail.booked_count || 0} color="#4CAF50" />
              </div>
            )}

            {detail.status === 'sent' && detail.revenue_recovered_cents > 0 && (
              <div style={styles.revenueRecovered}>
                <span style={styles.recoveredLabel}>Revenue recovered</span>
                <span style={styles.recoveredAmount}>£{(detail.revenue_recovered_cents / 100).toFixed(0)}</span>
              </div>
            )}

            <div style={styles.detailMeta}>
              <span style={styles.detailMetaText}>
                Created {new Date(detail.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                {detail.sent_at && ` · Sent ${new Date(detail.sent_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
              </span>
              <span style={styles.detailMetaText}>
                {detail.target_count} recipient{detail.target_count !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CampaignCard({ campaign, onApprove, onCancel, onView }) {
  const cfg = TYPE_CONFIG[campaign.type] || TYPE_CONFIG.custom;
  return (
    <div style={styles.campaignCard} onClick={onView}>
      <div style={styles.campaignCardTop}>
        <div style={styles.campaignCardLeft}>
          <span style={{ fontSize: 18 }}>{cfg.icon}</span>
          <div>
            <span style={styles.campaignName}>{campaign.name}</span>
            <span style={styles.campaignMeta}>
              {cfg.label} · {campaign.target_count} recipient{campaign.target_count !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
        <StatusBadge status={campaign.status} />
      </div>

      <p style={styles.campaignPreview}>
        {(campaign.message_template || '').substring(0, 90)}
        {(campaign.message_template || '').length > 90 ? '...' : ''}
      </p>

      {/* Sent stats inline */}
      {campaign.status === 'sent' && (
        <div style={styles.miniStats}>
          <span style={styles.miniStat}>📬 {campaign.delivered_count || 0}</span>
          <span style={styles.miniStat}>👀 {campaign.opened_count || 0}</span>
          <span style={styles.miniStat}>💬 {campaign.responded_count || 0}</span>
          <span style={{ ...styles.miniStat, color: '#4CAF50', fontWeight: 600 }}>📅 {campaign.booked_count || 0}</span>
        </div>
      )}

      {/* Draft/approved actions */}
      {(campaign.status === 'draft' || campaign.status === 'approved') && (
        <div style={styles.cardActions} onClick={e => e.stopPropagation()}>
          {campaign.status === 'draft' && onApprove && (
            <button onClick={onApprove} style={styles.approveBtn}>Approve & Send</button>
          )}
          {onCancel && (
            <button onClick={onCancel} style={styles.cancelCardBtn}>Cancel</button>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const cfg = STATUS_LABELS[status] || STATUS_LABELS.draft;
  return (
    <span style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: cfg.bg, color: cfg.color }}>
      {cfg.label}
    </span>
  );
}

function PerfStat({ label, value, color }) {
  return (
    <div style={styles.perfStatBox}>
      <span style={{ ...styles.perfStatValue, color: color || '#2D2A26' }}>{value}</span>
      <span style={styles.perfStatLabel}>{label}</span>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--bg, #FAF8F5)', fontFamily: '"DM Sans", -apple-system, sans-serif', padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: 'var(--text, #2D2A26)' },
  header: { paddingTop: 28, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent, #C76B8A)', margin: 0, fontWeight: 500 },

  tabs: { display: 'flex', gap: 24, borderBottom: '1px solid var(--border, #F0ECE8)', marginBottom: 16 },
  tab: { padding: '10px 0', background: 'none', border: 'none', borderBottom: '2px solid transparent', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  body: { display: 'flex', flexDirection: 'column', gap: 12 },

  // Type grid
  typeGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 },
  typeCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    padding: '14px 8px', borderRadius: 12, background: 'var(--bg-card, #fff)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', border: 'none',
    cursor: 'pointer', fontFamily: 'inherit',
  },
  typeLabel: { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary, #8A8580)' },

  // AI suggestion
  aiCard: { background: 'linear-gradient(135deg, var(--accent-light, #FFF0F3) 0%, #F5EFFC 100%)', borderRadius: 14, padding: 16 },
  aiCardHeader: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 },
  aiCardTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  aiCardText: { fontSize: 13, color: 'var(--text-secondary, #8A8580)', margin: '0 0 12px', lineHeight: 1.5 },
  aiCardBtn: {
    padding: '8px 16px', borderRadius: 8, border: 'none',
    background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Campaign cards
  campaignCard: {
    background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 16,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', cursor: 'pointer',
    marginBottom: 2,
  },
  campaignCardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  campaignCardLeft: { display: 'flex', gap: 10, alignItems: 'flex-start' },
  campaignName: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  campaignMeta: { display: 'block', fontSize: 11, color: 'var(--text-muted, #AAA5A0)', marginTop: 2 },
  campaignPreview: { fontSize: 13, color: 'var(--text-secondary, #8A8580)', margin: '0 0 10px', lineHeight: 1.5 },
  miniStats: { display: 'flex', gap: 12, paddingTop: 8, borderTop: '1px solid var(--bg-hover, #F5F2EF)' },
  miniStat: { fontSize: 12, color: 'var(--text-secondary, #8A8580)' },
  cardActions: { display: 'flex', gap: 8, paddingTop: 10, borderTop: '1px solid var(--bg-hover, #F5F2EF)' },
  approveBtn: {
    flex: 1, padding: '10px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  cancelCardBtn: {
    padding: '10px 16px', borderRadius: 10, border: 'none',
    background: 'var(--bg-hover, #F5F2EF)', color: 'var(--text-muted, #AAA5A0)', fontSize: 13,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  section: { marginTop: 4 },
  sectionTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 10px', color: 'var(--text, #2D2A26)' },

  // Create flow
  createFlow: { display: 'flex', flexDirection: 'column', gap: 12 },
  typeHeader: {
    display: 'flex', gap: 12, alignItems: 'center',
    padding: 14, borderRadius: 12, background: 'var(--bg-card, #fff)',
    borderLeft: '4px solid var(--accent, #C76B8A)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  typeHeaderLabel: { display: 'block', fontSize: 15, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  typeHeaderDesc: { display: 'block', fontSize: 12, color: 'var(--text-secondary, #8A8580)', marginTop: 2 },
  nameInput: {
    width: '100%', padding: '12px 14px', borderRadius: 12,
    border: '1.5px solid var(--border, #F0ECE8)', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box',
  },
  msgSection: { display: 'flex', flexDirection: 'column', gap: 8 },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #AAA5A0)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  msgTextarea: {
    width: '100%', padding: 14, borderRadius: 12,
    border: '1.5px solid var(--border, #F0ECE8)', fontSize: 14, fontFamily: 'inherit',
    resize: 'vertical', outline: 'none', lineHeight: 1.6, boxSizing: 'border-box',
  },
  shuffleBtn: {
    alignSelf: 'flex-start', padding: '6px 14px', borderRadius: 8,
    border: '1.5px solid var(--border, #E0DBD5)', background: 'transparent',
    color: 'var(--text-secondary, #8A8580)', fontSize: 12, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  targetCard: {
    display: 'flex', gap: 12, alignItems: 'center',
    padding: 14, borderRadius: 12, background: 'var(--bg-card, #fff)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  targetIcon: { fontSize: 20, flexShrink: 0 },
  targetLabel: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  targetHint: { display: 'block', fontSize: 11, color: 'var(--text-muted, #AAA5A0)', marginTop: 2 },
  createActions: { display: 'flex', gap: 8, marginTop: 4 },
  primaryBtn: {
    flex: 1, padding: '14px 0', borderRadius: 12, border: 'none',
    background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 15, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  cancelBtn: {
    padding: '14px 20px', borderRadius: 12, border: 'none',
    background: 'var(--bg-hover, #F5F2EF)', color: 'var(--text-secondary, #8A8580)', fontSize: 15,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Detail modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', justifyContent: 'center', alignItems: 'flex-end' },
  detailPanel: {
    background: 'var(--bg, #FAF8F5)', borderRadius: '20px 20px 0 0', width: '100%',
    maxWidth: 480, maxHeight: '85vh', overflowY: 'auto',
    padding: '20px 16px 40px', position: 'relative',
  },
  closeBtn: { position: 'absolute', top: 12, right: 16, background: 'none', border: 'none', fontSize: 24, color: 'var(--text-muted, #AAA5A0)', cursor: 'pointer' },
  detailHeader: { textAlign: 'center', paddingTop: 8, paddingBottom: 16 },
  detailName: { fontSize: 18, fontWeight: 700, margin: '8px 0', color: 'var(--text, #2D2A26)' },
  detailMsgCard: { background: 'var(--bg-card, #fff)', borderRadius: 12, padding: 14, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  detailMsgLabel: { display: 'block', fontSize: 10, fontWeight: 600, color: 'var(--text-muted, #AAA5A0)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 },
  detailMsgText: { fontSize: 13, color: 'var(--text-secondary, #8A8580)', margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap' },
  perfGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginBottom: 12 },
  perfStatBox: { background: 'var(--bg-card, #fff)', borderRadius: 10, padding: '10px 6px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  perfStatValue: { display: 'block', fontSize: 18, fontWeight: 700 },
  perfStatLabel: { display: 'block', fontSize: 9, color: 'var(--text-muted, #AAA5A0)', textTransform: 'uppercase', marginTop: 2 },
  revenueRecovered: {
    background: 'linear-gradient(135deg, var(--accent, #C76B8A) 0%, #D4899F 100%)',
    borderRadius: 12, padding: 14, textAlign: 'center', color: '#fff', marginBottom: 12,
  },
  recoveredLabel: { display: 'block', fontSize: 10, opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.04em' },
  recoveredAmount: { display: 'block', fontSize: 26, fontWeight: 700, marginTop: 2 },
  detailMeta: { textAlign: 'center', padding: '8px 0' },
  detailMetaText: { display: 'block', fontSize: 11, color: 'var(--text-muted, #C4BDB6)' },

  // Empty states
  emptyHint: { textAlign: 'center', padding: '20px 16px' },
  emptyText: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)', margin: 0, lineHeight: 1.5 },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 6px' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)', margin: 0, lineHeight: 1.5 },
};
