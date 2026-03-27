import { useState } from 'react';
import { ds, type } from '../lib/designSystem.js';

const integrations = [
  {
    id: 'stripe', name: 'Stripe', icon: '💳', category: 'Payments',
    description: 'Accept card payments, deposits, and tap-to-pay',
    status: 'connected', connectedAt: 'Mar 12, 2026',
    stats: { label: 'Processed this month', value: '£3,420' },
    features: ['Card payments', 'Deposit collection', 'Tap to Pay', 'Automatic payouts'],
  },
  {
    id: 'whatsapp', name: 'WhatsApp Business', icon: '💬', category: 'Messaging',
    description: 'Send confirmations, reminders, and campaigns via WhatsApp',
    status: 'connected', connectedAt: 'Mar 10, 2026',
    stats: { label: 'Messages this week', value: '47' },
    features: ['Booking confirmations', '24h reminders', 'AI auto-replies', 'Campaign broadcasts'],
  },
  {
    id: 'google-cal', name: 'Google Calendar', icon: '📅', category: 'Calendar',
    description: 'Two-way sync between Florrie and Google Calendar',
    status: 'connected', connectedAt: 'Mar 14, 2026',
    stats: { label: 'Events synced', value: '156' },
    features: ['Two-way sync', 'Block personal events', 'Staff calendar merge', 'Availability check'],
  },
  {
    id: 'instagram', name: 'Instagram', icon: '📸', category: 'Social',
    description: 'Auto-post content, track DM bookings, review responses',
    status: 'connected', connectedAt: 'Mar 15, 2026',
    stats: { label: 'Posts this month', value: '8' },
    features: ['Auto-post content', 'DM monitoring', 'Story scheduling', 'Booking link in bio'],
  },
  {
    id: 'xero', name: 'Xero', icon: '📊', category: 'Accounting',
    description: 'Push income and expenses to Xero for self-assessment',
    status: 'available', connectedAt: null,
    stats: null,
    features: ['Auto-push invoices', 'Expense sync', 'Tax report export', 'Bank reconciliation'],
  },
  {
    id: 'quickbooks', name: 'QuickBooks', icon: '📒', category: 'Accounting',
    description: 'Sync financials to QuickBooks for your accountant',
    status: 'available', connectedAt: null,
    stats: null,
    features: ['Invoice sync', 'Expense categories', 'P&L reports', 'VAT tracking'],
  },
  {
    id: 'twilio', name: 'Twilio SMS', icon: '📱', category: 'Messaging',
    description: 'Send SMS reminders and confirmations to clients',
    status: 'available', connectedAt: null,
    stats: null,
    features: ['Booking confirmations', '24h reminders', 'Rebook nudges', 'Campaign SMS'],
  },
  {
    id: 'mailgun', name: 'Email (Resend)', icon: '📧', category: 'Messaging',
    description: 'Transactional and marketing emails to clients',
    status: 'available', connectedAt: null,
    stats: null,
    features: ['Booking emails', 'Aftercare instructions', 'Campaign newsletters', 'Branded templates'],
  },
  {
    id: 'google-reviews', name: 'Google Reviews', icon: '⭐', category: 'Reviews',
    description: 'Monitor and respond to Google Business reviews',
    status: 'coming_soon', connectedAt: null,
    stats: null,
    features: ['Review monitoring', 'AI-drafted responses', 'Review request automation', 'Rating tracker'],
  },
  {
    id: 'tiktok', name: 'TikTok Business', icon: '🎵', category: 'Social',
    description: 'Schedule and post short-form video content',
    status: 'coming_soon', connectedAt: null,
    stats: null,
    features: ['Video scheduling', 'Trend suggestions', 'Analytics', 'Booking link'],
  },
];

const categories = ['All', 'Payments', 'Messaging', 'Calendar', 'Social', 'Accounting', 'Reviews'];

