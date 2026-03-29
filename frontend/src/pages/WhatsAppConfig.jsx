import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, isDevMode } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const mockConfig = {
  connected: true,
  phoneNumber: '+44 7700 900123',
  businessName: "Ellie's Brows",
  status: 'active',
  messagesThisMonth: 342,
  delivered: 338,
  read: 291,
  replied: 67,
  templateApproved: 8,
  templatePending: 1,
};

const mockTemplates = [
  { id: 1, name: 'Booking confirmation', category: 'utility', status: 'approved', lastUsed: 'Today', uses: 156, preview: "Hey {name}! Your {treatment} is booked for {date} at {time}. See you soon! 💕 — Ellie" },
  { id: 2, name: 'Appointment reminder (24h)', category: 'utility', status: 'approved', lastUsed: 'Today', uses: 289, preview: "Hi {name}, just a reminder about your {treatment} tomorrow at {time}. Reply YES to confirm or call to reschedule. See you soon! ✨" },
  { id: 3, name: 'No-show follow-up', category: 'utility', status: 'approved', lastUsed: 'Yesterday', uses: 12, preview: "Hey {name}, we missed you today! No worries at all — life happens. Want me to rebook you? Just reply with a day that works 💛" },
  { id: 4, name: 'Aftercare instructions', category: 'utility', status: 'approved', lastUsed: '2 days ago', uses: 98, preview: "Hey {name}! Here are your aftercare tips for your {treatment}: {aftercare_link}. Any questions at all, just message me! 💆‍♀️" },
  { id: 5, name: 'Review request', category: 'marketing', status: 'approved', lastUsed: '3 days ago', uses: 45, preview: "Hi {name}! So glad you loved your {treatment} 🥰 If you have a sec, a Google review would mean the world: {review_link}" },
  { id: 6, name: 'Win-back offer', category: 'marketing', status: 'approved', lastUsed: '1 week ago', uses: 23, preview: "Hey {name}, it's been a while! I've got 10% off your next visit if you fancy coming back 💕 Book here: {booking_link}" },
  { id: 7, name: 'Rebook reminder', category: 'utility', status: 'approved', lastUsed: 'Today', uses: 67, preview: "Hi {name}! Your {treatment} is due for a top-up 💅 Shall I book you in? Reply with a day that works and I'll sort it!" },
  { id: 8, name: 'Birthday message', category: 'marketing', status: 'approved', lastUsed: '5 days ago', uses: 8, preview: "Happy birthday {name}! 🎂🎉 As a treat from me, here's a free brow wax on your next visit: {voucher_code}. Have the best day! 💕" },
  { id: 9, name: 'Waitlist slot offer', category: 'utility', status: 'pending', lastUsed: 'Never', uses: 0, preview: "Great news {name}! A {treatment} slot just opened up on {date} at {time}. Want it? Reply YES to grab it before it goes! ⚡" },
];

const autoReplyRules = [
  { id: 1, trigger: 'Outside business hours', response: "Hey! I'm not at the salon right now but I'll get back to you first thing tomorrow morning 💕 — Ellie", enabled: true },
  { id: 2, trigger: 'Pricing enquiry detected', response: "Thanks for asking! You can see all my prices and book directly here: {booking_link} 💅", enabled: true },
  { id: 3, trigger: 'Availability enquiry detected', response: "Let me check what I've got! My next available slots are: {next_slots}. Want me to book one? 🗓️", enabled: true },
  { id: 4, trigger: 'New message (no match)', response: null, enabled: false },
];

