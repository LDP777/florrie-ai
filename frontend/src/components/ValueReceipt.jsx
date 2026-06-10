import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';

/**
 * ValueReceipt
 *
 * The monthly receipt for having Florrie: money her agentic actions recovered
 * (filled gaps, rebooks she nudged into existence) plus deposits protected and
 * the voice stat. Hidden entirely until there's something worth showing, so a
 * fresh account never sees an empty brag.
 */

async function authedGet(path) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
  });
  if (!res.ok) throw new Error(`GET ${path} ${res.status}`);
  return res.json();
}

function pounds(pence) {
  const v = (pence || 0) / 100;
  return v >= 100 ? `£${Math.round(v)}` : `£${v.toFixed(2).replace(/\.00$/, '')}`;
}

export default function ValueReceipt() {
  const [receipt, setReceipt] = useState(null);
  const [voice, setVoice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      authedGet('/api/usage/value-receipt').catch(() => null),
      authedGet('/api/usage/voice').catch(() => null),
    ]).then(([r, v]) => {
      if (!cancelled) { setReceipt(r); setVoice(v); }
    }).catch((err) => logger.error('Value receipt load failed:', err));
    return () => { cancelled = true; };
  }, []);

  if (!receipt) return null;
  const recovered = receipt.total_pence || 0;
  const deposits = receipt.parts?.deposits_protected_pence || 0;
  const voicePct = voice?.pct;

  // Nothing earned yet and no voice data: stay out of the way.
  if (recovered === 0 && deposits === 0 && voicePct == null) return null;

  const lines = [];
  if (receipt.parts?.gap_fill_pence > 0) lines.push(`${pounds(receipt.parts.gap_fill_pence)} of cancellations refilled`);
  if (receipt.parts?.rebook_pence > 0) lines.push(`${pounds(receipt.parts.rebook_pence)} from rebook nudges`);
  if (deposits > 0) lines.push(`${pounds(deposits)} protected by deposits`);
  if (voicePct != null && voice.total >= 5) lines.push(`${voicePct}% of her drafts sent without an edit`);

  return (
    <div style={S.card}>
      <div style={S.eyebrow}>This month</div>
      <div style={S.headline}>
        {recovered > 0
          ? <>Florrie found you <span style={S.amount}>{pounds(recovered)}</span></>
          : 'Florrie, quietly at work'}
      </div>
      {lines.length > 0 && (
        <div style={S.lines}>
          {lines.map((l) => (
            <div key={l} style={S.line}>
              <span style={S.dot} />
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const S = {
  card: {
    background: 'var(--bg-card, #fff)',
    border: '1px solid var(--border-light, #ede7e3)',
    borderRadius: 16,
    padding: '14px 16px',
    marginBottom: 14,
    boxShadow: 'var(--shadow-xs, 0 1px 2px rgba(146,64,94,.04))',
  },
  eyebrow: {
    fontSize: 10.5,
    fontWeight: 800,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: 'var(--text-muted, #8A7A72)',
    marginBottom: 4,
  },
  headline: {
    fontSize: 17,
    fontWeight: 600,
    fontFamily: 'var(--font-display, "Fraunces", Georgia, serif)',
    marginBottom: 8,
  },
  amount: { color: 'var(--accent, #92405e)', fontWeight: 700 },
  lines: { display: 'flex', flexDirection: 'column', gap: 5 },
  line: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
    color: 'var(--text-secondary, #4D423D)',
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 999,
    background: 'var(--accent, #92405e)',
    flexShrink: 0,
  },
};
