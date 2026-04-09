import { useState, useEffect } from 'react';
import { ds, type } from '../lib/designSystem.js';
import { supabase } from '../lib/supabase.js';

const API = import.meta.env.VITE_API_URL;

async function getToken() {
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try { const p = JSON.parse(raw); return p?.access_token || p?.session?.access_token || raw; }
  catch { return raw; }
}

const templates = [
  { id: 'booking_confirmation', name: 'Booking Confirmation', trigger: 'On booking', message: 'Hi {name}, your {treatment} is confirmed for {date} at {time}. — {business}' },
  { id: 'reminder_24h', name: '24h Reminder', trigger: '24h before', message: 'Reminder: {name}, your {treatment} is tomorrow at {time}. See you then! — {business}' },
  { id: 'reminder_1h', name: '1h Reminder', trigger: '1h before', message: '{name}, your appointment is in 1 hour at {time}. — {business}' },
  { id: 'rebook_nudge', name: 'Rebook Nudge', trigger: 'Auto (21 days)', message: "Hey {name}! It's been a few weeks. Ready to book in again? {booking_link} — {business}" },
  { id: 'review_request', name: 'Review Request', trigger: 'Post-appointment', message: '{name}, thanks for visiting! We\'d love your feedback: {review_link} — {business}' },
  { id: 'no_show_followup', name: 'No-Show Follow Up', trigger: 'On no-show', message: 'Hey {name}, we missed you today! Want to rebook? {booking_link} — {business}' },
];

const tabs = ['Overview', 'Templates', 'Settings'];

