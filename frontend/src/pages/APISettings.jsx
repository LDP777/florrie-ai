/**
 * APISettings - Developer Tools
 *
 * Shows:
 *   - Real beautician ID and API base URL for third-party integrations
 *   - Accurate endpoint reference for every live backend route
 *   - Webhook config saved to DB (coming soon)
 *
 * Previously had hardcoded fake API keys, fake usage stats, and fake webhooks.
 * All removed - this page now shows only real data.
 */
import { useState } from 'react';
import { useBeautician } from '../lib/supabase.js';
import { ds, type } from '../lib/designSystem.js';
import PageLoader from '../components/PageLoader.jsx';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';

const tabs = ['API Reference', 'Your Account', 'Webhooks'];

const methodColor = {
  GET:    { bg: 'var(--success-bg)', color: 'var(--success)' },
  POST:   { bg: 'var(--accent-light)', color: 'var(--accent)' },
  PATCH:  { bg: 'var(--gold-light)', color: 'var(--gold)' },
  DELETE: { bg: 'var(--danger-bg)', color: 'var(--danger)' },
};

const endpoints = [
  { method: 'GET',   path: '/api/appointments',             description: 'List appointments with date range filtering', auth: true },
  { method: 'POST',  path: '/api/appointments',             description: 'Create a new appointment with conflict check', auth: true },
  { method: 'PATCH', path: '/api/appointments/:id',         description: 'Update status, reschedule, add notes', auth: true },
  { method: 'GET',   path: '/api/clients',                  description: 'List clients with search and status filter', auth: true },
  { method: 'POST',  path: '/api/clients',                  description: 'Create a new client record', auth: true },
  { method: 'GET',   path: '/api/treatments',               description: 'List all treatments in the service menu', auth: true },
  { method: 'GET',   path: '/api/booking/:slug',            description: 'Public booking page data (no auth)', auth: false },
  { method: 'POST',  path: '/api/booking/:slug/book',       description: 'Public booking submission (no auth)', auth: false },
  { method: 'GET',   path: '/api/money/pulse',              description: 'Weekly revenue, expenses, profit summary', auth: true },
  { method: 'GET',   path: '/api/money/tax-summary',        description: 'UK tax year income/expense summary', auth: true },
  { method: 'GET',   path: '/api/consultation-forms',       description: 'List consultation form templates', auth: true },
  { method: 'POST',  path: '/api/consultation-forms',       description: 'Create a new consultation form', auth: true },
  { method: 'GET',   path: '/api/notifications/sms/config',               description: 'Get Bird SMS configuration and status', auth: true },
  { method: 'PUT',   path: '/api/notifications/sms/config',               description: 'Update SMS sender name and preferences', auth: true },
  { method: 'POST',  path: '/api/notifications/sms/test',                 description: 'Send a test SMS to verify Bird connection', auth: true },
  { method: 'GET',   path: '/api/whatsapp/status',          description: 'WhatsApp Business connection status', auth: true },
  { method: 'GET',   path: '/api/gcal/status',              description: 'Google Calendar connection status', auth: true },
  { method: 'GET',   path: '/api/stripe/status',            description: 'Stripe Connect account status', auth: true },
  { method: 'POST',  path: '/api/exports/clients',          description: 'Export client list as CSV', auth: true },
  { method: 'GET',   path: '/api/promo-codes',              description: 'List active promo codes', auth: true },
  { method: 'POST',  path: '/api/promo-codes',              description: 'Create a promo code', auth: true },
  { method: 'GET',   path: '/api/hours-exceptions',         description: 'List working hour exceptions / holidays', auth: true },
  { method: 'POST',  path: '/api/hours-exceptions',         description: 'Add a working hour exception', auth: true },
];