export default function WhatsAppConfig() {
  const { beautician, loading: bLoading } = useBeautician();
  const [activeTab, setActiveTab] = useState('overview');
  const [expandedTemplate, setExpandedTemplate] = useState(null);
  const [autoReplies, setAutoReplies] = useState(autoReplyRules);
  const [config, setConfig] = useState(mockConfig);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (bLoading || !beautician) return;
    loadWhatsAppData();
  }, [beautician, bLoading]);

  async function loadWhatsAppData() {
    setLoading(true);
    try {
      if (isDevMode) {
        setConfig(mockConfig);
        setTemplates(mockTemplates);
      } else {
        const wa = {
          connected: !!beautician.whatsapp_connected,
          phoneNumber: beautician.whatsapp_phone || mockConfig.phoneNumber,
          businessName: beautician.business_name || mockConfig.businessName,
          status: beautician.whatsapp_connected ? 'active' : 'inactive',
          messagesThisMonth: mockConfig.messagesThisMonth,
          delivered: mockConfig.delivered,
          read: mockConfig.read,
          replied: mockConfig.replied,
          templateApproved: mockConfig.templateApproved,
          templatePending: mockConfig.templatePending,
        };
        setConfig(prev => ({ ...prev, ...wa }));
        const rows = await fetchRows('whatsapp_templates', beautician.id, { order: 'name', ascending: true });
        setTemplates(rows.length ? rows : mockTemplates);
      }
    } catch (err) {
      logger.error('Load WhatsApp data error:', err);
      setConfig(mockConfig);
      setTemplates(mockTemplates);
    } finally {
      setLoading(false);
    }
  }

  if (bLoading || loading) return <PageLoader />;

  const c = config;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'templates', label: 'Templates' },
    { id: 'autoreplies', label: 'Auto-reply' },
    { id: 'settings', label: 'Settings' },
  ];

  const deliveryRate = ((c.delivered / c.messagesThisMonth) * 100).toFixed(1);
  const readRate = ((c.read / c.messagesThisMonth) * 100).toFixed(1);
  const replyRate = ((c.replied / c.messagesThisMonth) * 100).toFixed(1);

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>WhatsApp Business</h1>
        <div style={{
          ...styles.statusBadge,
          background: c.connected ? 'var(--success-bg, #EDF7F0)' : '#FFF3E0',
          color: c.connected ? 'var(--success, #5BA97B)' : '#E65100'
        }}>
          {c.connected ? '🟢 Connected' : '🔴 Disconnected'}
        </div>
      </div>

      {/* Connection card */}
      <div style={styles.connectionCard}>
        <div style={styles.waLogo}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="#25D366">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
            <path d="M12 0C5.373 0 0 5.373 0 12c0 2.025.507 3.934 1.395 5.608L0 24l6.562-1.371A11.944 11.944 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.75c-1.875 0-3.623-.527-5.112-1.441l-.363-.216-3.773.99 1.008-3.682-.237-.377A9.697 9.697 0 012.25 12C2.25 6.624 6.624 2.25 12 2.25S21.75 6.624 21.75 12 17.376 21.75 12 21.75z"/>
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text, #2D2A26)' }}>{c.businessName}</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted, #AAA5A0)' }}>{c.phoneNumber}</div>
        </div>
        <div style={styles.metaBadge}>Meta Cloud API</div>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{ ...styles.tab, ...(activeTab === tab.id ? styles.tabActive : {}) }}
          >{tab.label}</button>
        ))}
      </div>

      {/* Overview */}
      {activeTab === 'overview' && (
        <div>
          <div style={styles.statsRow}>
            <div style={styles.statCard}>
              <div style={styles.statValue}>{c.messagesThisMonth}</div>
              <div style={styles.statLabel}>Sent this month</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statValue}>{deliveryRate}%</div>
              <div style={styles.statLabel}>Delivered</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statValue}>{readRate}%</div>
              <div style={styles.statLabel}>Read</div>
            </div>
          </div>

          <div style={styles.funnelCard}>
            <div style={styles.funnelTitle}>Message funnel this month</div>
            {[
              { label: 'Sent', value: c.messagesThisMonth, pct: 100 },
              { label: 'Delivered', value: c.delivered, pct: parseFloat(deliveryRate) },
              { label: 'Read', value: c.read, pct: parseFloat(readRate) },
              { label: 'Replied', value: c.replied, pct: parseFloat(replyRate) },
            ].map((step, i) => (
              <div key={i} style={styles.funnelRow}>
                <div style={styles.funnelLabel}>{step.label}</div>
                <div style={styles.funnelBarBg}>
                  <div style={{ ...styles.funnelBarFill, width: `${step.pct}%` }} />
                </div>
                <div style={styles.funnelValue}>{step.value}</div>
              </div>
            ))}
          </div>

          <div style={styles.insightCard}>
            <span style={{ fontSize: 16 }}>💡</span>
            <div style={{ fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.5 }}>
              Your read rate is {readRate}% — well above the industry average of 70%.
              Reply rate of {replyRate}% suggests clients are engaging. The aftercare
              template drives the most replies.
            </div>
          </div>

          <div style={styles.templateSummary}>
            <div style={styles.templateSumItem}>
              <span style={{ fontSize: 20, fontWeight: 700 }}>{c.templateApproved}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>Approved</span>
            </div>
            <div style={styles.templateSumItem}>
              <span style={{ fontSize: 20, fontWeight: 700, color: '#FFB74D' }}>{c.templatePending}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>Pending</span>
            </div>
          </div>
        </div>
      )}

      {/* Templates */}
      {activeTab === 'templates' && (
        <div>
          <button style={styles.newTemplateBtn}>+ Create Template</button>
          {templates.map(tmpl => (
            <div key={tmpl.id} style={styles.templateCard}>
              <div
                style={styles.templateHeader}
                onClick={() => setExpandedTemplate(expandedTemplate === tmpl.id ? null : tmpl.id)}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={styles.templateName}>{tmpl.name}</span>
                    <span style={{
                      ...styles.tmplStatus,
                      background: tmpl.status === 'approved' ? '#E8F5E9' : '#FFF8E1',
                      color: tmpl.status === 'approved' ? '#2E7D32' : '#F57F17'
                    }}>{tmpl.status}</span>
                    <span style={styles.tmplCategory}>{tmpl.category}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>Used {tmpl.uses} times · Last: {tmpl.lastUsed}</div>
                </div>
                <span style={{ fontSize: 18, color: 'var(--text-muted, #AAA5A0)' }}>{expandedTemplate === tmpl.id ? '▾' : '▸'}</span>
              </div>
              {expandedTemplate === tmpl.id && (
                <div style={styles.templatePreview}>
                  <div style={styles.previewBubble}>{tmpl.preview}</div>
                  <div style={styles.previewActions}>
                    <button style={styles.previewBtn}>✏️ Edit</button>
                    <button style={styles.previewBtn}>📋 Duplicate</button>
                    <button style={styles.previewBtn}>🧪 Test Send</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Auto-replies */}
      {activeTab === 'autoreplies' && (
        <div>
          <div style={styles.autoReplyHint}>
            florrie.ai reads incoming messages and auto-responds when it's confident about the intent.
            You can customise responses or let florrie.ai draft them in Ellie's tone.
          </div>
          {autoReplies.map(rule => (
            <div key={rule.id} style={styles.autoReplyCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' }}>{rule.trigger}</div>
                <button
                  onClick={() => setAutoReplies(autoReplies.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r))}
                  style={{
                    ...styles.toggle,
                    background: rule.enabled ? 'var(--accent, #C76B8A)' : 'var(--border, #E8E4E0)'
                  }}
                >
                  <div style={{
                    ...styles.toggleDot,
                    transform: rule.enabled ? 'translateX(18px)' : 'translateX(0)'
                  }} />
                </button>
              </div>
              {rule.response ? (
                <div style={styles.autoReplyPreview}>{rule.response}</div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)', fontStyle: 'italic' }}>
                  No auto-reply — messages go to Inbox for manual response
                </div>
              )}
            </div>
          ))}

          <div style={styles.aiToggleCard}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)', marginBottom: 4 }}>🧠 florrie.ai Drafting</div>
              <div style={{ fontSize: 12, color: '#6B6560', lineHeight: 1.4 }}>
                Let florrie.ai draft replies to unmatched messages using Ellie's tone model.
                Drafts appear in your Inbox for approval before sending.
              </div>
            </div>
            <button style={{ ...styles.toggle, background: 'var(--accent, #C76B8A)' }}>
              <div style={{ ...styles.toggleDot, transform: 'translateX(18px)' }} />
            </button>
          </div>
        </div>
      )}

      {/* Settings */}
      {activeTab === 'settings' && (
        <div>
          {[
            { label: 'Business hours messaging', desc: 'Only send automated messages during your set business hours', enabled: true },
            { label: 'Read receipts', desc: 'Track when clients read your messages', enabled: true },
            { label: 'Typing indicator', desc: 'Show typing indicator before auto-replies', enabled: false },
            { label: 'Message rate limiting', desc: 'Max 3 automated messages per client per day', enabled: true },
            { label: 'Opt-out handling', desc: 'Auto-detect STOP/unsubscribe and disable messaging', enabled: true },
            { label: 'Conversation backup', desc: 'Save all conversations to client timeline', enabled: true },
          ].map((setting, i) => (
            <div key={i} style={styles.settingRow}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary, #2D2A26)' }}>{setting.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)', marginTop: 2 }}>{setting.desc}</div>
              </div>
              <button style={{
                ...styles.toggle,
                background: setting.enabled ? 'var(--accent, #C76B8A)' : 'var(--border, #E8E4E0)'
              }}>
                <div style={{
                  ...styles.toggleDot,
                  transform: setting.enabled ? 'translateX(18px)' : 'translateX(0)'
                }} />
              </button>
            </div>
          ))}

          <div style={styles.dangerZone}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#E85D75', marginBottom: 8 }}>Danger zone</div>
            <button style={styles.disconnectBtn}>Disconnect WhatsApp</button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: '16px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  statusBadge: { padding: '4px 10px', borderRadius: 10, fontSize: 12, fontWeight: 600 },

  connectionCard: { display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 14, border: '1px solid var(--border, #F0ECE8)', marginBottom: 16 },
  waLogo: { width: 44, height: 44, borderRadius: 12, background: 'var(--success-bg, #EDF7F0)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  metaBadge: { fontSize: 10, color: 'var(--text-muted, #AAA5A0)', background: 'var(--border, #F0ECE8)', padding: '3px 8px', borderRadius: 6 },

  tabs: { display: 'flex', gap: 4, marginBottom: 16, background: 'var(--border, #F0ECE8)', borderRadius: 12, padding: 4 },
  tab: { flex: 1, padding: '8px 0', fontSize: 11, fontWeight: 500, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: 'none', color: 'var(--text-secondary, #8B6F5E)' },
  tabActive: { background: 'var(--bg-card, #fff)', color: 'var(--text, #2D2A26)', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },

  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 },
  statCard: { background: 'var(--bg-card, #fff)', borderRadius: 12, padding: 14, border: '1px solid var(--border, #F0ECE8)', textAlign: 'center' },
  statValue: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  statLabel: { fontSize: 11, color: 'var(--text-muted, #AAA5A0)', marginTop: 2 },

  funnelCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 16, border: '1px solid var(--border, #F0ECE8)', marginBottom: 16 },
  funnelTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)', marginBottom: 12 },
  funnelRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  funnelLabel: { fontSize: 12, color: 'var(--text-secondary, #8B6F5E)', width: 60 },
  funnelBarBg: { flex: 1, height: 8, background: 'var(--border, #F0ECE8)', borderRadius: 4 },
  funnelBarFill: { height: '100%', background: 'linear-gradient(90deg, #25D366, #128C7E)', borderRadius: 4, transition: 'width 0.5s' },
  funnelValue: { fontSize: 12, fontWeight: 600, color: 'var(--text, #2D2A26)', width: 36, textAlign: 'right' },

  insightCard: { display: 'flex', gap: 10, background: '#FFF8F0', border: '1px solid #FFE8CC', borderRadius: 12, padding: 14, marginBottom: 16 },

  templateSummary: { display: 'flex', gap: 24, justifyContent: 'center', marginBottom: 16 },
  templateSumItem: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },

  newTemplateBtn: { width: '100%', padding: '12px 0', borderRadius: 12, border: '2px dashed var(--border, #E8E4E0)', background: 'none', fontSize: 14, fontWeight: 600, color: 'var(--text-muted, #AAA5A0)', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 12 },
  templateCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, border: '1px solid var(--border, #F0ECE8)', marginBottom: 8, overflow: 'hidden' },
  templateHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: 14, cursor: 'pointer' },
  templateName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  tmplStatus: { fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 6 },
  tmplCategory: { fontSize: 10, color: 'var(--text-muted, #AAA5A0)', background: 'var(--border, #F0ECE8)', padding: '2px 6px', borderRadius: 6 },
  templatePreview: { padding: '0 14px 14px', borderTop: '1px solid var(--border, #F0ECE8)' },
  previewBubble: { background: 'var(--success-bg, #EDF7F0)', borderRadius: '12px 12px 12px 0', padding: 12, fontSize: 13, color: 'var(--text, #2D2A26)', lineHeight: 1.5, marginTop: 12, marginBottom: 10 },
  previewActions: { display: 'flex', gap: 8 },
  previewBtn: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border, #F0ECE8)', background: 'var(--bg, var(--bg, #FAF8F5))', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-secondary, #8B6F5E)' },

  autoReplyHint: { fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.5, marginBottom: 16, background: 'var(--bg, var(--bg, #FAF8F5))', padding: 12, borderRadius: 12 },
  autoReplyCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 14, border: '1px solid var(--border, #F0ECE8)', marginBottom: 10 },
  autoReplyPreview: { fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.5, background: 'var(--bg, var(--bg, #FAF8F5))', borderRadius: 10, padding: 10 },
  aiToggleCard: { display: 'flex', alignItems: 'center', gap: 12, background: '#FFF8F0', border: '1px solid #FFE8CC', borderRadius: 14, padding: 14, marginTop: 16 },

  toggle: { width: 42, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleDot: { width: 20, height: 20, borderRadius: 10, background: 'var(--bg-card, #fff)', position: 'absolute', top: 2, left: 2, transition: 'transform 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.15)' },

  settingRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0', borderBottom: '1px solid var(--border, #F0ECE8)' },
  dangerZone: { marginTop: 24, padding: 16, background: 'var(--danger-bg, #FDF0EF)', borderRadius: 14, border: '1px solid var(--danger, #D4605C)' },
  disconnectBtn: { padding: '10px 16px', borderRadius: 10, border: '1px solid var(--danger, #D4605C)', background: 'none', color: 'var(--danger, #D4605C)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