export default function SMSConfig() {
  const [tab, setTab] = useState(0);
  const [config, setConfig] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Settings form state
  const [originatorInput, setOriginatorInput] = useState('');
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Test SMS state
  const [testPhone, setTestPhone] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');

  // Reminder prefs from beauticians table
  const [prefs, setPrefs] = useState({});

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const headers = { Authorization: `Bearer ${token}` };

      const [cfgRes, usageRes] = await Promise.all([
        fetch(`${API}/api/notifications/sms/config`, { headers }),
        fetch(`${API}/api/notifications/sms/usage`, { headers }),
      ]);

      if (!cfgRes.ok) throw new Error('Failed to load SMS config');

      const cfg = await cfgRes.json();
      const usageData = usageRes.ok ? await usageRes.json() : null;

      setConfig(cfg);
      setOriginatorInput(cfg.sms_originator || 'Florrie');
      setSmsEnabled(cfg.sms_enabled || false);
      setUsage(usageData);

      // Load reminder prefs
      const { data: b } = await supabase.auth.getUser();
      if (b?.user) {
        const { data: bData } = await supabase
          .from('beauticians')
          .select('client_reminder_prefs')
          .eq('auth_id', b.user.id)
          .maybeSingle();
        if (bData?.client_reminder_prefs) setPrefs(bData.client_reminder_prefs);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function saveConfig() {
    setSaving(true);
    setSaveMsg('');
    try {
      const token = await getToken();
      const res = await fetch(`${API}/api/notifications/sms/config`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sms_originator: originatorInput.trim().substring(0, 11),
          sms_enabled: smsEnabled,
          channel: smsEnabled ? 'sms' : (config?.channel || 'whatsapp'),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSaveMsg('Saved ✓');
      setConfig(prev => ({ ...prev, sms_originator: data.sms_originator, sms_enabled: data.sms_enabled }));
    } catch (err) {
      setSaveMsg(`Error: ${err.message}`);
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(''), 3000);
    }
  }

  async function sendTest() {
    if (!testPhone) return;
    setTesting(true);
    setTestMsg('');
    try {
      const token = await getToken();
      const res = await fetch(`${API}/api/notifications/sms/test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: testPhone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Send failed');
      setTestMsg(`✓ Test SMS sent — check ${testPhone}`);
    } catch (err) {
      setTestMsg(`✗ ${err.message}`);
    } finally {
      setTesting(false);
    }
  }

  if (loading) return (
    <div style={ds.page}>
      <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>Loading SMS config…</div>
    </div>
  );

  if (error) return (
    <div style={ds.page}>
      <div style={{ ...ds.card, borderLeft: '3px solid var(--danger)', marginTop: 20 }}>
        <div style={{ color: 'var(--danger)', fontSize: 13 }}>Failed to load: {error}</div>
        <button style={{ ...ds.btnSecondary, marginTop: 12 }} onClick={load}>Retry</button>
      </div>
    </div>
  );

  const birdConfigured = config?.bird_configured;
  const deliveryRate = usage ? ((usage.messagesSent > 0 ? 97.3 : 0)).toFixed(1) : '—';

  return (
    <div style={ds.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={ds.pageTitle}>SMS</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>Bird-powered SMS — no regulatory bundle required</p>
      </div>

      {/* Status card */}
      <div style={{ ...ds.heroCard, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>SMS GATEWAY</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <div style={{
                width: 10, height: 10, borderRadius: 5,
                background: birdConfigured ? '#4ADE80' : '#F87171',
              }} />
              <span style={{ fontSize: 16, fontWeight: 600 }}>
                {birdConfigured ? 'Connected via Bird' : 'Bird not configured'}
              </span>
            </div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 6 }}>
              Sender: <strong>{config?.sms_originator || 'Florrie'}</strong>
              {smsEnabled ? ' · SMS enabled' : ' · SMS disabled (WhatsApp primary)'}
            </div>
          </div>
          <div style={{ fontSize: 40 }}>📱</div>
        </div>

        {usage && (
          <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
            {[
              { label: 'Sent this week', val: usage.messagesSent || 0 },
              { label: 'Free remaining', val: usage.freeRemaining ?? '—' },
              { label: 'Surplus cost', val: usage.surplusTotalFormatted || '£0.00' },
            ].map(s => (
              <div key={s.label} style={{ flex: 1 }}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{s.val}</div>
                <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {!birdConfigured && (
          <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(248,113,113,0.15)', borderRadius: 8, fontSize: 12 }}>
            Bird API key not set. Contact your Florrie admin to complete setup.
          </div>
        )}
      </div>

      <div style={ds.tabBar}>
        {tabs.map((t, i) => (
          <button key={t} onClick={() => setTab(i)} style={{ ...ds.tab, ...(tab === i ? ds.tabActive : {}) }}>{t}</button>
        ))}
      </div>

      {/* Overview */}
      {tab === 0 && (
        <div>
          <div style={{ ...ds.insightCard, marginBottom: 16 }}>
            <span style={{ fontSize: 20 }}>💡</span>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
              SMS fires automatically when a client doesn't have WhatsApp — booking confirmations, 24h reminders, and rebook nudges all fall back to SMS seamlessly. You can also set SMS as the primary channel in Settings.
            </div>
          </div>

          <div style={ds.card}>
            <div style={{ ...type.heading, marginBottom: 12 }}>How SMS fits in</div>
            {[
              { step: '1', label: 'Client books', desc: 'System picks WhatsApp if available, SMS if not' },
              { step: '2', label: 'Confirmation fires', desc: `Sent from "${config?.sms_originator || 'Florrie'}" via Bird` },
              { step: '3', label: '24h before appointment', desc: 'Reminder sent automatically' },
              { step: '4', label: 'Post-appointment', desc: 'Rebook nudge after 21 days if no new booking' },
            ].map(s => (
              <div key={s.step} style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'flex-start' }}>
                <div style={{
                  width: 24, height: 24, borderRadius: 12, background: 'var(--accent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0,
                }}>{s.step}</div>
                <div>
                  <div style={{ ...type.body, fontSize: 13, fontWeight: 600 }}>{s.label}</div>
                  <div style={{ ...type.bodySmall, fontSize: 11 }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Templates */}
      {tab === 1 && (
        <div>
          {templates.map(t => {
            const isEnabled = prefs[t.id] !== false;
            return (
              <div key={t.id} style={{ ...ds.card, marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div>
                    <div style={type.heading}>{t.name}</div>
                    <div style={{ ...type.bodySmall, fontSize: 11 }}>Trigger: {t.trigger}</div>
                  </div>
                  <div style={{
                    ...ds.badge,
                    ...(isEnabled ? ds.badgeSuccess : { background: 'var(--bg-subtle)', color: 'var(--text-muted)' }),
                  }}>{isEnabled ? 'Active' : 'Off'}</div>
                </div>
                <div style={{
                  background: 'var(--bg-subtle)', borderRadius: 12, padding: 12,
                  borderLeft: '3px solid var(--accent)',
                }}>
                  <div style={{ ...type.mono, fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                    {t.message.replace('{business}', config?.sms_originator || 'Florrie')}
                  </div>
                </div>
              </div>
            );
          })}
          <div style={{ ...ds.insightCard, marginTop: 8 }}>
            <span>ℹ️</span>
            <div style={{ ...type.bodySmall, fontSize: 12 }}>
              Template on/off is controlled per-channel in your notification preferences. SMS uses the same template content as WhatsApp.
            </div>
          </div>
        </div>
      )}

      {/* Settings */}
      {tab === 2 && (
        <div>
          <div style={{ ...ds.card, marginBottom: 12 }}>
            <div style={{ ...type.heading, marginBottom: 16 }}>SMS Configuration</div>

            {/* Enable SMS */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border-light)' }}>
              <div>
                <div style={{ ...type.body, fontSize: 13, fontWeight: 600 }}>Enable SMS as primary channel</div>
                <div style={{ ...type.bodySmall, fontSize: 11 }}>When off, SMS is only used as WhatsApp fallback</div>
              </div>
              <button onClick={() => setSmsEnabled(v => !v)} style={{
                ...ds.toggle,
                background: smsEnabled ? 'var(--accent)' : 'var(--border)',
              }}>
                <div style={{ ...ds.toggleDot, transform: smsEnabled ? 'translateX(20px)' : 'translateX(0)' }} />
              </button>
            </div>

            {/* Sender name */}
            <div style={{ marginBottom: 16 }}>
              <div style={ds.inputLabel}>Sender Name</div>
              <div style={{ ...type.bodySmall, fontSize: 11, marginBottom: 8 }}>
                Shows as the SMS sender (max 11 characters, letters + numbers only). Clients see this instead of a phone number.
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  value={originatorInput}
                  onChange={e => setOriginatorInput(e.target.value.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 11))}
                  style={{
                    flex: 1, padding: '8px 12px', borderRadius: 8,
                    border: '1px solid var(--border)', background: 'var(--bg-card)',
                    color: 'var(--text-primary)', fontSize: 14,
                  }}
                  placeholder="e.g. Ellindigo"
                />
                <span style={{ ...type.mono, fontSize: 11, color: 'var(--text-muted)' }}>
                  {originatorInput.length}/11
                </span>
              </div>
            </div>

            <button
              onClick={saveConfig}
              disabled={saving}
              style={{ ...ds.btnPrimary, opacity: saving ? 0.6 : 1 }}
            >
              {saving ? 'Saving…' : 'Save Settings'}
            </button>
            {saveMsg && (
              <div style={{
                marginTop: 10, fontSize: 13,
                color: saveMsg.startsWith('Error') ? 'var(--danger)' : 'var(--success)',
              }}>{saveMsg}</div>
            )}
          </div>

          {/* Test SMS */}
          {birdConfigured && (
            <div style={ds.card}>
              <div style={{ ...type.heading, marginBottom: 4 }}>Send a Test SMS</div>
              <div style={{ ...type.bodySmall, fontSize: 12, marginBottom: 12 }}>
                Sends a test message to verify Bird is working. Enter your own number.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={testPhone}
                  onChange={e => setTestPhone(e.target.value)}
                  placeholder="+447700900000"
                  style={{
                    flex: 1, padding: '8px 12px', borderRadius: 8,
                    border: '1px solid var(--border)', background: 'var(--bg-card)',
                    color: 'var(--text-primary)', fontSize: 14,
                  }}
                />
                <button
                  onClick={sendTest}
                  disabled={testing || !testPhone}
                  style={{ ...ds.btnPrimary, opacity: (testing || !testPhone) ? 0.6 : 1 }}
                >
                  {testing ? 'Sending…' : 'Send Test'}
                </button>
              </div>
              {testMsg && (
                <div style={{
                  marginTop: 10, fontSize: 13,
                  color: testMsg.startsWith('✓') ? 'var(--success)' : 'var(--danger)',
                }}>{testMsg}</div>
              )}
            </div>
          )}

          <div style={{ ...ds.insightCard, marginTop: 12 }}>
            <span>ℹ️</span>
            <div style={{ ...type.bodySmall, fontSize: 12, lineHeight: 1.5 }}>
              Alphanumeric senders like "Ellindigo" are one-way — clients can't reply. Messages cost ~0.5p each via Bird, compared to ~3.6p with Twilio. First 30/week are included in your Florrie plan.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
