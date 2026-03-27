import { useState } from 'react';
import { ds, type } from '../lib/designSystem.js';

const templates = [
  { id: 1, name: 'Booking Confirmation', trigger: 'On booking', message: 'Hi {name}, your {treatment} is confirmed for {date} at {time}. Reply CANCEL to cancel. — {business}', enabled: true, sent: 234, delivered: 228 },
  { id: 2, name: '24h Reminder', trigger: '24h before', message: 'Reminder: {name}, your {treatment} is tomorrow at {time}. See you then! — {business}', enabled: true, sent: 198, delivered: 195 },
  { id: 3, name: '1h Reminder', trigger: '1h before', message: '{name}, just a heads up — your appointment is in 1 hour at {time}. — {business}', enabled: false, sent: 0, delivered: 0 },
  { id: 4, name: 'Rebook Nudge', trigger: 'Auto (21 days)', message: 'Hey {name}! It\'s been a few weeks since your last {treatment}. Ready to book in again? {booking_link} — {business}', enabled: true, sent: 56, delivered: 54 },
  { id: 5, name: 'Review Request', trigger: 'Post-appointment', message: '{name}, thanks for visiting! We\'d love your feedback: {review_link} — {business}', enabled: true, sent: 142, delivered: 138 },
  { id: 6, name: 'No-Show Follow Up', trigger: 'On no-show', message: 'Hey {name}, we missed you today! Want to rebook? {booking_link} — {business}', enabled: true, sent: 12, delivered: 11 },
  { id: 7, name: 'Campaign Blast', trigger: 'Manual', message: '{custom_message}', enabled: true, sent: 45, delivered: 43 },
];

const stats = { sent: 687, delivered: 669, failed: 18, replies: 89, cost: '£41.22' };

const tabs = ['Overview', 'Templates', 'Settings', 'Logs'];

