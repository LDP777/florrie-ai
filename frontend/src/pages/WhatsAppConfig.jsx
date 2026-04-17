import { useState, useEffect } from 'react';
import { useBeautician, fetchRows } from '../lib/supabase.js';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';

const MOCK_CONNECTED = {
  connected: true,
  phone: '+44 7700 900123',
  business_name: "Ellie's Brows",
  usage: { sms_sent: 34, whatsapp_sent: 53, total_sent: 87, free_limit: 120, remaining: 33, overage_total_pence: 0 },
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

const autoReplyDefaults = [
  { id: 1, trigger: 'Outside business hours', response: "Hey! I'm not at the salon right now but I'll get back to you first thing tomorrow morning 💕 — Ellie", enabled: true },
  { id: 2, trigger: 'Pricing enquiry detected', response: "Thanks for asking! You can see all my prices and book directly here: {booking_link} 💅", enabled: true },
  { id: 3, trigger: 'Availability enquiry detected', response: "Let me check what I've got! My next available slots are: {next_slots}. Want me to book one? 🗓️", enabled: true },
  { id: 4, trigger: 'New message (no match)', response: null, enabled: false },
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
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

function UsageBar({ usage }) {
  if (!usage) return null;
  const { total_sent, free_limit, overage_total_pence } = usage;
  const pct = Math.min(100, Math.round((total_sent / free_limit) * 100));
  const isNearLimit = pct >= 80;
  const isOver = total_sent >= free_limit;
  const barColor = isOver ? '#E85D75' : isNearLimit ? '#FFB74D' : '#25D366';

  return (
    <div style={styles.usageBar}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text, #2D2A26)' }}>
          {total_sent} / {free_limit} messages this month
        </span>
        {isOver && overage_total_pence > 0 && (
          <span style={{ fontSize: 11, color: '#E85D75', fontWeight: 600 }}>
            +{(overage_total_pence / 100).toFixed(2)} overage
          </span>
        )}
      </div>
      <div style={{ height: 6, background: 'var(--border, #F0ECE8)', borderRadius: 3 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 3, transition: 'width 0.4s' }} />
      </div>
      {isOver && (
        <div style={{ fontSize: 11, color: '#E85D75', marginTop: 4 }}>
          Over limit — extra messages billed at 5p each
        </div>
      )}
      {!isOver && isNearLimit && (
        <div style={{ fontSize: 11, color: '#E65100', marginTop: 4 }}>
          Getting close — {free_limit - total_sent} left this month
        </div>
      )}
    </div>
  );
}

function ConnectFlow({ onConnected }) {
  const [step, setStep] = useState('phone'); // 'phone' | 'otp'
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendNote, setResendNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  async function handleRegister(e) {
    e.preventDefault();
    if (!phone.trim()) return;
    setError('');
    setLoading(true);
    try {
      await apiFetch('/register', {
        method: 'POST',
        body: JSON.stringify({ phone: phone.trim() }),
      });
      setStep('otp');
      setResendCooldown(30);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e) {
    e.preventDefault();
    if (!otp.trim()) return;
    setError('');
    setLoading(true);
    try {
      const result = await apiFetch('/verify', {
        method: 'POST',
        body: JSON.stringify({ code: otp.trim() }),
      });
      onConnected(result.phone);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendCooldown > 0 || resending) return;
    setError('');
    setResendNote('');
    setResending(true);
    try {
      await apiFetch('/resend-code', { method: 'POST' });
      setResendNote('New code sent — check your messages.');
      setResendCooldown(30);
    } catch (err) {
      setError(err.message);
    } finally {
      setResending(false);
    }
  }

  return (
    <div style={styles.connectBox}>
      <div style={styles.connectIcon}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="#25D366">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
          <path d="M12 0C5.373 0 0 5.373 0 12c0 2.025.507 3.934 1.395 5.608L0 24l6.562-1.371A11.944 11.944 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.75c-1.875 0-3.623-.527-5.112-1.441l-.363-.216-3.773.99 1.008-3.682-.237-.377A9.697 9.697 0 012.25 12C2.25 6.624 6.624 2.25 12 2.25S21.75 6.624 21.75 12 17.376 21.75 12 21.75z"/>
        </svg>
      </div>

      <h2 style={styles.connectTitle}>Connect WhatsApp</h2>
      <p style={styles.connectDesc}>
        Add your business phone number. Florrie will send booking confirmations,
        reminders, and follow-ups from your number — clients see messages from you,
        not from a generic platform.
      </p>

      <div style={styles.connectNote}>
        ⚠️ The number must not already be active on personal WhatsApp. Use a business
        number or second SIM. If it is on WhatsApp, delete that account first (you can
        export your chat history beforehand).
      </div>

      {step === 'phone' ? (
        <form onSubmit={handleRegister}>
          <label style={styles.inputLabel}>Your business phone number</label>
          <input
            style={styles.input}
            type="tel"
            placeholder="+44 7700 900000"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            disabled={loading}
          />
          {error && <div style={styles.errorMsg}>{error}</div>}
          <button style={styles.connectBtn} type="submit" disabled={loading || !phone.trim()}>
            {loading ? 'Sending code…' : 'Send verification code'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleVerify}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', marginBottom: 12 }}>
            Enter the 6-digit code sent to <strong>{phone}</strong>
          </p>
          <label style={styles.inputLabel}>Verification code</label>
          <input
            style={{ ...styles.input, letterSpacing: 6, fontSize: 20, textAlign: 'center' }}
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            value={otp}
            onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
            disabled={loading}
            autoFocus
          />
          {error && <div style={styles.errorMsg}>{error}</div>}
          {resendNote && <div style={styles.resendNote}>{resendNote}</div>}
          <button style={styles.connectBtn} type="submit" disabled={loading || otp.length < 6}>
            {loading ? 'Verifying…' : 'Confirm'}
          </button>
          <button
            type="button"
            style={styles.resendBtn}
            onClick={handleResend}
            disabled={resending || resendCooldown > 0}
          >
            {resending
              ? 'Sending…'
              : resendCooldown > 0
                ? `Resend code in ${resendCooldown}s`
                : 'Didn\'t get a code? Resend'}
          </button>
          <button
            type="button"
            style={styles.backBtn}
            onClick={() => { setStep('phone'); setError(''); setOtp(''); setResendNote(''); }}
          >
            ← Change number
          </button>
        </form>
      )}
    </div>
  );
}

export default function WhatsAppConfig() {
  const { beautician, loading: bLoading } = useBeautician();
  const [status, setStatus] = useState(null); // from /api/whatsapp/status
  const [activeTab, setActiveTab] = useState('overview');
  const [expandedTemplate, setExpandedTemplate] = useState(null);
  const [autoReplies, setAutoReplies] = useState(autoReplyDefaults);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (bLoading || !beautician) return;
    loadData();
  }, [beautician, bLoading]);

  async function loadData() {
    setLoading(true);
    try {
      const data = await apiFetch('/status');
      setStatus(data);
    } catch (err) {
      logger.error('WhatsApp load error:', err);
      // On error, show disconnected state so user can reconnect
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect WhatsApp? Automated messages will stop.')) return;
    setDisconnecting(true);
    try {
      await apiFetch('/disconnect', { method: 'DELETE' });
      setStatus({ connected: false });
    } catch (err) {
      alert('Something went wrong — try again');
    } finally {
      setDisconnecting(false);
    }
  }

  function handleConnected(phone) {
    setStatus(prev => ({ ...prev, connected: true, phone }));
  }

  if (bLoading || loading) return <PageLoader />;

  const connected = status?.connected;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'templates', label: 'Templates' },
    { id: 'autoreplies', label: 'Auto-reply' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>WhatsApp Business</h1>
        <div style={{
          ...styles.statusBadge,
          background: connected ? 'var(--success-bg, #EDF7F0)' : '#FFF3E0',
          color: connected ? 'var(--success, #5BA97B)' : '#E65100',
        }}>
          {connected ? '🟢 Connected' : '🔴 Not connected'}
        </div>
      </div>

      {/* Not connected — show setup flow */}
      {!connected && <ConnectFlow onConnected={handleConnected} />}

      {/* Connected — show dashboard */}
      {connected && (
        <>
          {/* Connection card */}
          <div style={styles.connectionCard}>
            <div style={styles.waLogo}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="#25D366">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                <path d="M12 0C5.373 0 0 5.373 0 12c0 2.025.507 3.934 1.395 5.608L0 24l6.562-1.371A11.944 11.944 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.75c-1.875 0-3.623-.527-5.112-1.441l-.363-.216-3.773.99 1.008-3.682-.237-.377A9.697 9.697 0 012.25 12C2.25 6.624 6.624 2.25 12 2.25S21.75 6.624 21.75 12 17.376 21.75 12 21.75z"/>
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text, #2D2A26)' }}>
                {status?.business_name || beautician?.business_name || 'Your Business'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted, #AAA5A0)' }}>{status?.phone}</div>
            </div>
            <div style={styles.metaBadge}>Meta Cloud API</div>
          </div>

          {/* Usage bar — always visible */}
          <UsageBar usage={status?.usage} />

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
                  <div style={styles.statValue}>{status?.usage?.whatsapp_sent ?? 0}</div>
                  <div style={styles.statLabel}>WhatsApp sent</div>
                </div>
                <div style={styles.statCard}>
                  <div style={styles.statValue}>{status?.usage?.sms_sent ?? 0}</div>
                  <div style={styles.statLabel}>SMS sent</div>
                </div>
                <div style={styles.statCard}>
                  <div style={styles.statValue}>{status?.usage?.remaining ?? '—'}</div>
                  <div style={styles.statLabel}>Remaining</div>
                </div>
              </div>

              <div style={styles.funnelCard}>
                <div style={styles.funnelTitle}>Monthly usage breakdown</div>
                {[
                  { label: 'WhatsApp', value: status?.usage?.whatsapp_sent ?? 0, max: status?.usage?.free_limit ?? 120, color: '#25D366' },
                  { label: 'SMS', value: status?.usage?.sms_sent ?? 0, max: status?.usage?.free_limit ?? 120, color: '#007AFF' },
                ].map((row, i) => (
                  <div key={i} style={styles.funnelRow}>
                    <div style={styles.funnelLabel}>{row.label}</div>
                    <div style={styles.funnelBarBg}>
                      <div style={{ ...styles.funnelBarFill, width: `${Math.min(100, Math.round((row.value / row.max) * 100))}%`, background: row.color }} />
                    </div>
                    <div style={styles.funnelValue}>{row.value}</div>
                  </div>
                ))}
              </div>

              <div style={styles.insightCard}>
                <span style={{ fontSize: 16 }}>💡</span>
                <div style={{ fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.5 }}>
                  120 messages/month included in your plan across SMS and WhatsApp combined.
                  Extra messages are billed at 5p (WhatsApp) or 6p (SMS) each.
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
                          color: tmpl.status === 'approved' ? '#2E7D32' : '#F57F17',
                        }}>{tmpl.status}</span>
                        <span style={styles.tmplCategory}>{tmpl.category}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>
                        Used {tmpl.uses} times · Last: {tmpl.lastUsed}
                      </div>
                    </div>
                    <span style={{ fontSize: 18, color: 'var(--text-muted, #AAA5A0)' }}>
                      {expandedTemplate === tmpl.id ? '▾' : '▸'}
                    </span>
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
                Florrie reads incoming messages and auto-responds when it's confident about the intent.
                Customise these or let Florrie draft replies in your tone.
              </div>
              {autoReplies.map(rule => (
                <div key={rule.id} style={styles.autoReplyCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' }}>{rule.trigger}</div>
                    <button
                      onClick={() => setAutoReplies(autoReplies.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r))}
                      style={{ ...styles.toggle, background: rule.enabled ? 'var(--accent, #C76B8A)' : 'var(--border, #E8E4E0)' }}
                    >
                      <div style={{ ...styles.toggleDot, transform: rule.enabled ? 'translateX(18px)' : 'translateX(0)' }} />
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
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)', marginBottom: 4 }}>🧠 Florrie AI Drafting</div>
                  <div style={{ fontSize: 12, color: '#6B6560', lineHeight: 1.4 }}>
                    Let Florrie draft replies to unmatched messages in your tone. Drafts appear in Inbox for approval before sending.
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
                  <button style={{ ...styles.toggle, background: setting.enabled ? 'var(--accent, #C76B8A)' : 'var(--border, #E8E4E0)' }}>
                    <div style={{ ...styles.toggleDot, transform: setting.enabled ? 'translateX(18px)' : 'translateX(0)' }} />
                  </button>
                </div>
              ))}

              <div style={styles.dangerZone}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#E85D75', marginBottom: 8 }}>Danger zone</div>
                <button
                  style={styles.disconnectBtn}
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                >
                  {disconnecting ? 'Disconnecting…' : 'Disconnect WhatsApp'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles = {
  page: { padding: '16px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  statusBadge: { padding: '4px 10px', borderRadius: 10, fontSize: 12, fontWeight: 600 },

  // Connect flow
  connectBox: { background: 'var(--bg-card, #fff)', borderRadius: 18, padding: 24, border: '1px solid var(--border, #F0ECE8)' },
  connectIcon: { width: 56, height: 56, borderRadius: 16, background: 'var(--success-bg, #EDF7F0)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  connectTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 8px' },
  connectDesc: { fontSize: 14, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.6, margin: '0 0 14px' },
  connectNote: { fontSize: 12, color: '#7B5E00', background: '#FFF8E1', border: '1px solid #FFE082', borderRadius: 10, padding: 12, marginBottom: 20, lineHeight: 1.5 },
  inputLabel: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #8B6F5E)', marginBottom: 6 },
  input: { width: '100%', padding: '12px 14px', borderRadius: 12, border: '1.5px solid var(--border, #E8E4E0)', fontSize: 15, fontFamily: 'inherit', color: 'var(--text, #2D2A26)', background: 'var(--bg, #FAF8F5)', outline: 'none', boxSizing: 'border-box', marginBottom: 12 },
  connectBtn: { width: '100%', padding: '13px 0', borderRadius: 12, border: 'none', background: '#25D366', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  backBtn: { width: '100%', padding: '10px 0', borderRadius: 12, border: 'none', background: 'none', color: 'var(--text-muted, #AAA5A0)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', marginTop: 8 },
  resendBtn: { width: '100%', padding: '10px 0', borderRadius: 12, border: '1px solid var(--border, #E8E4E0)', background: 'var(--bg, #FAF8F5)', color: 'var(--text-secondary, #8B6F5E)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', marginTop: 10 },
  resendNote: { fontSize: 12, color: '#2E7D32', background: '#E8F5E9', border: '1px solid #C8E6C9', borderRadius: 10, padding: '8px 12px', marginBottom: 10 },
  errorMsg: { fontSize: 13, color: '#E85D75', marginBottom: 10 },

  // Usage bar
  usageBar: { background: 'var(--bg-card, #fff)', borderRadius: 12, padding: '12px 14px', border: '1px solid var(--border, #F0ECE8)', marginBottom: 12 },

  connectionCard: { display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 14, border: '1px solid var(--border, #F0ECE8)', marginBottom: 12 },
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
  funnelBarFill: { height: '100%', borderRadius: 4, transition: 'width 0.5s' },
  funnelValue: { fontSize: 12, fontWeight: 600, color: 'var(--text, #2D2A26)', width: 36, textAlign: 'right' },

  insightCard: { display: 'flex', gap: 10, background: '#FFF8F0', border: '1px solid #FFE8CC', borderRadius: 12, padding: 14, marginBottom: 16 },

  newTemplateBtn: { width: '100%', padding: '12px 0', borderRadius: 12, border: '2px dashed var(--border, #E8E4E0)', background: 'none', fontSize: 14, fontWeight: 600, color: 'var(--text-muted, #AAA5A0)', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 12 },
  templateCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, border: '1px solid var(--border, #F0ECE8)', marginBottom: 8, overflow: 'hidden' },
  templateHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: 14, cursor: 'pointer' },
  templateName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  tmplStatus: { fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 6 },
  tmplCategory: { fontSize: 10, color: 'var(--text-muted, #AAA5A0)', background: 'var(--border, #F0ECE8)', padding: '2px 6px', borderRadius: 6 },
  templatePreview: { padding: '0 14px 14px', borderTop: '1px solid var(--border, #F0ECE8)' },
  previewBubble: { background: 'var(--success-bg, #EDF7F0)', borderRadius: '12px 12px 12px 0', padding: 12, fontSize: 13, color: 'var(--text, #2D2A26)', lineHeight: 1.5, marginTop: 12, marginBottom: 10 },
  previewActions: { display: 'flex', gap: 8 },
  previewBtn: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border, #F0ECE8)', background: 'var(--bg, #FAF8F5)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-secondary, #8B6F5E)' },

  autoReplyHint: { fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.5, marginBottom: 16, background: 'var(--bg, #FAF8F5)', padding: 12, borderRadius: 12 },
  autoReplyCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 14, border: '1px solid var(--border, #F0ECE8)', marginBottom: 10 },
  autoReplyPreview: { fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.5, background: 'var(--bg, #FAF8F5)', borderRadius: 10, padding: 10 },
  aiToggleCard: { display: 'flex', alignItems: 'center', gap: 12, background: '#FFF8F0', border: '1px solid #FFE8CC', borderRadius: 14, padding: 14, marginTop: 16 },

  toggle: { width: 42, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleDot: { width: 20, height: 20, borderRadius: 10, background: 'var(--bg-card, #fff)', position: 'absolute', top: 2, left: 2, transition: 'transform 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.15)' },

  settingRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0', borderBottom: '1px solid var(--border, #F0ECE8)' },
  dangerZone: { marginTop: 24, padding: 16, background: 'var(--danger-bg, #FDF0EF)', borderRadius: 14, border: '1px solid var(--danger, #D4605C)' },
  disconnectBtn: { padding: '10px 16px', borderRadius: 10, border: '1px solid var(--danger, #D4605C)', background: 'none', color: 'var(--danger, #D4605C)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
