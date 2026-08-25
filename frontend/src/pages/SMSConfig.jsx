import { useState, useEffect } from 'react';
import { ds, type } from '../lib/designSystem.js';
import { supabase } from '../lib/supabase.js';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';

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
  { id: 'booking_confirmation', name: 'Booking Confirmation', trigger: 'On booking', message: 'Hi {name}, your {treatment} is confirmed for {date} at {time}. {business}' },
  { id: 'reminder_24h', name: '24h Reminder', trigger: '24h before', message: 'Reminder: {name}, your {treatment} is tomorrow at {time}. See you then! {business}' },
  { id: 'reminder_1h', name: '1h Reminder', trigger: '1h before', message: '{name}, your appointment is in 1 hour at {time}. {business}' },
  { id: 'rebook_nudge', name: 'Rebook Nudge', trigger: 'Auto (21 days)', message: "Hey {name}! It's been a few weeks. Ready to book in again? {booking_link}, {business}" },
  { id: 'review_request', name: 'Review Request', trigger: 'Post-appointment', message: '{name}, thanks for visiting! We\'d love your feedback: {review_link}, {business}' },
  { id: 'no_show_followup', name: 'No-Show Follow Up', trigger: 'On no-show', message: 'Hey {name}, we missed you today! Want to rebook? {booking_link}, {business}' },
];

const tabs = ['Overview', 'Templates', 'Settings'];

// Whether clients can reply is NOT something to infer from the shape of the
// sender string. It used to be: a value that looked like a phone number was
// shown as "2-way", which was true of the SHARED platform long code as well,
// so a salon sending from a number nobody could route replies on was told her
// replies were live. The backend now answers it directly, in `two_way`.
//
// This is only kept for the input hint while she is typing.
function looksLikeNumber(value) {
  if (!value) return false;
  const trimmed = value.toString().trim();
  if (trimmed.startsWith('+')) return /^\+[0-9]{7,15}$/.test(trimmed);
  return /^[0-9]{7,15}$/.test(trimmed);
}

