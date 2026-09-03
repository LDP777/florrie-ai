import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import Icon, { iconName } from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';

/**
 * SetupHub (/setup)
 *
 * One guided place that shows what's switched on, what isn't, why each
 * thing matters, and where to go to fix it. Settings stay where they are;
 * this page just reads /api/setup/status and points the way.
 */

async function authedGet(path) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
  });
  if (!res.ok) throw new Error(`GET ${path} ${res.status}`);
  return res.json();
}

/**
 * Builds the five sections from the status payload. `signed` comes from the
 * starter-pack endpoint and fails soft to false.
 */
function buildSections(status, signed) {
  const s = status || {};
  const biz = s.business || {};
  const svc = s.services || {};
  const ch = s.channels || {};
  const cl = s.clients || {};
  const prot = s.protection || {};
  const money = s.money || {};

  return [
    {
      title: 'Your business',
      items: [
        {
          key: 'name',
          label: 'Business name',
          why: 'Goes on your booking page and every message, so clients know it is you.',
          path: '/settings',
          done: !!biz.name,
        },
        {
          key: 'hours',
          label: 'Opening hours',
          why: 'Florrie only offers slots when you actually work.',
          path: '/settings',
          done: !!biz.hours,
        },
        {
          key: 'booking_slug',
          label: 'Booking page link',
          why: 'One link clients tap to book themselves in, day or night.',
          path: '/settings',
          done: !!biz.booking_slug,
          extra: biz.booking_slug && biz.slug ? `florrie.ai/book/${biz.slug}` : null,
        },
      ],
    },
    {
      title: 'Your services',
      items: [
        {
          key: 'treatments',
          label: 'Treatments added',
          why: 'Clients need something to book before anything else works.',
          path: '/treatments',
          done: (svc.treatments_count || 0) > 0,
        },
        {
          key: 'prices',
          label: 'Prices set',
          why: 'So your booking page and money tracking show real numbers.',
          path: '/treatments',
          done: !!svc.has_prices,
        },
        {
          key: 'deposits',
          label: 'Deposits switched on',
          why: 'A small deposit is the best cure for no shows there is. Needs card payments, below.',
          path: '/settings',
          done: !!svc.deposits,
          optional: true,
        },
      ],
    },
    {
      title: 'Your channels',
      items: [
        {
          key: 'channel',
          label: 'A way for clients to reach you',
          why: 'Instagram is free and takes two minutes. WhatsApp needs a spare number. Either one lets Florrie reply for you.',
          path: ch.whatsapp || ch.instagram ? '/inbox' : '/settings',
          done: !!(ch.whatsapp || ch.instagram || ch.sms),
          extra: ch.whatsapp && ch.instagram ? 'WhatsApp and Instagram' : ch.whatsapp ? 'WhatsApp' : ch.instagram ? 'Instagram' : ch.sms ? 'SMS' : null,
        },
        {
          key: 'signed',
          label: 'Messages signed with your name',
          why: 'Confirmations and reminders read like you sent them, not a robot.',
          path: '/whatsapp/templates',
          done: !!signed,
          optional: !ch.whatsapp,
        },
        {
          key: 'auto_reply',
          label: 'Auto-reply',
          why: 'Florrie answers clients while your hands are busy.',
          path: '/settings',
          done: !!ch.auto_reply,
        },
      ],
    },
    {
      title: 'Your clients',
      items: [
        {
          key: 'clients',
          label: 'Clients on your list',
          why: 'Import your regulars, or let them arrive as they book. Either counts.',
          path: '/import',
          done: !!cl.imported,
          optional: true,
        },
      ],
    },
    {
      title: 'Protection and money',
      items: [
        {
          key: 'form_built',
          label: 'Consultation form built',
          why: 'Covers you before new treatments, and it fills itself.',
          path: '/consultation-forms',
          done: (prot.forms_built || 0) > 0,
        },
        {
          key: 'form_attached',
          label: 'Form attached to treatments',
          why: 'The right form goes out automatically when that treatment is booked.',
          path: '/treatments',
          done: (prot.forms_attached || 0) > 0,
        },
        {
          key: 'stripe',
          label: 'Card payments connected',
          why: 'Take deposits and get paid for no shows, straight to your bank.',
          path: '/settings',
          done: !!money.stripe,
          optional: true,
        },
      ],
    },
  ];
}

