import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import Icon, { iconName } from '../components/ui/Icon';

/**
 * ValueBreakdown , the "how did Florrie make me that money" screen.
 *
 * Reached by tapping the monthly value receipt on the Hub. It shows the total
 * Florrie helped bring in this month, split into honest parts, then lists every
 * single appointment that was counted , who, what, how much, and WHY it's
 * credited to Florrie , plus a plain note on how the counting works so Ellie can
 * trust (or challenge) the number rather than take a black-box brag on faith.
 */

function pounds(pence) {
  const v = (pence || 0) / 100;
  return `£${v.toFixed(2).replace(/\.00$/, '')}`;
}

function monthName(ym) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return 'This month';
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

// Wall-clock date read (stored local time in the slot , never tz-convert).
function apptDateLabel(iso) {
  if (!iso) return '';
  const d = String(iso).slice(0, 10);
  const t = String(iso).slice(11, 16);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  const dt = new Date(`${d}T12:00:00Z`);
  const day = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return t ? `${day} · ${t}` : day;
}

const REASON = {
  gap_fill: { label: 'Gap filled', note: 'booked soon after Florrie offered an open slot' },
  rebook: { label: 'Rebook nudge', note: 'booked after Florrie nudged them to rebook' },
};

export default function ValueBreakdown() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`${API_BASE}/api/usage/value-receipt`, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        if (!res.ok) throw new Error(`GET value-receipt ${res.status}`);
        const body = await res.json();
        if (!cancelled) setData(body);
      } catch (err) {
        logger.error('Value breakdown load failed:', err);
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const total = data?.total_pence || 0;
  const gap = data?.parts?.gap_fill_pence || 0;
  const rebook = data?.parts?.rebook_pence || 0;
  const deposits = data?.parts?.deposits_protected_pence || 0;
  const items = data?.items || [];

  return (
    <div style={S.page}>
      {/* No back button here. The shell already floats one top-left on every
          secondary screen, and this page rendered a second one right beside it
          — two identical affordances 14px apart, with the title squeezed
          between them and running underneath the floating pill. */}
      <header style={S.header}>
        <h1 style={S.title}>How Florrie helped</h1>
      </header>

      {loading && <div style={S.muted}>Adding it up…</div>}
      {!loading && error && <div style={S.muted}>Could not load your breakdown just now. Please try again.</div>}

      {!loading && !error && (
        <div style={S.body}>
          <div style={S.heroCard}>
            <div style={S.heroEyebrow}>{monthName(data?.month)}</div>
            <div style={S.heroAmount}>{pounds(total)}</div>
            <div style={S.heroSub}>helped in by Florrie this month</div>
          </div>

          <div style={S.partsRow}>
            {gap > 0 && <Part amount={pounds(gap)} label="gaps filled" />}
            {rebook > 0 && <Part amount={pounds(rebook)} label="rebook nudges" />}
            {deposits > 0 && <Part amount={pounds(deposits)} label="deposits protected" />}
          </div>

          {items.length > 0 ? (
            <>
              <div style={S.sectionLabel}>Every booking counted</div>
              <div style={S.list}>
                {items.map((it) => {
                  const r = REASON[it.reason] || { label: 'Florrie', note: '' };
                  return (
                    <div key={it.appointment_id} style={S.item}>
                      <div style={S.itemMain}>
                        <div style={S.itemName}>{it.client}</div>
                        <div style={S.itemMeta}>
                          {it.treatment}{it.appt_at ? ` · ${apptDateLabel(it.appt_at)}` : ''}
                        </div>
                        <div style={S.reasonRow}>
                          <span style={{ ...S.reasonTag, ...(it.reason === 'gap_fill' ? S.tagGap : S.tagRebook) }}>{r.label}</span>
                          <span style={S.reasonNote}>{r.note}</span>
                        </div>
                      </div>
                      <div style={S.itemAmount}>{pounds(it.amount_pence)}</div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div style={S.muted}>
              No bookings have been credited to Florrie yet this month. As she fills gaps and
              nudges rebooks, they'll show up here.
            </div>
          )}

          {deposits > 0 && (
            <div style={S.note}>
              <strong>{pounds(deposits)} protected by deposits.</strong> Deposits taken on this
              month's bookings , money that would be at risk from no-shows without one on file.
            </div>
          )}

          <div style={S.methodology}>
            <div style={S.methodTitle}>How this is counted</div>
            <p style={S.methodText}>
              A booking is only credited to Florrie when it lands shortly after she did the work:
              within 48 hours of her offering an open slot (a gap fill), or within 7 days of a
              rebook nudge she sent. It's an honest estimate, not a guarantee , some of these clients
              might have booked anyway, and Florrie won't have caught every one she helped. The full
              value of each appointment is shown, and the headline total also includes the deposits
              Florrie secured on this month's bookings (listed above).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Part({ amount, label }) {
  return (
    <div style={S.part}>
      <div style={S.partAmount}>{amount}</div>
      <div style={S.partLabel}>{label}</div>
    </div>
  );
}

const S = {
  page: {
    minHeight: 'var(--shell-viewport)', background: 'var(--bg)', color: 'var(--text-primary)',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)",
    padding: '12px 16px 24px',
    boxSizing: 'border-box', maxWidth: 560, margin: '0 auto',
  },
  header: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 },
  back: {
    width: 40, height: 40, borderRadius: 10, border: 'none', background: 'var(--tone-1, #fbf1ea)',
    color: 'var(--text-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  title: { fontSize: 22, fontWeight: 700, margin: 0, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  muted: { color: 'var(--text-muted)', fontSize: 14, padding: '18px 2px', lineHeight: 1.55 },
  body: { display: 'flex', flexDirection: 'column', gap: 16 },

  heroCard: { background: 'var(--tone-1, #fbf1ea)', borderRadius: 22, padding: '20px 18px', textAlign: 'center' },
  heroEyebrow: { fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 },
  // Money goes in the numeral face, at every size. Playfair's figures are
  // old-style — the 0 and the 4 drop below the baseline — which is handsome in
  // a heading and wrong in a total. The page title above keeps Playfair.
  heroAmount: {
    fontSize: 44, fontWeight: 700, color: 'var(--accent, #92405e)', lineHeight: 1,
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)",
    fontVariantNumeric: 'tabular-nums',
  },
  heroSub: { fontSize: 13.5, color: 'var(--text-secondary)', marginTop: 8 },

  partsRow: { display: 'flex', gap: 10, flexWrap: 'wrap' },
  part: { flex: '1 1 0', minWidth: 92, background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: 16, padding: '12px 10px', textAlign: 'center' },
  partAmount: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' },
  partLabel: { fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 },

  sectionLabel: { fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: 2 },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  item: { display: 'flex', alignItems: 'flex-start', gap: 12, background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: 16, padding: '12px 14px' },
  itemMain: { flex: 1, minWidth: 0 },
  itemName: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' },
  itemMeta: { fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 1 },
  reasonRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  reasonTag: { fontSize: 10.5, fontWeight: 800, letterSpacing: '0.02em', padding: '2px 8px', borderRadius: 999 },
  tagGap: { background: 'rgba(146,64,94,0.12)', color: 'var(--accent, #92405e)' },
  tagRebook: { background: 'rgba(201,169,110,0.18)', color: '#8a6d2f' },
  reasonNote: { fontSize: 11.5, color: 'var(--text-muted)' },
  itemAmount: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 },

  note: { background: 'var(--tone-1, #fbf1ea)', borderRadius: 16, padding: '12px 14px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 },
  methodology: { borderTop: '1px solid var(--border-light)', paddingTop: 14 },
  methodTitle: { fontSize: 12.5, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 6 },
  methodText: { fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0 },
};