export default function Integrations() {
  const [filter, setFilter] = useState('All');
  const [expanded, setExpanded] = useState(null);

  const filtered = filter === 'All' ? integrations : integrations.filter(i => i.category === filter);
  const connected = integrations.filter(i => i.status === 'connected').length;

  return (
    <div style={ds.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={ds.pageTitle}>Integrations</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>{connected} connected · {integrations.length} available</p>
      </div>

      {/* Connected summary */}
      <div style={{ ...ds.heroCard, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>INTEGRATION HUB</div>
            <div style={{ fontSize: 36, fontWeight: 700 }}>{connected}/{integrations.length}</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>connected</div>
          </div>
          <div style={{ fontSize: 40 }}>🔌</div>
        </div>
        {/* Connected icons */}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          {integrations.filter(i => i.status === 'connected').map(i => (
            <div key={i.id} style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            }}>{i.icon}</div>
          ))}
        </div>
      </div>

      {/* Category filter */}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 16, paddingBottom: 4 }}>
        {categories.map(c => (
          <button key={c} onClick={() => setFilter(c)} style={{
            ...ds.btnGhost, fontSize: 11, padding: '6px 12px', whiteSpace: 'nowrap',
            background: filter === c ? 'var(--accent)' : 'var(--bg-subtle)',
            color: filter === c ? '#fff' : 'var(--text-secondary)',
          }}>{c}</button>
        ))}
      </div>

      {/* Integration cards */}
      {filtered.map((integ, i) => {
        const statusConfig = {
          connected: { bg: 'var(--success-bg)', color: 'var(--success)', label: 'Connected' },
          available: { bg: 'var(--accent-light)', color: 'var(--accent)', label: 'Available' },
          coming_soon: { bg: 'var(--bg-subtle)', color: 'var(--text-muted)', label: 'Coming Soon' },
        }[integ.status];

        return (
          <div key={integ.id} style={{ ...ds.card, marginBottom: 10, cursor: 'pointer' }} onClick={() => setExpanded(expanded === i ? null : i)}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <div style={{
                width: 44, height: 44, borderRadius: 12,
                background: integ.status === 'connected' ? 'var(--success-bg)' : 'var(--bg-subtle)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0,
              }}>{integ.icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={type.heading}>{integ.name}</span>
                  <span style={{ ...ds.badge, background: statusConfig.bg, color: statusConfig.color }}>{statusConfig.label}</span>
                </div>
                <div style={{ ...type.bodySmall, fontSize: 12, marginTop: 2 }}>{integ.description}</div>
              </div>
            </div>

            {/* Stats for connected */}
            {integ.status === 'connected' && integ.stats && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, padding: '8px 12px', background: 'var(--bg-subtle)', borderRadius: 10 }}>
                <span style={{ ...type.bodySmall, fontSize: 12 }}>{integ.stats.label}</span>
                <span style={{ ...type.mono, fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>{integ.stats.value}</span>
              </div>
            )}

            {/* Expanded features */}
            {expanded === i && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-light)' }}>
                <div style={{ ...ds.sectionTitle, marginBottom: 8 }}>FEATURES</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {integ.features.map(f => (
                    <span key={f} style={{ ...ds.badge, background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>✓ {f}</span>
                  ))}
                </div>
                {integ.connectedAt && (
                  <div style={{ ...type.mono, fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>Connected {integ.connectedAt}</div>
                )}
                {integ.status === 'connected' && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button style={{ ...ds.btnGhost, flex: 1, fontSize: 11, background: 'var(--accent-light)', color: 'var(--accent)' }}>Settings</button>
                    <button style={{ ...ds.btnGhost, flex: 1, fontSize: 11, color: 'var(--danger)' }}>Disconnect</button>
                  </div>
                )}
                {integ.status === 'available' && (
                  <button style={{ ...ds.btnPrimary, padding: '10px 0', fontSize: 13 }}>Connect {integ.name} →</button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