export default function APISettings() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState(0);
  const [copied, setCopied] = useState(null);

  if (bLoading) return <div style={ds.page}><PageLoader /></div>;

  const apiBase = window.location.origin;

  function copyToClipboard(text, key) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1800);
    });
  }

  return (
    <div style={ds.page}>
      <PageHeader
        title="Developer Tools"
        subtitle="API reference, account identifiers, and integrations"
      />

      {/* Hero */}
      <div style={{ ...ds.heroCard, marginBottom: 20, background: 'linear-gradient(135deg, #2D2D3F 0%, #1A1A2E 40%, #B9466D 100%)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>FLORRIE API</div>
            <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em' }}>v1.0</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>REST · JSON · Bearer auth</div>
          </div>
          <div style={{ fontSize: 40 }}><Icon name="sparkles" size={40} /></div>
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
          {[
            { label: 'Endpoints', val: endpoints.length },
            { label: 'Auth type', val: 'Bearer JWT' },
            { label: 'Format', val: 'JSON' },
          ].map(s => (
            <div key={s.label} style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{s.val}</div>
              <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ ...ds.tabBar, marginBottom: 16 }}>
        {tabs.map((t, i) => (
          <button key={t} onClick={() => setTab(i)} style={{ ...ds.tab, ...(tab === i ? ds.tabActive : {}) }}>{t}</button>
        ))}
      </div>

      {/* API Reference */}
      {tab === 0 && (
        <div>
          <div style={{ ...ds.sectionTitle, marginBottom: 10 }}>LIVE ENDPOINTS</div>
          {endpoints.map((ep, i) => {
            const mc = methodColor[ep.method] || methodColor.GET;
            return (
              <div key={i} style={{ ...ds.card, marginBottom: 8, padding: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ ...ds.badge, background: mc.bg, color: mc.color,
                    fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, minWidth: 44, textAlign: 'center',
                  }}>{ep.method}</span>
                  <span style={{ ...type.mono, fontSize: 12, color: 'var(--text-primary)', wordBreak: 'break-all' }}>{ep.path}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ ...type.bodySmall, fontSize: 11 }}>{ep.description}</span>
                  {!ep.auth && <span style={{ ...ds.badge, ...ds.badgeGold, fontSize: 9 }}>Public</span>}
                </div>
              </div>
            );
          })}
          <div style={{ ...ds.insightCard, marginTop: 16 }}>
            <span style={{ fontSize: 18 }}><Icon name="lock" size={15} /></span>
            <div style={{ ...type.bodySmall, fontSize: 12, lineHeight: 1.5 }}>
              All authenticated endpoints require a <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-subtle)', padding: '1px 4px', borderRadius: 6 }}>Bearer</code> token
              from your Supabase session. Pass it as the <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-subtle)', padding: '1px 4px', borderRadius: 6 }}>Authorization</code> header.
            </div>
          </div>
        </div>
      )}

      {/* Your Account */}
      {tab === 1 && (
        <div>
          <div style={{ ...ds.sectionTitle, marginBottom: 10 }}>ACCOUNT IDENTIFIERS</div>

          {[
            { label: 'Beautician ID', value: beautician?.id || '-', key: 'id', description: 'Your unique account ID - use this when making direct Supabase queries' },
            { label: 'API Base URL', value: apiBase, key: 'base', description: 'Prefix all API calls with this base URL' },
            { label: 'Booking Slug', value: beautician?.booking_slug ? `${apiBase}/book/${beautician.booking_slug}` : '-', key: 'slug', description: 'Your public booking page URL' },
          ].map(item => (
            <div key={item.key} style={{ ...ds.card, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                <span style={type.heading}>{item.label}</span>
                {item.value !== '-' && (
                  <button className="fl-tap"
                    onClick={() => copyToClipboard(item.value, item.key)}
                    style={{ ...ds.btnGhost, fontSize: 11, padding: '4px 10px' }}
                  >
                    {copied === item.key ? 'Copied' : 'Copy'}
                  </button>
                )}
              </div>
              <div style={{ background: 'var(--bg-subtle)', borderRadius: 10, padding: '8px 12px', marginBottom: 6,
                fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)',
                wordBreak: 'break-all',
              }}>
                {item.value}
              </div>
              <div style={{ ...type.bodySmall, fontSize: 11 }}>{item.description}</div>
            </div>
          ))}

          {/* Authentication info */}
          <div style={{ ...ds.card, marginTop: 8 }}>
            <div style={{ ...type.heading, marginBottom: 8 }}>Authentication</div>
            <div style={{ ...type.bodySmall, fontSize: 13, lineHeight: 1.6 }}>
              The florrie.ai API uses Supabase JWT tokens for authentication. When you sign in, your session token is stored locally and passed as a Bearer token on every authenticated API request.
            </div>
            <div style={{ background: 'var(--bg-subtle)', borderRadius: 10, padding: '10px 12px', marginTop: 10,
              fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.8,
            }}>
              Authorization: Bearer {'<your-supabase-jwt>'}
            </div>
          </div>
        </div>
      )}

      {/* Webhooks */}
      {tab === 2 && (
        <div>
          <div style={{ ...ds.heroCard, textAlign: 'center', marginBottom: 16, background: 'linear-gradient(135deg, var(--bg-card) 0%, var(--bg-subtle) 100%)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}><Icon name="link" size={36} /></div>
            <div style={{ ...type.heading, marginBottom: 6, fontSize: 16 }}>Webhooks coming soon</div>
            <div style={{ ...type.bodySmall, fontSize: 13, lineHeight: 1.6 }}>
              Configure outbound webhooks to receive real-time events - booking created, appointment completed, new client, and more. We'll send a POST request to your URL when these events fire.
            </div>
          </div>

          <div style={{ ...ds.sectionTitle, marginBottom: 10 }}>PLANNED EVENTS</div>
          {[
            { event: 'booking.created', description: 'A new booking is made via the booking page' },
            { event: 'booking.cancelled', description: 'A booking is cancelled by the beautician' },
            { event: 'appointment.completed', description: 'An appointment is marked as complete' },
            { event: 'client.created', description: 'A new client record is added' },
            { event: 'payment.received', description: 'A payment is collected via Stripe' },
          ].map(ev => (
            <div key={ev.event} style={{ ...ds.card, marginBottom: 8, padding: '10px 14px' }}>
              <div style={{ ...type.mono, fontSize: 12, color: 'var(--accent)', marginBottom: 3 }}>{ev.event}</div>
              <div style={{ ...type.bodySmall, fontSize: 12 }}>{ev.description}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
