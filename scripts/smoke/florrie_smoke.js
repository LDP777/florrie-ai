/**
 * Florrie smoke suite — run in a logged-in florrie.ai browser tab (console or
 * automation). Read-only except one far-future block roundtrip that always
 * cleans up after itself. Returns [{name, ok, info}] and logs a summary.
 *
 * Covers the seams that have actually broken in production:
 *  - public booking API up + shape (the postcode-column 404, 2026-07-03)
 *  - amended blocks: is_closed set correctly + visible to the public picker
 *  - wall-time invariant: picker maths must use string wall-reads
 *  - authed core endpoints (me / feed / money pulse / hours-exceptions)
 */
(async () => {
  const out = [];
  const t = (name, ok, info = '') => out.push({ name, ok: !!ok, info: String(info).slice(0, 140) });
  const api = 'https://api.florrie.ai';
  const j = async (path, opts = {}) => {
    const r = await fetch(api + path, opts);
    let b = null; try { b = await r.json(); } catch { /* non-json */ }
    return { s: r.status, b };
  };

  const key = Object.keys(localStorage).find(k => k.includes('auth-token'));
  const tok = key ? (JSON.parse(localStorage.getItem(key)) || {}).access_token : null;
  const H = tok ? { Authorization: `Bearer ${tok}` } : {};
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  // ---- Public booking surface --------------------------------------------
  let r = await j('/api/booking/ellindigo/page');
  t('public /page 200', r.s === 200, `status ${r.s}`);
  t('/page: salon + treatments present', r.b?.salon?.booking_slug === 'ellindigo' && (r.b?.treatments || []).length > 0, `${(r.b?.treatments || []).length} treatments`);
  t('/page: working_hours present', !!r.b?.salon?.working_hours);

  r = await j('/api/booking/ellindigo/reviews');
  t('public /reviews 200 + shape', r.s === 200 && typeof r.b?.count === 'number' && Array.isArray(r.b?.recent), `status ${r.s}`);

  r = await j(`/api/booking/ellindigo/availability?date=${tomorrow}`);
  t('availability 200 + appointments[] + blocks[]', r.s === 200 && Array.isArray(r.b?.appointments) && Array.isArray(r.b?.blocks), `status ${r.s}`);
  // Wall-time invariant: every starts_at must carry a parseable HH:MM at 11..16
  const wallOk = (r.b?.appointments || []).every(a => /^\d{2}:\d{2}$/.test(String(a.starts_at).slice(11, 16)));
  t('availability starts_at wall-readable', wallOk);

  r = await j(`/api/booking/ellindigo/availability-range?from=${tomorrow}&to=${tomorrow}`);
  t('availability-range 200 + closures[] + blocks[]', r.s === 200 && Array.isArray(r.b?.closures) && Array.isArray(r.b?.blocks), `status ${r.s}`);

  // ---- Authed core --------------------------------------------------------
  if (!tok) {
    t('auth token present', false, 'not logged in — authed checks skipped');
  } else {
    r = await j('/api/auth/me', { headers: H });
    t('auth /me 200', r.s === 200, `status ${r.s}`);
    r = await j('/api/activity/feed?limit=5', { headers: H });
    t('activity feed 200 + rows[]', r.s === 200 && Array.isArray(r.b?.rows), `status ${r.s}`);
    r = await j('/api/money/pulse', { headers: H });
    t('money pulse 200', r.s === 200, `status ${r.s}`);
    r = await j('/api/hours-exceptions', { headers: H });
    t('hours-exceptions GET 200', r.s === 200 && Array.isArray(r.b?.exceptions), `status ${r.s}`);

    // Block roundtrip on a far-future date (never user-visible), always cleaned up.
    let created = null;
    try {
      const cr = await j('/api/hours-exceptions', {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2030-01-15', type: 'amended', reason: 'other', note: 'SMOKE TEST - auto-deleted', start_time: '12:00', end_time: '13:00', notify_clients: false }),
      });
      created = cr.b?.exception || null;
      t('block POST 201', cr.s === 201 && !!created?.id, `status ${cr.s}`);
      t('amended block stores is_closed=false', created?.is_closed === false, `is_closed=${created?.is_closed}`);
      const av = await j('/api/booking/ellindigo/availability?date=2030-01-15');
      t('block visible to public picker', (av.b?.blocks || []).some(b => String(b.start_time).slice(0, 5) === '12:00'));
    } finally {
      if (created?.id) {
        const d = await j('/api/hours-exceptions/' + created.id, { method: 'DELETE', headers: H });
        t('block cleanup DELETE 200', d.s === 200, `status ${d.s}`);
      }
    }
  }

  const fails = out.filter(x => !x.ok);
  console.log(`FLORRIE SMOKE: ${out.length - fails.length}/${out.length} passed`, fails);
  return { passed: out.length - fails.length, total: out.length, fails, all: out };
})();