export default function SMSConfig() {
  const [tab, setTab] = useState(0);
  const [config, setConfig] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Settings form state. Three separate things, because they ARE three separate
  // things: the number clients text her on, the Bird channel her texts leave
  // from, and the brand name that appears in message copy.
  const [inboundInput, setInboundInput] = useState('');
  const [channelInput, setChannelInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Test SMS state
  const [testPhone, setTestPhone] = useState('');
  const [testing, setTesting] = useState(false);
  // Shape, not a sentinel. This used to be a bare string whose first character
  // decided the colour: `testMsg.startsWith('✓') ? success : danger`. That made
  // a tick in a template literal load-bearing, so the emoji sweep would have
  // turned every successful test SMS red without touching the colour logic.
  const [testMsg, setTestMsg] = useState(null); // { ok: boolean, text: string }

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
      setInboundInput(cfg.sms_inbound_number || '');
      setChannelInput(cfg.sms_channel_id || '');
      setNameInput(cfg.sms_originator || 'Florrie');
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
          // Empty means "I have not got my own number", which is a real and
          // common answer, so it clears the field rather than being rejected.
          sms_inbound_number: inboundInput.trim() || null,
          sms_channel_id: channelInput.trim() || null,
          sms_originator: nameInput.trim() || 'Florrie',
          sms_enabled: smsEnabled,
          channel: smsEnabled ? 'sms' : (config?.channel || 'whatsapp'),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSaveMsg(data.warnings?.length ? data.warnings[0] : 'Saved');
      setConfig(prev => ({ ...prev, ...data }));
    } catch (err) {
      setSaveMsg(`Error: ${err.message}`);
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(''), 6000);
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
      setTestMsg({ ok: true, text: `Test SMS sent, check ${testPhone}` });
    } catch (err) {
      setTestMsg({ ok: false, text: err.message });
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
  const senderValue = config?.sms_originator || nameInput || 'Florrie';
  // Straight from the backend. Not guessed from a string.
  const twoWay = !!config?.two_way;
  const sendingFrom = config?.sms_channel_id
    ? 'your own Bird number'
    : `the shared Florrie number${config?.shared_sms_number ? ` (${config.shared_sms_number})` : ''}`;

  return (
    <div style={ds.page}>
      <PageHeader
        title="SMS"
        subtitle="Bird-powered SMS, no regulatory bundle required"
      />

      {/* Status card */}
      <div style={{ ...ds.heroCard, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>SMS GATEWAY</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: 'var(--radius-xs)',
                background: birdConfigured ? '#4ADE80' : '#F87171',
              }} />
              <span style={{ fontSize: 16, fontWeight: 600 }}>
                {birdConfigured ? 'Connected via Bird' : 'Bird not configured'}
              </span>
            </div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 6 }}>
              Sending from {sendingFrom}
              {smsEnabled ? ' · SMS enabled' : ' · SMS disabled (WhatsApp primary)'}
            </div>
            <div style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, background: twoWay ? 'rgba(74,222,128,0.2)' : 'rgba(250,204,21,0.18)', fontSize: 11, fontWeight: 600 }}>
              <span style={{ width: 6, height: 6, borderRadius: 'var(--radius-xs)', background: twoWay ? '#4ADE80' : '#FACC15' }} />
              {twoWay
                ? `2-way, clients can reply on ${config.sms_inbound_number}`
                : 'One-way. Replies are not delivered'}
            </div>
            {twoWay && !config?.sms_channel_id && (
              <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 10, background: 'rgba(250,204,21,0.18)', fontSize: 11, lineHeight: 1.5 }}>
                Half set up. Clients can text {config.sms_inbound_number}, but your outbound texts still leave from the shared Florrie number, so a reply to one of those is not delivered. Add your Bird channel id below.
              </div>
            )}
          </div>
          <div style={{ fontSize: 40 }}><Icon name="phone" size={40} /></div>
        </div>

        {usage && (
          <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
            {[
              { label: 'Sent this week', val: usage.messagesSent || 0 },
              { label: 'Free remaining', val: usage.freeRemaining ?? '-' },
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
          <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(248,113,113,0.15)', borderRadius: 10, fontSize: 12 }}>
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
            <span style={{ fontSize: 20 }}>{twoWay ? '💬' : '💡'}</span>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
              {twoWay
                ? "2-way SMS is on, clients can text your own number and Florrie's AI replies the same way it does on WhatsApp. Booking confirmations, reminders, and rebook nudges all fire automatically."
                : "SMS fires automatically when a client doesn't have WhatsApp, booking confirmations, 24h reminders, and rebook nudges all fall back to SMS seamlessly. Replies do not come back: outbound goes out on the shared Florrie number, which every salon uses, so a text to it cannot say whose client sent it. Buy your own Bird number and add it in Settings to turn on replies."}
            </div>
          </div>

          <div style={ds.card}>
            <div style={{ ...type.heading, marginBottom: 12 }}>How SMS fits in</div>
            {[
              { step: '1', label: 'Client books', desc: 'System picks WhatsApp if available, SMS if not' },
              { step: '2', label: 'Confirmation fires', desc: `Sent from ${sendingFrom}, signed "${senderValue}"` },
              { step: '3', label: '24h before appointment', desc: 'Reminder sent automatically' },
              {
                step: '4',
                label: twoWay ? 'Client replies' : 'Post-appointment',
                desc: twoWay
                  ? "Reply lands in Florrie, AI books, reschedules, or escalates to you"
                  : 'Rebook nudge after 21 days if no new booking'
              },
            ].map(s => (
              <div key={s.step} style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'flex-start' }}>
                <div style={{ width: 24, height: 24, borderRadius: 10, background: 'var(--accent)',
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
                  <div style={{ ...ds.badge,
                    ...(isEnabled ? ds.badgeSuccess : { background: 'var(--bg-subtle)', color: 'var(--text-muted)' }),
                  }}>{isEnabled ? 'Active' : 'Off'}</div>
                </div>
                <div style={{ background: 'var(--bg-subtle)', borderRadius: 10, padding: 12,
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
              <button onClick={() => setSmsEnabled(v => !v)} style={{ ...ds.toggle,
                background: smsEnabled ? 'var(--accent)' : 'var(--border)',
              }}>
                <div style={{ ...ds.toggleDot, transform: smsEnabled ? 'translateX(20px)' : 'translateX(0)' }} />
              </button>
            </div>

            {/* Inbound number. The only thing that makes replies work. */}
            <div style={{ marginBottom: 16 }}>
              <div style={ds.inputLabel}>Your own number, for replies</div>
              <div style={{ ...type.bodySmall, fontSize: 11, marginBottom: 8 }}>
                A Bird virtual mobile you have bought yourself, e.g. +447700900123. Clients text this number and Florrie knows the text is for you. Leave it empty if you have not got one: your texts still go out, they just cannot be replied to. The shared Florrie number is not valid here, because every salon uses it and a reply to it would not say who it was for.
              </div>
              <input
                value={inboundInput}
                onChange={e => setInboundInput(e.target.value.replace(/[^0-9+ ]/g, '').substring(0, 20))}
                style={{ minHeight: 44, width: '100%', padding: '8px 12px', borderRadius: 10,
                  border: '1px solid var(--border)', background: 'var(--bg-card)',
                  color: 'var(--text-primary)', fontSize: 14, boxSizing: 'border-box',
                }}
                placeholder="+447700900123"
                inputMode="tel"
              />
              {inboundInput && !looksLikeNumber(inboundInput.replace(/\s/g, '')) && (
                <div style={{ ...type.bodySmall, fontSize: 11, marginTop: 6, color: 'var(--warning)' }}>
                  That does not look like a mobile number yet.
                </div>
              )}
            </div>

            {/* Outbound channel. */}
            <div style={{ marginBottom: 16 }}>
              <div style={ds.inputLabel}>Bird channel id (optional)</div>
              <div style={{ ...type.bodySmall, fontSize: 11, marginBottom: 8 }}>
                The channel id Bird gives you for the number above. Without it your texts go out from the shared Florrie number, so a client replying to the text she received would not reach you. Leave empty to use the shared number.
              </div>
              <input
                value={channelInput}
                onChange={e => setChannelInput(e.target.value.trim().substring(0, 36))}
                style={{ minHeight: 44, width: '100%', padding: '8px 12px', borderRadius: 10,
                  border: '1px solid var(--border)', background: 'var(--bg-card)',
                  color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box',
                  fontFamily: 'monospace',
                }}
                placeholder="7e8e2014-98b9-508d-be22-6dde76d0dd0e"
              />
            </div>

            {/* Display name. */}
            <div style={{ marginBottom: 16 }}>
              <div style={ds.inputLabel}>Business name in messages</div>
              <div style={{ ...type.bodySmall, fontSize: 11, marginBottom: 8 }}>
                Up to 11 letters and numbers, e.g. Ellindigo. This is how your messages sign off. It is not the sender number and it does not affect replies.
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 11))}
                  style={{ minHeight: 44, flex: 1, padding: '8px 12px', borderRadius: 10,
                    border: '1px solid var(--border)', background: 'var(--bg-card)',
                    color: 'var(--text-primary)', fontSize: 14,
                  }}
                  placeholder="Ellindigo"
                />
                <span style={{ ...type.mono, fontSize: 11, color: 'var(--text-muted)' }}>
                  {nameInput.length}/11
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
              <div style={{ marginTop: 10, fontSize: 13,
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
                  style={{ minHeight: 44, flex: 1, padding: '8px 12px', borderRadius: 10,
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
                <div style={{ marginTop: 10, fontSize: 13,
                  display: 'flex', alignItems: 'center', gap: 6,
                  color: testMsg.ok ? 'var(--success)' : 'var(--danger)',
                }}>
                  <Icon name={testMsg.ok ? 'check' : 'x'} size={14} inline />
                  {testMsg.text}
                </div>
              )}
            </div>
          )}

          <div style={{ ...ds.insightCard, marginTop: 12 }}>
            <span>ℹ️</span>
            <div style={{ ...type.bodySmall, fontSize: 12, lineHeight: 1.5 }}>
              {twoWay ? (
                <>
                  <strong>2-way SMS is live.</strong> Clients text your own number and Florrie's AI picks up the thread the same way it does on WhatsApp. Messages cost ~0.5p each via Bird. Your plan includes 120 messages a month across SMS and WhatsApp combined.
                </>
              ) : (
                <>
                  <strong>One-way.</strong> Your texts go out on the shared Florrie number. Replies to it are dropped on purpose: every salon sends from it, so an incoming text cannot say whose client it is, and delivering it to a guess would put one salon's client in another salon's inbox. Buy your own Bird number and paste it above to switch replies on. Outbound messages cost ~0.5p each via Bird. Your plan includes 120 messages a month across SMS and WhatsApp combined.
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
