import { useState } from 'react';
import { ds, type } from '../lib/designSystem.js';

const apiKeys = [
  { id: 1, name: 'Production Key', prefix: 'fl_live_', last4: '8x2m', created: 'Mar 10, 2026', lastUsed: '2 min ago', calls: 1247, status: 'active' },
  { id: 2, name: 'Development Key', prefix: 'fl_test_', last4: 'k9p3', created: 'Mar 10, 2026', lastUsed: '3h ago', calls: 892, status: 'active' },
  { id: 3, name: 'Old Integration Key', prefix: 'fl_live_', last4: 'v1n0', created: 'Feb 28, 2026', lastUsed: 'Mar 15', calls: 34, status: 'revoked' },
];

const webhooks = [
  { id: 1, url: 'https://hooks.zapier.com/hooks/catch/12345/abc', events: ['booking.created', 'booking.cancelled'], status: 'active', lastTriggered: '5 min ago', successRate: 98 },
  { id: 2, url: 'https://my-crm.example.com/webhooks/florrie', events: ['client.created', 'appointment.completed'], status: 'active', lastTriggered: '2h ago', successRate: 100 },
  { id: 3, url: 'https://old-system.example.com/api/hook', events: ['booking.created'], status: 'paused', lastTriggered: 'Mar 20', successRate: 72 },
];

const endpoints = [
  { method: 'GET', path: '/api/appointments', description: 'List appointments with date range filtering', auth: true },
  { method: 'POST', path: '/api/appointments', description: 'Create a new appointment with conflict check', auth: true },
  { method: 'PATCH', path: '/api/appointments/:id', description: 'Update status, reschedule, add notes', auth: true },
  { method: 'GET', path: '/api/clients', description: 'List clients with search and status filter', auth: true },
  { method: 'POST', path: '/api/clients', description: 'Create a new client record', auth: true },
  { method: 'GET', path: '/api/treatments', description: 'List all treatments in the service menu', auth: true },
  { method: 'GET', path: '/api/booking/:slug', description: 'Public booking page data (no auth)', auth: false },
  { method: 'POST', path: '/api/booking/:slug/book', description: 'Public booking submission (no auth)', auth: false },
  { method: 'GET', path: '/api/money/pulse', description: 'Weekly revenue, expenses, profit summary', auth: true },
  { method: 'GET', path: '/api/money/tax-summary', description: 'UK tax year income/expense summary', auth: true },
  { method: 'POST', path: '/api/money/expenses/scan', description: 'OCR receipt scan via Claude Vision', auth: true },
];

const tabs = ['API Keys', 'Webhooks', 'Endpoints', 'Usage'];

const methodColor = {
  GET: { bg: 'var(--success-bg)', color: 'var(--success)' },
  POST: { bg: 'var(--accent-light)', color: 'var(--accent)' },
  PATCH: { bg: 'var(--gold-light)', color: 'var(--gold)' },
  DELETE: { bg: 'var(--danger-bg)', color: 'var(--danger)' },
};