function StatusDot({ done }) {
  if (done) {
    return (
      <span style={S.dotDone} aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6.5L5 9L9.5 3.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  return <span style={S.dotTodo} aria-hidden="true" />;
}

function ItemRow({ item, onNav }) {
  return (
    <button
      type="button"
      onClick={() => onNav(item.path)}
      style={S.itemRow}
      aria-label={`${item.label}${item.done ? ', done' : ', not set up yet'}`}
    >
      <StatusDot done={item.done} />
      <span style={S.itemBody}>
        <span style={S.itemLabel}>{item.label}{item.optional && !item.done && <span style={S.optionalTag}>optional</span>}</span>
        <span style={S.itemWhy}>{item.why}</span>
        {item.extra && (
          <span
            style={S.itemExtra}
            onClick={(e) => e.stopPropagation()}
          >
            {item.extra}
          </span>
        )}
      </span>
      <Icon name={iconName('chevron_right')} inline style={S.chevron} />
    </button>
  );
}

export default function SetupHub() {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [signed, setSigned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [st, pack] = await Promise.all([
        authedGet('/api/setup/status'),
        authedGet('/api/whatsapp/meta-templates/starter-pack').catch(() => null),
      ]);
      setStatus(st);
      // Signed when every starter-pack message already exists on the WABA.
      const items = pack?.pack;
      setSigned(Array.isArray(items) && items.length > 0 && items.every((t) => t.existing_status));
    } catch (err) {
      logger.error('Setup status load failed:', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div style={S.page}>
        <PageLoader />
      </div>
    );
  }

  if (error || !status) {
    return (
      <div style={S.page}>
        <div style={S.retryCard}>
          <div style={S.retryTitle}>Could not load your setup</div>
          <div style={S.retryText}>Probably just a wobble. Give it another go.</div>
          <button type="button" onClick={load} style={S.retryBtn}>Try again</button>
        </div>
      </div>
    );
  }

  const sections = buildSections(status, signed);
  const allItems = sections.flatMap((sec) => sec.items);
  // The bar measures the essentials. Card payments, deposits and an imported
  // list are worth doing and not required, and counting them left every
  // salon without Stripe stuck at 42 percent for life.
  const essentials = allItems.filter((i) => !i.optional);
  const total = essentials.length;
  const done = essentials.filter((i) => i.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const optionalDone = allItems.filter((i) => i.optional && i.done).length;
  const optionalTotal = allItems.filter((i) => i.optional).length;

  return (
    <div style={S.page}>
      <PageHeader
        eyebrow="Set up"
        title="Get Florrie fully working for you"
        subtitle="Everything here makes Florrie a bit sharper, and each row takes you straight to the right place."
      />

      <div style={S.progressWrap}>
        <div style={S.progressLabelRow}>
          <span style={S.progressLabel}>{done} of {total} essentials done{optionalTotal ? `, ${optionalDone} of ${optionalTotal} extras` : ''}</span>
          <span style={S.progressPct}>{pct}%</span>
        </div>
        <div style={S.progressTrack} role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}>
          <div style={{ ...S.progressFill, width: `${pct}%` }} />
        </div>
      </div>

      {sections.map((sec) => (
        <section key={sec.title} style={S.sectionCard}>
          <h2 style={S.sectionTitle}>{sec.title}</h2>
          <div style={S.itemList}>
            {sec.items.map((item) => (
              <ItemRow key={item.key} item={item} onNav={navigate} />
            ))}
          </div>
        </section>
      ))}

      <p style={S.footerNote}>
        Florrie works from the first treatment you add. The extras make her sharper, and each row takes you straight to the right place.
      </p>
    </div>
  );
}

const S = {
  optionalTag: { marginLeft: 8, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted, #6B5D54)', background: 'var(--bg, #FBF6F1)', padding: '2px 6px', borderRadius: 6, verticalAlign: 'middle' },
  page: {
    padding: '16px 16px 32px',
    maxWidth: 720,
    margin: '0 auto',
    fontFamily: 'var(--font-body, "Plus Jakarta Sans", sans-serif)',
    color: 'var(--text-primary, #241B17)',
  },

  progressWrap: {
    background: 'var(--bg-card, #FFFCF9)',
    border: '1px solid var(--border-light, #ede7e3)',
    borderRadius: 16,
    padding: '12px 16px 14px',
    marginBottom: 16,
    boxShadow: 'var(--shadow-xs, 0 1px 2px rgba(146,64,94,.04))',
  },
  progressLabelRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 8,
  },
  progressLabel: { fontSize: 13, fontWeight: 700 },
  progressPct: { fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #6B5D54)' },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    background: 'var(--border-light, #ede7e3)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    background: 'var(--accent, #92405e)',
    transition: 'width 0.4s ease',
  },

  sectionCard: {
    background: 'var(--bg-card, #FFFCF9)',
    border: '1px solid var(--border-light, #ede7e3)',
    borderRadius: 16,
    padding: '14px 8px 6px',
    marginBottom: 12,
    boxShadow: 'var(--shadow-xs, 0 1px 2px rgba(146,64,94,.04))',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 600,
    margin: '0 0 4px',
    padding: '0 8px',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  itemList: { display: 'flex', flexDirection: 'column' },

  itemRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    width: '100%',
    padding: '12px 8px',
    border: 'none',
    borderTop: '1px solid var(--border-light, #ede7e3)',
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  },
  dotDone: {
    width: 20,
    height: 20,
    borderRadius: '50%',
    background: 'var(--success, #386F52)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 1,
  },
  dotTodo: {
    width: 20,
    height: 20,
    borderRadius: '50%',
    border: '2px solid var(--accent, #92405e)',
    background: 'transparent',
    boxSizing: 'border-box',
    flexShrink: 0,
    marginTop: 1,
  },
  itemBody: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  itemLabel: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary, #241B17)',
  },
  itemWhy: {
    fontSize: 12,
    lineHeight: 1.45,
    color: 'var(--text-muted, #6B5D54)',
  },
  itemExtra: {
    fontSize: 12.5,
    fontWeight: 600,
    color: 'var(--accent, #92405e)',
    userSelect: 'all',
    WebkitUserSelect: 'all',
    cursor: 'text',
    marginTop: 2,
    wordBreak: 'break-all',
  },
  chevron: {
    fontSize: 20,
    color: 'var(--text-muted, #6B5D54)',
    opacity: 0.7,
    flexShrink: 0,
    marginTop: 1,
  },

  retryCard: {
    background: 'var(--bg-card, #FFFCF9)',
    border: '1px solid var(--border-light, #ede7e3)',
    borderRadius: 16,
    padding: '24px 20px',
    textAlign: 'center',
    marginTop: 24,
  },
  retryTitle: { fontSize: 15, fontWeight: 700, marginBottom: 4 },
  retryText: {
    fontSize: 13,
    color: 'var(--text-secondary, #574A42)',
    marginBottom: 14,
  },
  retryBtn: {
    padding: '9px 18px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--accent, #92405e)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  footerNote: {
    fontSize: 12.5,
    lineHeight: 1.55,
    color: 'var(--text-muted, #6B5D54)',
    textAlign: 'center',
    margin: '18px auto 0',
    maxWidth: 380,
  },
};