export default function SMSConfig() {
  const [tab, setTab] = useState(0);
  const [templateStates, setTemplateStates] = useState(
    Object.fromEntries(templates.map(t => [t.id, t.enabled]))
  );

  const toggleTemplate = (id) => {
    setTemplateStates(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const deliveryRate = ((stats.delivered / stats.sent) * 100).toFixed(1);

  return (
    <div style={ds.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={ds.pageTitle}>SMS Config</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>Twilio-powered SMS for reminders, confirmations, and campaigns</p>
      </div>

      {/* Connection card */}
      <div style={{ ...ds.heroCard, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>SMS GATEWAY</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: 5, background: '#4ADE80' }} />
              <span style={{ fontSize: 16, fontWeight: 600 }}>Connected via Twilio</span>
            </div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 6 }}>+44 7700 900000 · {stats.sent} messages sent</div>
          </div>
          <div style={{ fontSize: 40 }}>📱</div>
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
          {[{ label: 'Delivered', val: `${deliveryRate}%` }, { label: 'Replies', val: stats.replies }, { label: 'Failed', val: stats.failed }, { label: 'Cost (30d)', val: stats.cost }].map(s => (
            <div key={s.label} style={{ flex: 1 }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{s.val}</div>
              <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={ds.tabBar}>
        {tabs.map((t, i) => (
          <button key={t} onClick={() => setTab(i)} style={{ ...ds.tab, ...(tab === i ? ds.tabActive : {}) }}>{t}</button>
        ))}
      </div>

      {/* Overview */}
      {tab === 0 && (
        <div>
          <div style={ds.statsGrid}>
            {[
              { label: 'Total Sent', val: stats.sent, icon: '📤' },
              { label: 'Delivered', val: stats.delivered, icon: '✅' },
              { label: 'Reply Rate', val: `${((stats.replies / stats.delivered) * 100).toFixed(0)}%`, icon: '💬' },
              { label: 'Monthly Cost', val: stats.cost, icon: '💷' },
            ].map(s => (
              <div key={s.label} style={ds.statCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 16 }}>{s.icon}</span>
                </div>
                <div style={ds.statValue}>{s.val}</div>
                <div style={ds.statLabel}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Delivery funnel */}
          <div style={{ ...ds.card, marginBottom: 16 }}>
            <div style={{ ...type.heading, marginBottom: 12 }}>Delivery Funnel — Last 30 Days</div>
            {[
              { label: 'Sent', val: stats.sent, pct: 100 },
              { label: 'Delivered', val: stats.delivered, pct: (stats.delivered / stats.sent) * 100 },
              { label: 'Read (est.)', val: Math.round(stats.delivered * 0.82), pct: (stats.delivered * 0.82 / stats.sent) * 100 },
              { label: 'Replied', val: stats.replies, pct: (stats.replies / stats.sent) * 100 },
            ].map(step => (
              <div key={step.label} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ ...type.bodySmall, fontSize: 12 }}>{step.label}</span>
                  <span style={{ ...type.mono, fontSize: 12 }}>{step.val} ({step.pct.toFixed(0)}%)</span>
                </div>
                <div style={{ height: 8, background: 'var(--bg-subtle)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${step.pct}%`, background: 'var(--accent)', borderRadius: 4 }} />
                </div>
              </div>
            ))}
          </div>

          <div style={ds.insightCard}>
            <span style={{ fontSize: 20 }}>💡</span>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
              SMS has a 97.3% delivery rate and ~82% read rate — much higher than email. Your rebook nudges via SMS are converting at 14%, compared to 6% via email.
            </div>
          </div>
        </div>
      )}

      {/* Templates */}
      {tab === 1 && (
        <div>
          {templates.map(t => (
            <div key={t.id} style={{ ...ds.card, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <div style={type.heading}>{t.name}</div>
                  <div style={{ ...type.bodySmall, fontSize: 11 }}>Trigger: {t.trigger}</div>
                </div>
                <button onClick={() => toggleTemplate(t.id)} style={{
                  ...ds.toggle,
                  background: templateStates[t.id] ? 'var(--accent)' : 'var(--border)',
                }}>
                  <div style={{ ...ds.toggleDot, transform: templateStates[t.id] ? 'translateX(20px)' : 'translateX(0)' }} />
                </button>
              </div>
              {/* Message preview */}
              <div style={{
                background: 'var(--bg-subtle)', borderRadius: 12, padding: 12, marginBottom: 8,
                borderLeft: '3px solid var(--accent)',
              }}>
                <div style={{ ...type.mono, fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                  {t.message}
                </div>
              </div>
              {t.sent > 0 && (
                <div style={{ display: 'flex', gap: 12 }}>
                  <span style={{ ...type.mono, fontSize: 10, color: 'var(--text-muted)' }}>Sent: {t.sent}</span>
                  <span style={{ ...type.mono, fontSize: 10, color: 'var(--success)' }}>Delivered: {t.delivered}</span>
                  <span style={{ ...type.mono, fontSize: 10, color: 'var(--text-muted)' }}>Rate: {((t.delivered / t.sent) * 100).toFixed(0)}%</span>
                </div>
              )}
            </div>
          ))}
          <button style={{ ...ds.btnSecondary, width: '100%', marginTop: 8 }}>+ Create Custom Template</button>
        </div>
      )}

      {/* Settings */}
      {tab === 2 && (
        <div>
          {[
            { label: 'Sender Number', value: '+44 7700 900000', type: 'readonly' },
            { label: 'Sender Name (Alpha)', value: 'Ellindigo', type: 'text' },
            { label: 'Monthly Budget Cap', value: '£60.00', type: 'text' },
            { label: 'Rate Limit', value: '100 messages/hour', type: 'select' },
          ].map(s => (
            <div key={s.label} style={{ ...ds.card, marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={ds.inputLabel}>{s.label}</div>
                <div style={{ ...type.body, fontSize: 13 }}>{s.value}</div>
              </div>
              {s.type !== 'readonly' && (
                <button style={{ ...ds.btnGhost, fontSize: 11 }}>Edit</button>
              )}
            </div>
          ))}

          <div style={{ ...ds.divider, margin: '16px 0' }} />

          {[
            { label: 'Opt-out handling', description: 'Auto-unsubscribe on STOP reply', enabled: true },
            { label: 'Quiet hours', description: 'No SMS between 9pm–8am', enabled: true },
            { label: 'Duplicate prevention', description: 'Skip if WhatsApp was already sent', enabled: true },
            { label: 'International sending', description: 'Allow SMS to non-UK numbers', enabled: false },
          ].map(s => (
            <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border-light)' }}>
              <div>
                <div style={{ ...type.body, fontSize: 13 }}>{s.label}</div>
                <div style={{ ...type.bodySmall, fontSize: 11 }}>{s.description}</div>
              </div>
              <div style={{
                ...ds.toggle,
                background: s.enabled ? 'var(--accent)' : 'var(--border)',
              }}>
                <div style={{ ...ds.toggleDot, transform: s.enabled ? 'translateX(20px)' : 'translateX(0)' }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Logs */}
      {tab === 3 && (
        <div>
          <div style={{ ...ds.sectionTitle, marginBottom: 10 }}>RECENT SMS ACTIVITY</div>
          {[
            { to: 'Jessica M.', template: '24h Reminder', status: 'delivered', time: '2 min ago' },
            { to: 'Sarah C.', template: 'Booking Confirmation', status: 'delivered', time: '15 min ago' },
            { to: 'Emma T.', template: 'Rebook Nudge', status: 'replied', time: '1h ago' },
            { to: 'Olivia B.', template: '24h Reminder', status: 'delivered', time: '2h ago' },
            { to: 'Amy W.', template: 'Review Request', status: 'failed', time: '3h ago' },
            { to: 'Rachel G.', template: 'Booking Confirmation', status: 'delivered', time: '4h ago' },
            { to: 'Kate A.', template: 'No-Show Follow Up', status: 'delivered', time: '5h ago' },
            { to: 'Mia R.', template: 'Rebook Nudge', status: 'delivered', time: '6h ago' },
          ].map((log, i) => (
            <div key={i} style={ds.listRow}>
              <div style={{ flex: 1 }}>
                <div style={{ ...type.body, fontSize: 13 }}>{log.to}</div>
                <div style={{ ...type.bodySmall, fontSize: 11 }}>{log.template}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{
                  ...ds.badge,
                  ...(log.status === 'delivered' ? ds.badgeSuccess : log.status === 'replied' ? ds.badgeAccent : ds.badgeDanger),
                }}>{log.status}</span>
                <div style={{ ...type.mono, fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>{log.time}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