export default function APISettings() {
  const [tab, setTab] = useState(0);

  return (
    <div style={ds.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={ds.pageTitle}>API & Webhooks</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>Developer tools for custom integrations</p>
      </div>

      {/* Hero */}
      <div style={{ ...ds.heroCard, marginBottom: 20, background: 'linear-gradient(135deg, #2D2D3F 0%, #1A1A2E 40%, #C76B8A 100%)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>DEVELOPER API</div>
            <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em' }}>v1.0</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>REST · JSON · Bearer auth</div>
          </div>
          <div style={{ fontSize: 40 }}>⚡</div>
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
          {[{ label: 'Endpoints', val: endpoints.length }, { label: 'API calls (30d)', val: '2,139' }, { label: 'Webhooks', val: webhooks.filter(w => w.status === 'active').length }].map(s => (
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

      {/* API Keys */}
      {tab === 0 && (
        <div>
          {apiKeys.map(key => (
            <div key={key.id} style={{
              ...ds.card, marginBottom: 10,
              opacity: key.status === 'revoked' ? 0.5 : 1,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={type.heading}>{key.name}</span>
                <span style={{
                  ...ds.badge,
                  ...(key.status === 'active' ? ds.badgeSuccess : ds.badgeDanger),
                }}>{key.status}</span>
              </div>
              <div style={{
                background: 'var(--bg-subtle)', borderRadius: 8, padding: '8px 12px', marginBottom: 8,
                fontFamily: "var(--font-mono, 'DM Mono', monospace)", fontSize: 13,
                color: 'var(--text-secondary)', letterSpacing: '0.03em',
              }}>
                {key.prefix}{'•'.repeat(24)}{key.last4}
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ ...type.mono, fontSize: 10, color: 'var(--text-muted)' }}>Created: {key.created}</span>
                <span style={{ ...type.mono, fontSize: 10, color: 'var(--text-muted)' }}>Last used: {key.lastUsed}</span>
                <span style={{ ...type.mono, fontSize: 10, color: 'var(--accent)' }}>{key.calls.toLocaleString()} calls</span>
              </div>
              {key.status === 'active' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button style={{ ...ds.btnGhost, fontSize: 11 }}>Copy Key</button>
                  <button style={{ ...ds.btnGhost, fontSize: 11 }}>Roll Key</button>
                  <button style={{ ...ds.btnGhost, fontSize: 11, color: 'var(--danger)' }}>Revoke</button>
                </div>
              )}
            </div>
          ))}
          <button style={{ ...ds.btnPrimary, marginTop: 8 }}>+ Generate New API Key</button>
        </div>
      )}

      {/* Webhooks */}
      {tab === 1 && (
        <div>
          {webhooks.map(wh => (
            <div key={wh.id} style={{ ...ds.card, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{
                  ...ds.badge,
                  ...(wh.status === 'active' ? ds.badgeSuccess : ds.badgeWarning),
                }}>{wh.status}</span>
                <span style={{ ...type.mono, fontSize: 10, color: 'var(--text-muted)' }}>Last: {wh.lastTriggered}</span>
              </div>
              <div style={{
                background: 'var(--bg-subtle)', borderRadius: 8, padding: '6px 10px', marginBottom: 8,
                ...type.mono, fontSize: 11, color: 'var(--text-secondary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{wh.url}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                {wh.events.map(e => (
                  <span key={e} style={{ ...ds.badge, background: 'var(--bg-subtle)', color: 'var(--text-secondary)', fontSize: 10 }}>{e}</span>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ ...type.bodySmall, fontSize: 11 }}>Success rate: <strong>{wh.successRate}%</strong></span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button style={{ ...ds.btnGhost, fontSize: 11 }}>Test</button>
                  <button style={{ ...ds.btnGhost, fontSize: 11 }}>Edit</button>
                </div>
              </div>
            </div>
          ))}
          <button style={{ ...ds.btnPrimary, marginTop: 8 }}>+ Add Webhook Endpoint</button>
        </div>
      )}

      {/* Endpoints */}
      {tab === 2 && (
        <div>
          <div style={{ ...ds.sectionTitle, marginBottom: 10 }}>AVAILABLE ENDPOINTS</div>
          {endpoints.map((ep, i) => {
            const mc = methodColor[ep.method];
            return (
              <div key={i} style={{ ...ds.card, marginBottom: 8, padding: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{
                    ...ds.badge, background: mc.bg, color: mc.color,
                    fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, minWidth: 40, textAlign: 'center',
                  }}>{ep.method}</span>
                  <span style={{ ...type.mono, fontSize: 12, color: 'var(--text-primary)' }}>{ep.path}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ ...type.bodySmall, fontSize: 11 }}>{ep.description}</span>
                  {!ep.auth && <span style={{ ...ds.badge, ...ds.badgeGold, fontSize: 9 }}>Public</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Usage */}
      {tab === 3 && (
        <div>
          <div style={{ ...ds.card, marginBottom: 16 }}>
            <div style={{ ...type.heading, marginBottom: 12 }}>API Usage — Last 7 Days</div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 100 }}>
              {[
                { day: 'Mon', calls: 280 },
                { day: 'Tue', calls: 340 },
                { day: 'Wed', calls: 310 },
                { day: 'Thu', calls: 420 },
                { day: 'Fri', calls: 380 },
                { day: 'Sat', calls: 250 },
                { day: 'Sun', calls: 159 },
              ].map(d => (
                <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{
                    width: '80%', height: `${(d.calls / 420) * 80}px`,
                    background: 'var(--accent)', borderRadius: '4px 4px 0 0', minHeight: 4,
                  }} />
                  <span style={{ ...type.mono, fontSize: 9, marginTop: 4, color: 'var(--text-muted)' }}>{d.day}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={ds.statsGrid}>
            {[
              { label: 'Total calls', val: '2,139', icon: '📊' },
              { label: 'Avg latency', val: '142ms', icon: '⚡' },
              { label: 'Error rate', val: '0.3%', icon: '❌' },
              { label: 'Rate limit', val: '1K/hr', icon: '🚦' },
            ].map(s => (
              <div key={s.label} style={ds.statCard}>
                <span style={{ fontSize: 16 }}>{s.icon}</span>
                <div style={{ ...ds.statValue, marginTop: 4 }}>{s.val}</div>
                <div style={ds.statLabel}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Top endpoints by usage */}
          <div style={{ ...ds.card, marginTop: 16 }}>
            <div style={{ ...type.heading, marginBottom: 10 }}>Top Endpoints</div>
            {[
              { path: 'GET /api/appointments', calls: 892, pct: 42 },
              { path: 'GET /api/clients', calls: 456, pct: 21 },
              { path: 'POST /api/booking/:slug/book', calls: 234, pct: 11 },
              { path: 'GET /api/money/pulse', calls: 198, pct: 9 },
              { path: 'POST /api/appointments', calls: 167, pct: 8 },
            ].map(ep => (
              <div key={ep.path} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ ...type.mono, fontSize: 11 }}>{ep.path}</span>
                  <span style={{ ...type.mono, fontSize: 11, color: 'var(--accent)' }}>{ep.calls}</span>
                </div>
                <div style={{ height: 4, background: 'var(--bg-subtle)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${ep.pct}%`, background: 'var(--accent)', borderRadius: 2 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
