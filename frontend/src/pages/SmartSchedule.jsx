import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Button from '../components/ui/Button';
import Icon from '../components/ui/Icon';
import Money from '../components/ui/Money';
import { computeSchedule, salonClock, scheduleRange, suggestionsForGap } from './smart-schedule-model.js';

/** Schedule gaps and client ideas from saved appointments, hours and blocked time. */

const DEAD_STATUSES = ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show'];

function computeSuggestions(clients, treatments) {
  const now = new Date();
  const rebook_due = [];
  const dormant_rescue = [];

  const treatmentById = new Map((treatments || []).map(t => [t.id, t]));
  (clients || []).forEach(c => {
    const appts = (c.appointments || [])
      .map(a => ({ date: new Date(String(a.starts_at || a.created_at).slice(0, 19)), treatment_id: a.treatment_id, price: a.price_cents, status: a.status }))
      .filter(a => !isNaN(a.date) && a.date <= now && a.status === 'completed')
      .sort((a, b) => b.date - a.date);

    if (appts.length === 0) return;
    const daysSince = Math.floor((now - appts[0].date) / 86400000);

    // Compute average interval
    let avgInterval = null;
    if (appts.length >= 2) {
      const intervals = [];
      for (let i = 0; i < appts.length - 1; i++) {
        intervals.push(Math.floor((appts[i].date - appts[i + 1].date) / 86400000));
      }
      avgInterval = Math.round(intervals.reduce((s, v) => s + v, 0) / intervals.length);
    }

    const lastT = treatmentById.get(appts[0]?.treatment_id);
    const lastTreatment = lastT?.name || 'Treatment';
    if (!lastT || lastT.is_active === false || !(Number(lastT.duration_minutes) > 0)) return;
    const matchingTreatment = lastT;
    const clientObj = { id: c.id, first_name: c.first_name || '', last_name: c.last_name || '' };

    if (daysSince >= 60) {
      dormant_rescue.push({
        client: clientObj,
        last_visit_days: daysSince,
        treatment: matchingTreatment,
        reason: `Hasn't been in ${daysSince} days, send a comeback offer?`,
      });
    } else if (avgInterval > 0 && daysSince > avgInterval) {
      rebook_due.push({
        client: clientObj,
        treatment: matchingTreatment,
        days_overdue: daysSince - avgInterval,
        reason: `Last ${lastTreatment} visit was ${daysSince} days ago; previous gaps averaged ${avgInterval} days`,
      });
    }
  });

  return {
    rebook_due: rebook_due.sort((a, b) => b.days_overdue - a.days_overdue).slice(0, 5),
    waitlist_match: [], // Populated by gap-fill engine API
    dormant_rescue: dormant_rescue.sort((a, b) => b.last_visit_days - a.last_visit_days).slice(0, 5),
  };
}

function computeDayStats(appts) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const counts = Array(7).fill(0);
  appts.forEach(a => {
    if (!a.starts_at || a.status !== 'completed') return;
    const d = new Date(`${a.starts_at.slice(0, 10)}T12:00:00`);
    if (!isNaN(d)) counts[d.getDay()]++;
  });
  const workingDays = [1, 2, 3, 4, 5, 6, 0].filter(d => counts[d] > 0);
  const max = Math.max(...workingDays.map(d => counts[d]), 1);
  return workingDays
    .map(d => ({ name: dayNames[d], count: counts[d], pct: Math.round((counts[d] / max) * 100) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

/**
 * Blended price of an hour of her actual price list, in pence.
 *
 * "Potential appointment value" used to be gap hours times a hardcoded £35, a number that
 * had nothing to do with anybody's prices. Null when there is nothing to work
 * it out from, and the tile says so instead of printing a made-up figure.
 */
function hourlyRatePence(treatments) {
  const rows = (treatments || []).filter(
    t => t.is_active !== false && Number(t?.price_cents) > 0 && Number(t?.duration_minutes) > 0
  );
  if (!rows.length) return null;
  const pence = rows.reduce((s, t) => s + Number(t.price_cents), 0);
  const minutes = rows.reduce((s, t) => s + Number(t.duration_minutes), 0);
  if (!minutes) return null;
  return (pence / minutes) * 60;
}

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Schedule request timed out'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export default function SmartSchedule() {
  const { beautician, loading: profileLoading, refresh: refreshProfile } = useBeautician();
  const [gaps, setGaps] = useState([]);
  const [schedule, setSchedule] = useState(null);
  const [suggestions, setSuggestions] = useState({ rebook_due: [], waitlist_match: [], dormant_rescue: [] });
  const [allAppts, setAllAppts] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [tab, setTab] = useState('gaps');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [ideasLoading, setIdeasLoading] = useState(false);
  const [ideasError, setIdeasError] = useState(null);
  const [selectedGap, setSelectedGap] = useState(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(null);
  const request = useRef({ seq: 0, controller: null });
  const fillRequests = useRef(new Map());
  const copyTimer = useRef(null);
  const navigate = useNavigate();
  const slug = beautician?.booking_slug || beautician?.slug;

  async function copyBookingLink() {
    if (!slug) { navigate('/settings?section=profile'); return; }
    setCopyError(null); setCopied(false); const seq = request.current.seq;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(`https://florrie.ai/book/${encodeURIComponent(slug)}`);
      if (seq !== request.current.seq) return;
      setCopied(true); clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      if (seq === request.current.seq) setCopyError('Could not copy the booking link. Try again, or open your booking page below.');
    }
  }
  function FillFallback({ compact }) {
    return <div style={compact ? styles.fillFallbackCompact : styles.fillFallback}>
      <p style={styles.fillFallbackText}>No matching client ideas for this gap. You can share your availability or booking page.</p>
      <button style={styles.offerBtn} onClick={() => navigate('/content')}>Create an availability post</button>
      <button style={styles.fillSecondaryBtn} onClick={copyBookingLink}>{copied ? 'Booking link copied' : (slug ? 'Copy booking link' : 'Set up booking link')}</button>
    </div>;
  }
  useEffect(() => {
    if (!profileLoading) loadData();
    return () => { request.current.seq++; request.current.controller?.abort(); fillRequests.current.forEach(ac => ac.abort()); clearTimeout(copyTimer.current); };
  }, [beautician, profileLoading]);

  async function readRows(query, signal) {
    const { data, error } = await withAbort(query.limit(1000).abortSignal(signal), signal);
    if (error) throw error;
    if (!Array.isArray(data) || data.length >= 1000) throw new Error('Could not read the complete schedule. Please use Calendar and try again.');
    return data;
  }
  async function loadData() {
    request.current.controller?.abort();
    const seq = ++request.current.seq, ac = new AbortController(); request.current.controller = ac;
    const current = () => request.current.seq === seq;
    const killer = setTimeout(() => ac.abort(), 15000);
    setLoading(true); setLoadError(null); setSelectedGap(null); setSchedule(null); setGaps([]); setFillGapState({}); setCopied(false); setCopyError(null); clearTimeout(copyTimer.current);
    setIdeasError(null); setIdeasLoading(true); setSuggestions({ rebook_due: [], waitlist_match: [], dormant_rescue: [] }); setAllAppts([]);
    if (!beautician || !supabase) {
      clearTimeout(killer); setLoading(false); setIdeasLoading(false); setLoadError('Could not load your business profile. Try again.'); return;
    }
    let now;
    try { now = salonClock(new Date(), beautician.timezone); }
    catch { clearTimeout(killer); setLoading(false); setIdeasLoading(false); setLoadError('Check your business timezone, then refresh Schedule.'); return; }
    const range = scheduleRange(now), historyStart = new Date(now), previousDay = new Date(now);
    previousDay.setDate(previousDay.getDate() - 1);
    historyStart.setDate(historyStart.getDate() - 180);
    let rows;
    try {
      const [appointments, treatmentRows, exceptions] = await Promise.all([
        readRows(supabase.from('appointments').select('id,client_id,starts_at,ends_at,duration_minutes,buffer_minutes,extra_padding_minutes,status,treatment_id').eq('beautician_id', beautician.id).lt('starts_at', `${range.until}T00:00:00Z`).or(`ends_at.gt.${range.from}T00:00:00Z,starts_at.gte.${scheduleRange(previousDay).from}T00:00:00Z`).order('starts_at'), ac.signal),
        readRows(supabase.from('treatments').select('id,name,duration_minutes,buffer_minutes,price_cents,is_active').eq('beautician_id', beautician.id), ac.signal),
        readRows(supabase.from('hours_exceptions').select('*').eq('beautician_id', beautician.id).lt('date', range.until).or(`end_date.gte.${range.from},date.gte.${range.from}`), ac.signal),
      ]);
      rows = treatmentRows;
      const computed = computeSchedule({ appointments, treatments: treatmentRows, exceptions, workingHours: beautician.working_hours, now });
      if (!current()) return;
      setTreatments(treatmentRows); setSchedule(computed); setGaps(computed.gaps);
    } catch (error) {
      if (!current()) return;
      ac.abort(); logger.error('Schedule read failed:', error);
      setLoadError(error instanceof Error && /Check|appointment has/.test(error.message) ? error.message : 'Could not check your schedule and blocked time. Try again.');
      setIdeasLoading(false); return;
    } finally {
      clearTimeout(killer); if (current()) setLoading(false);
    }
    // Optional history and matches cannot delay the diary or turn a failed read
    // into a statement that no clients are due. Restrict history to six months.
    const ideasKiller = setTimeout(() => ac.abort(), 15000);
    try {
      const historyPromise = readRows(supabase.from('appointments').select('id,client_id,starts_at,created_at,price_cents,status,treatment_id,clients(id,first_name,last_name)').eq('beautician_id', beautician.id).eq('status', 'completed').gte('starts_at', `${scheduleRange(historyStart).from}T00:00:00Z`).lt('starts_at', `${range.from}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:00Z`), ac.signal);
      const futurePromise = readRows(supabase.from('appointments').select('client_id,status').eq('beautician_id', beautician.id).gte('starts_at', `${range.from}T00:00:00Z`), ac.signal);
      const matchesPromise = (async () => {
        const { data, error } = await withAbort(supabase.auth.getSession(), ac.signal);
        if (error || !data?.session?.access_token) throw new Error('Session unavailable');
        const response = await fetch(`${API_BASE}/api/features/gap-fill-suggestions`, { headers: { Authorization: `Bearer ${data.session.access_token}` }, signal: ac.signal });
        if (!response.ok) throw new Error('Could not load matches');
        const body = await response.json();
        if (!Array.isArray(body.suggestions)) throw new Error('Missing matches');
        return body.suggestions;
      })();
      const [history, future, matches] = await Promise.all([historyPromise, futurePromise, matchesPromise]);
      if (!current()) return;
      const bookedClients = new Set(future.filter(a => !DEAD_STATUSES.includes(a.status) && a.status !== 'rescheduled' && a.status !== 'completed').map(a => a.client_id));
      const grouped = new Map();
      history.forEach(a => { if (!a.clients?.id || bookedClients.has(a.client_id)) return; if (!grouped.has(a.client_id)) grouped.set(a.client_id, { ...a.clients, appointments: [] }); grouped.get(a.client_id).appointments.push(a); });
      const computed = computeSuggestions([...grouped.values()], rows);
      computed.waitlist_match = matches.flatMap(s => (s.matches || []).filter(m => m.type === 'waitlist' && m.client?.id && m.treatment).map(m => ({ client: m.client, treatment: rows.find(t => t.id === m.treatment.id) || m.treatment, reason: m.reason, gap: s.gap }))).slice(0, 5);
      setSuggestions(computed); setAllAppts(history);
    } catch (error) {
      if (current()) { logger.error('Schedule ideas read failed:', error); setIdeasError('Could not check client ideas and history. Your schedule is still available.'); }
    } finally { clearTimeout(ideasKiller); if (current()) setIdeasLoading(false); }
  }

  // One tap: ask the gap-fill engine to offer this day's gap to its matched
  // clients, THROUGH the outbound guard (so with the dial on 'ask' the offers
  // land in the Outbox for approval, never raw sends).
  const [fillGapState, setFillGapState] = useState({});
  async function handleFillGap(gap) {
    if (fillRequests.current.has(gap.id) || loading || loadError) return;
    const ac = new AbortController(), seq = request.current.seq;
    fillRequests.current.set(gap.id, ac);
    const killer = setTimeout(() => ac.abort(), 15000);
    setFillGapState(prev => ({ ...prev, [gap.id]: { busy: true } }));
    try {
      const token = (await withAbort(supabase?.auth.getSession(), ac.signal))?.data?.session?.access_token;
      if (!token) throw new Error('Your session could not be checked. Refresh Schedule and try again.');
      const res = await fetch(`${API_BASE}/api/suggestions/fill-gap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ date: gap.date, start_time: gap.start, end_time: gap.end }),
        signal: ac.signal,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'failed');
      if (seq !== request.current.seq) return;
      let note;
      if (d.sent > 0 && d.held > 0) note = `Offered to ${d.sent}, ${d.held} more waiting for your OK in the Outbox`;
      else if (d.sent > 0) note = `Offered to ${d.sent} client${d.sent === 1 ? '' : 's'}`;
      else if (d.held > 0) note = `${d.held} offer${d.held === 1 ? '' : 's'} waiting for your OK in the Outbox`;
      else note = d.reason || 'No clients are a fit for this slot right now';
      setFillGapState(prev => ({ ...prev, [gap.id]: { done: true, note, held: d.held > 0 } }));
    } catch (err) {
      logger.error('fill-gap failed:', err);
      if (seq === request.current.seq) setFillGapState(prev => ({ ...prev, [gap.id]: { error: true, note: err.name === 'AbortError' ? 'The offer result could not be confirmed. Check Outbox before trying again.' : err.message || 'Could not check this slot. Refresh Schedule and try again.' } }));
    } finally { clearTimeout(killer); fillRequests.current.delete(gap.id); }
  }

  // Utilisation stats, over the hours that are still sellable: the rest of
  // today plus the next six days. Hours that have already gone by are not
  // capacity, so they can be neither booked nor open.
  const totalWorkMinutes = schedule?.workMinutes || 0;
  const totalGapMinutes = schedule?.openMinutes || 0;
  const bookedMins = schedule?.bookedMinutes || 0;
  const hasHours = totalWorkMinutes > 0;
  const utilisation = hasHours ? Math.round((bookedMins / totalWorkMinutes) * 100) : 0;
  const bookedHours = Number((bookedMins / 60).toFixed(1));
  const gapHours = (totalGapMinutes / 60).toFixed(1);
  const ratePence = useMemo(() => hourlyRatePence(treatments), [treatments]);
  const revenueAtRisk = ratePence == null ? null : Math.round((totalGapMinutes / 60) * (ratePence / 100));

  // Insights computed from real data
  const dayStats = useMemo(() => computeDayStats(allAppts), [allAppts]);
  const hardSlots = useMemo(() => {
    const hourBuckets = {};
    gaps.forEach(g => {
      const h = g.start?.split(':')[0];
      if (!h) return;
      if (!hourBuckets[h]) hourBuckets[h] = { mins: 0, count: 0, end: g.end };
      hourBuckets[h].mins += g.duration_minutes;
      hourBuckets[h].count++;
    });
    return Object.entries(hourBuckets)
      .sort((a, b) => b[1].mins - a[1].mins)
      .slice(0, 3)
      .map(([h, v]) => ({
        slot: `${h}:00`,
        note: `${v.mins}min open in the next 7 days`,
      }));
  }, [gaps]);

  const tip = useMemo(() => {
    if (dayStats.length === 0) return null;
    const quietest = [...dayStats].sort((a, b) => a.count - b.count)[0];
    const busiest = dayStats[0];
    if (!quietest || quietest.count === 0) return null;
    if (quietest.name === busiest.name) return null;
    return `Of the days with recorded visits in the last six months, ${quietest.name} had the fewest and ${busiest.name} the most.`;
  }, [dayStats]);

  if (profileLoading || loading) return <div style={styles.page}><div style={styles.header}><h1 style={styles.title}>Florrie's Schedule</h1></div><PageLoader /></div>;
  if (loadError) return <div style={styles.page}><div style={styles.header}><h1 style={styles.title}>Florrie's Schedule</h1></div><div style={styles.utilisationCard} role="alert"><p style={styles.utilisationEmpty}>{loadError}</p><Button variant="secondary" onClick={() => beautician ? loadData() : refreshProfile()}>Try again</Button><Button variant="quiet" onClick={() => navigate('/calendar/week')}>Open Calendar</Button></div></div>;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Florrie's Schedule</h1>
          <p style={styles.subtitle}>Open time over the next 7 days</p>
          <Button variant="quiet" size="sm" onClick={loadData}>Refresh schedule</Button>
        </div>
      </div>

      {/* Utilisation bar. "This week" means the hours left in it: today from
          now on, plus the next six days. */}
      <div style={styles.utilisationCard}>
        {hasHours ? (
          <>
            <div style={styles.utilisationHeader}>
              <span style={styles.utilisationLabel}>Next 7 days</span>
              <span style={styles.utilisationPct}>{utilisation}% booked</span>
            </div>
            <div style={styles.utilisationBar}>
              <div style={{ ...styles.utilisationFill, width: `${utilisation}%` }} />
            </div>
            <div style={styles.utilisationStats}>
              <span style={styles.utilisationStat}>{bookedHours}h booked</span>
              <span style={styles.utilisationStat}>{gapHours}h open</span>
              <span style={styles.utilisationStat}>{Number(((schedule?.blockedMinutes || 0) / 60).toFixed(1))}h blocked</span>
            </div>
          </>
        ) : (
          <>
            <div style={styles.utilisationHeader}>
              <span style={styles.utilisationLabel}>Next 7 days</span>
            </div>
            <p style={styles.utilisationEmpty}>
              {schedule?.hasConfiguredHours ? 'No available working time remains in this range after blocked time.' : 'Set your working hours to find available time.'}
            </p>
            <Button variant="secondary" size="sm" onClick={() => navigate('/settings?section=hours')}>
              Set your hours
            </Button>
          </>
        )}
      </div>

      {copyError && <div style={styles.utilisationCard} role="alert"><p style={styles.utilisationEmpty}>{copyError}</p>{slug && <a href={`https://florrie.ai/book/${encodeURIComponent(slug)}`} style={styles.fillSecondaryBtn}>Open booking page</a>}</div>}
      {copied && <p style={styles.suggEmpty} role="status">Booking link copied</p>}
      {/* Tabs */}
      <div style={styles.tabs}>
        {['gaps', 'suggestions', 'insights'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...styles.tab,
              borderBottomColor: tab === t ? 'var(--accent, #92405e)' : 'transparent',
              color: tab === t ? 'var(--accent, #92405e)' : 'var(--text-muted, #6B5D54)',
            }}
          >
            {t === 'gaps' ? 'Gaps' : t === 'suggestions' ? 'Fill Ideas' : 'Insights'}
          </button>
        ))}
      </div>

      {/* === GAPS TAB === */}
      {tab === 'gaps' && (
        <div>
          {loading ? (
            <PageLoader />
          ) : gaps.length === 0 ? (
            <EmptyState icon="sparkles" title="No bookable gaps found" subtitle="There are no open stretches of at least 15 minutes in the next 7 days. Check Calendar or your working hours for details." />
          ) : (
            <div style={styles.gapList}>
              {gaps.map(gap => {
                // Plain English: say what actually fits in the gap, from her
                // real treatment durations, not a vague Easy/Possible/Tough.
                const fit = gap.fitTotal === 0
                  ? { label: 'Add treatment lengths', color: 'var(--text-muted, #6B5D54)', bg: 'var(--bg-subtle, #ede7e3)' }
                  : gap.fitCount === gap.fitTotal
                  ? { label: 'Any treatment fits', color: '#306F33', bg: '#E8F5E9' }
                  : gap.fitCount > 0
                  ? { label: `${gap.fitCount} treatment${gap.fitCount === 1 ? '' : 's'} fit${gap.fitCount === 1 ? 's' : ''}`, color: '#8f5500', bg: '#FFF3E0' }
                  : { label: 'Too short to book', color: 'var(--text-muted, #6B5D54)', bg: 'var(--bg-subtle, #ede7e3)' };
                const fgs = fillGapState[gap.id] || {};
                const gapSuggestions = suggestionsForGap(suggestions, gap);
                const suggestionCount = gapSuggestions.rebook_due.length + gapSuggestions.waitlist_match.length;
                return (
                  <div key={gap.id} style={styles.gapCard}>
                    <Button variant="quiet" type="button" aria-expanded={selectedGap?.id === gap.id} aria-label={`${gap.dayLabel}, ${gap.start} to ${gap.end}`} onClick={() => setSelectedGap(selectedGap?.id === gap.id ? null : gap)} style={{ ...styles.gapHeader, border: 0, background: 'transparent', width: '100%', padding: 0, textAlign: 'left', cursor: 'pointer', flexWrap: 'wrap', gap: 8 }}>
                      <div style={styles.gapTime}>
                        <span style={styles.gapDay}>{gap.dayLabel}</span>
                        <span style={styles.gapSlot}>{gap.start} to {gap.end}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={styles.gapDuration}>{gap.duration_minutes}min</span>
                        <span style={{ ...styles.fillBadge, background: fit.bg, color: fit.color }}>
                          {fit.label}
                        </span>
                      </div>
                    </Button>

                    {suggestionCount > 0 && (
                      <span style={styles.gapSuggestHint}>
                        {suggestionCount} idea{suggestionCount > 1 ? 's' : ''} to fill it, tap to see
                      </span>
                    )}

                    {/* Expanded suggestions */}
                    {selectedGap?.id === gap.id && (
                      <div style={styles.gapExpanded}>
                        {/* One tap: Florrie offers this slot to matched clients,
                            through the outbound guard (Outbox approval). */}
                        {fgs.error && <p style={styles.utilisationEmpty} role="alert">{fgs.note}<Button variant="quiet" size="sm" onClick={loadData}>Refresh schedule</Button></p>}
                        {fgs.done ? (
                          <div style={{ padding: '10px 12px', borderRadius: 10, background: fgs.held ? '#FDF8EE' : 'var(--bg-subtle, #ede7e3)', fontSize: 13, color: 'var(--text-secondary, #574A42)', marginBottom: 8 }}>
                            {fgs.note}
                            {fgs.held && (
                              <button
                                onClick={e => { e.stopPropagation(); navigate('/outbox'); }}
                                style={{ ...styles.fillSecondaryBtn, marginTop: 8 }}
                              >
                                Review in Outbox
                              </button>
                            )}
                          </div>
                        ) : (
                          <button
                            onClick={e => { e.stopPropagation(); handleFillGap(gap); }}
                            disabled={!!fgs.busy || gap.fitCount === 0}
                            style={{ ...styles.offerBtn, opacity: fgs.busy ? 0.6 : 1, marginBottom: 8 }}
                          >
                            {fgs.busy ? 'Finding who to offer it to...' : 'Offer this gap to matching clients'}
                          </button>
                        )}
                        {/* Rebook due */}
                        {gapSuggestions.rebook_due.slice(0, gap.fillability === 'high' ? 2 : 1).map((s, i) => (
                          <div key={`rb-${i}`} style={styles.suggestionCard}>
                            <div style={styles.suggestionTop}>
                              <div style={styles.suggAvatar}>{s.client.first_name[0]}</div>
                              <div style={styles.suggInfo}>
                                <span style={styles.suggName}>{s.client.first_name} {s.client.last_name}</span>
                                <span style={styles.suggReason}>{s.reason}</span>
                              </div>
                            </div>
                            <div style={styles.suggTreatment}>
                              <span style={styles.suggTreatLabel}>{s.treatment.name}</span>
                              <span style={styles.suggTreatDur}>{s.treatment.duration_minutes}min · <Money pence={s.treatment.price_cents} /></span>
                            </div>
                            <button
                              onClick={e => { e.stopPropagation(); navigate(`/inbox?client=${s.client.id}`); }}
                              style={styles.fillSecondaryBtn}
                            >
                              Message her instead
                            </button>
                          </div>
                        ))}

                        {/* Waitlist match */}
                        {gapSuggestions.waitlist_match.length > 0 && gap.fillability !== 'low' && (
                          <div style={styles.suggestionCard}>
                            <div style={styles.suggestionTop}>
                              <div style={{ ...styles.suggAvatar, background: '#E3F2FD' }}>
                                <span style={{ color: '#1976D2' }}>{gapSuggestions.waitlist_match[0].client.first_name[0]}</span>
                              </div>
                              <div style={styles.suggInfo}>
                                <span style={styles.suggName}>{gapSuggestions.waitlist_match[0].client.first_name} {gapSuggestions.waitlist_match[0].client.last_name}</span>
                                <span style={styles.suggReason}>{gapSuggestions.waitlist_match[0].reason || 'Waiting for an opening'}</span>
                              </div>
                            </div>
                            <button
                              onClick={e => { e.stopPropagation(); navigate(`/inbox?client=${gapSuggestions.waitlist_match[0].client.id}`); }}
                              style={styles.fillSecondaryBtn}
                            >
                              Message her instead
                            </button>
                          </div>
                        )}

                        {ideasLoading && <p style={styles.suggEmpty} role="status">Checking client ideas…</p>}
                        {ideasError && <p style={styles.suggEmpty} role="alert">{ideasError}</p>}
                        {/* No matching suggestion */}
                        {!ideasLoading && !ideasError && gapSuggestions.rebook_due.slice(0, gap.fillability === 'high' ? 2 : 1).length === 0 &&
                          !(gapSuggestions.waitlist_match.length > 0 && gap.fillability !== 'low') && (
                          <FillFallback compact />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab !== 'gaps' && ideasLoading && <p style={styles.loadingText} role="status">Checking client ideas and recent history…</p>}
      {tab !== 'gaps' && ideasError && <div role="alert" style={styles.utilisationCard}><p style={styles.utilisationEmpty}>{ideasError}</p><Button variant="secondary" onClick={loadData}>Try again</Button></div>}
      {/* === SUGGESTIONS TAB === */}
      {tab === 'suggestions' && !ideasLoading && !ideasError && (
        <div>
          {suggestions.rebook_due.length === 0 &&
           suggestions.dormant_rescue.length === 0 &&
           suggestions.waitlist_match.length === 0 && (
            <div style={styles.fillHeroCard}>
              <span style={styles.fillHeroTitle}>No client ideas to show</span>
              <p style={styles.fillHeroText}>
                These ideas use completed visits from the last six months and current waitlist matches. You can also share {gaps.length > 0 ? `your ${gaps.length} open gap${gaps.length > 1 ? 's' : ''}` : 'your availability'}.
              </p>
              <button style={styles.offerBtn} onClick={() => navigate('/content')}>Post your availability</button>
              <button style={styles.fillSecondaryBtn} onClick={copyBookingLink}>
                {copied ? 'Booking link copied' : (slug ? 'Copy booking link' : 'Set up booking link')}
              </button>
            </div>
          )}
          <div style={styles.suggSection}>
            <h3 style={styles.suggSectionTitle}><Icon name="refresh" size={14} inline /> Rebook ideas</h3>
            <p style={styles.suggSectionDesc}>Possible follow-ups based on their previous visit intervals</p>
            {suggestions.rebook_due.map((s, i) => (
              <div key={`rb-${i}`} style={styles.suggFullCard}>
                <div style={styles.suggestionTop}>
                  <div style={styles.suggAvatar}>{s.client.first_name[0]}</div>
                  <div style={styles.suggInfo}>
                    <span style={styles.suggName}>{s.client.first_name} {s.client.last_name}</span>
                    <span style={styles.suggDetail}>{s.treatment.name}</span>
                  </div>
                  <span style={styles.overdueBadge}>{s.days_overdue}d past usual</span>
                </div>
                <p style={styles.suggReasonText}>{s.reason}</p>
                <button
                  onClick={() => navigate(`/inbox?client=${s.client.id}`)}
                  style={styles.offerBtn}
                >
                  Message her
                </button>
              </div>
            ))}
            {suggestions.rebook_due.length === 0 && (
              <p style={styles.suggEmpty}>No rebook ideas in the completed history checked.</p>
            )}
          </div>

          <div style={styles.suggSection}>
            <h3 style={styles.suggSectionTitle}><Icon name="moon" size={14} inline /> Clients to reconnect with</h3>
            <p style={styles.suggSectionDesc}>Clients whose last recorded visit was at least 60 days ago</p>
            {suggestions.dormant_rescue.map((s, i) => (
              <div key={`dr-${i}`} style={styles.suggFullCard}>
                <div style={styles.suggestionTop}>
                  <div style={{ ...styles.suggAvatar, background: '#FFF3E0' }}>
                    <span style={{ color: '#B33F00' }}>{s.client.first_name[0]}</span>
                  </div>
                  <div style={styles.suggInfo}>
                    <span style={styles.suggName}>{s.client.first_name} {s.client.last_name}</span>
                    <span style={styles.suggDetail}>{s.treatment.name}</span>
                  </div>
                  <span style={{ ...styles.overdueBadge, background: '#FFF3E0', color: '#B33F00' }}>{s.last_visit_days}d ago</span>
                </div>
                <p style={styles.suggReasonText}>{s.reason}</p>
                <button
                  onClick={() => navigate(`/inbox?client=${s.client.id}`)}
                  style={styles.offerBtn}
                >
                  Message her
                </button>
              </div>
            ))}
            {suggestions.dormant_rescue.length === 0 && (
              <p style={styles.suggEmpty}>No reconnection ideas in the completed history checked.</p>
            )}
          </div>

          <div style={styles.suggSection}>
            <h3 style={styles.suggSectionTitle}><Icon name="list" size={14} inline /> Waitlist ready</h3>
            <p style={styles.suggSectionDesc}>Clients waiting for a slot that matches</p>
            {suggestions.waitlist_match.map((s, i) => (
              <div key={`wl-${i}`} style={styles.suggFullCard}>
                <div style={styles.suggestionTop}>
                  <div style={{ ...styles.suggAvatar, background: '#E3F2FD' }}>
                    <span style={{ color: '#1976D2' }}>{s.client.first_name[0]}</span>
                  </div>
                  <div style={styles.suggInfo}>
                    <span style={styles.suggName}>{s.client.first_name} {s.client.last_name}</span>
                    <span style={styles.suggDetail}>{s.reason || 'Waiting for an opening'}</span>
                  </div>
                </div>
                <p style={styles.suggReasonText}>{s.treatment.name}, {s.treatment.duration_minutes}min</p>
              </div>
            ))}
            {suggestions.waitlist_match.length === 0 && (
              <p style={styles.suggEmpty}>No matching waitlist ideas for these openings.</p>
            )}
          </div>
        </div>
      )}

      {/* === INSIGHTS TAB === */}
      {tab === 'insights' && !ideasLoading && !ideasError && (
        <div>
          <div style={styles.insightGrid}>
            <div style={styles.insightCard}>
              <span style={styles.insightNum}>{utilisation}%</span>
              <span style={styles.insightLabel}>Utilisation</span>
            </div>
            <div style={styles.insightCard}>
              <span style={styles.insightNum}>{gaps.length}</span>
              <span style={styles.insightLabel}>Open gaps</span>
            </div>
            <div style={styles.insightCard}>
              <span style={styles.insightNum}>{gapHours}h</span>
              <span style={styles.insightLabel}>Empty hours</span>
            </div>
            {/* Was gap hours times a hardcoded £35, which was nobody's price.
                Now it is an hour of her own price list, and if she has not
                priced anything yet it says so rather than making one up. */}
            {revenueAtRisk == null ? (
              <div
                style={{ ...styles.insightCard, cursor: 'pointer' }}
                onClick={() => navigate('/treatments')}
                role="button"
              >
                <span style={styles.insightPrompt}>Add your prices</span>
                <span style={styles.insightLabel}>To see potential appointment value</span>
              </div>
            ) : (
              <div style={styles.insightCard}>
                <span style={styles.insightNum}>£{revenueAtRisk}</span>
                <span style={styles.insightLabel}>Potential appointment value</span>
              </div>
            )}
          </div>

          <div style={styles.insightSection}>
            <h3 style={styles.insightSectionTitle}>Recorded visits by day</h3><p style={styles.suggSectionDesc}>Completed visits in the last six months. Potential value uses your current price list; it is not guaranteed income.</p>
            {dayStats.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>No appointment history yet.</p>
            ) : dayStats.map(day => (
              <div key={day.name} style={styles.dayRow}>
                <span style={styles.dayName}>{day.name}</span>
                <div style={styles.dayBar}>
                  <div style={{ ...styles.dayBarFill, width: `${day.pct}%`, background: day.pct > 85 ? '#306F33' : day.pct > 60 ? '#FF9800' : '#E57373' }} />
                </div>
                <span style={styles.dayPct}>{day.count}</span>
              </div>
            ))}
          </div>

          <div style={styles.insightSection}>
            <h3 style={styles.insightSectionTitle}>Open time by start hour</h3>
            {hardSlots.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>No open stretches of at least 15 minutes in this range.</p>
            ) : (
              <div style={styles.hardSlotList}>
                {hardSlots.map(s => (
                  <div key={s.slot} style={styles.hardSlot}>
                    <span style={styles.hardSlotText}>{s.slot}</span>
                    <span style={styles.hardSlotNote}>{s.note}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {tip && (
            <div style={styles.tipCard}>
              <span style={{ fontSize: 16, marginRight: 8 }}><Icon name="info" size={15} /></span>
              <div>
                <span style={styles.tipTitle}>Florrie's suggestion</span>
                <span style={styles.tipText}>{tip}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: 'var(--shell-viewport)', background: 'var(--bg, var(--bg, #FBF6F1))',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
    padding: '0 16px var(--scroll-pad-bottom)', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary, #241B17)',
  },
  header: { paddingTop: 8, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent, #92405e)', margin: 0, fontWeight: 500 },

  // Utilisation
  utilisationCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16,
    boxShadow: 'var(--elev-1)', marginBottom: 16,
  },
  utilisationHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  utilisationLabel: { fontSize: 12, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  utilisationPct: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  utilisationBar: {
    height: 8, borderRadius: 'var(--radius-xs)', background: '#F0ECE8', overflow: 'hidden', marginBottom: 8,
  },
  utilisationFill: {
    height: '100%', borderRadius: 'var(--radius-xs)',
    background: 'linear-gradient(90deg, #B9466D, #C9315D)',
    transition: 'width 0.6s ease',
  },
  utilisationStats: { display: 'flex', justifyContent: 'space-between' },
  utilisationStat: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  utilisationEmpty: { fontSize: 13, color: 'var(--text-secondary, #574A42)', margin: '6px 0 10px', lineHeight: 1.45 },

  tabs: { display: 'flex', gap: 16, borderBottom: '1px solid #F0ECE8', marginBottom: 16 },
  tab: {
    padding: '10px 0', background: 'none', border: 'none',
    borderBottom: '2px solid transparent', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Gap cards
  gapList: { display: 'flex', flexDirection: 'column', gap: 10 },
  gapCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 14,
    boxShadow: 'var(--elev-1)', cursor: 'pointer',
    transition: 'box-shadow 0.2s',
  },
  gapHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  gapTime: { display: 'flex', flexDirection: 'column', gap: 2 },
  gapDay: { fontSize: 12, fontWeight: 600, color: 'var(--accent, #92405e)' },
  gapSlot: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  gapDuration: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  fillBadge: {
    padding: '4px 10px', borderRadius: 'var(--radius-xs)', fontSize: 11, fontWeight: 600,
  },
  gapSuggestHint: { fontSize: 12, color: '#6b6560', marginTop: 8, display: 'block' },

  // Expanded gap suggestions
  gapExpanded: {
    marginTop: 12, paddingTop: 12, borderTop: '1px solid #F5F2EF',
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  suggestionCard: {
    background: 'var(--bg, var(--bg, #FBF6F1))', borderRadius: 10, padding: 12,
  },
  suggestionTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  suggAvatar: {
    width: 34, height: 34, borderRadius: 16, background: '#FBF0F3',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14, fontWeight: 600, color: 'var(--accent, #92405e)', flexShrink: 0,
  },
  suggInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  suggName: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  suggReason: { fontSize: 11, color: '#6b6560', lineHeight: 1.3 },
  suggDetail: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  suggTreatment: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '6px 0', marginBottom: 6,
  },
  suggTreatLabel: { fontSize: 12, fontWeight: 500, color: '#5A5550' },
  suggTreatDur: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  offerBtn: {
    width: '100%', padding: '8px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  sentBadge: {
    display: 'block', textAlign: 'center', padding: '8px 0',
    fontSize: 12, fontWeight: 600, color: '#306F33',
  },

  // Fill fallback (gap with nobody due) + Fill Ideas empty states
  fillFallback: {
    marginTop: 4, display: 'flex', flexDirection: 'column', gap: 8,
  },
  fillFallbackCompact: {
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  fillFallbackText: {
    fontSize: 12, color: '#6b6560', lineHeight: 1.45, margin: 0,
  },
  fillSecondaryBtn: {
    width: '100%', padding: '8px 0', borderRadius: 10,
    border: '1px solid var(--accent, #92405e)', background: 'transparent',
    color: 'var(--accent, #92405e)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  fillHeroCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16,
    boxShadow: 'var(--elev-1)', marginBottom: 20,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  fillHeroTitle: { fontSize: 15, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  fillHeroText: { fontSize: 12.5, color: '#6b6560', lineHeight: 1.5, margin: 0 },
  suggEmpty: {
    fontSize: 12.5, color: 'var(--text-muted, #6B5D54)', lineHeight: 1.4,
    margin: 0, padding: '4px 2px',
  },

  // Full suggestion cards
  suggSection: { marginBottom: 20 },
  suggSectionTitle: { fontSize: 15, fontWeight: 600, margin: '0 0 2px', color: 'var(--text-primary, #241B17)' },
  suggSectionDesc: { fontSize: 12, color: 'var(--text-muted, #6B5D54)', margin: '0 0 12px' },
  suggFullCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 14,
    boxShadow: 'var(--elev-1)', marginBottom: 10,
  },
  suggReasonText: { fontSize: 12, color: '#6b6560', margin: '8px 0', lineHeight: 1.4 },
  overdueBadge: {
    padding: '3px 8px', borderRadius: 'var(--radius-xs)', fontSize: 10, fontWeight: 600,
    background: '#FEF2F2', color: '#c32424', flexShrink: 0,
  },

  // Insights
  insightGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 },
  insightCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: '16px 14px', textAlign: 'center',
    boxShadow: 'var(--elev-1)',
  },
  insightNum: { display: 'block', fontSize: 22, fontWeight: 700, color: 'var(--accent, #92405e)' },
  insightPrompt: { display: 'block', fontSize: 15, fontWeight: 700, color: 'var(--accent, #92405e)', lineHeight: 1.3 },
  insightLabel: { display: 'block', fontSize: 11, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 4 },

  insightSection: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16, marginBottom: 12,
    boxShadow: 'var(--elev-1)',
  },
  insightSectionTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: 'var(--text-primary, #241B17)' },
  dayRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  dayName: { fontSize: 12, color: '#5A5550', width: 70, flexShrink: 0 },
  dayBar: { flex: 1, height: 6, borderRadius: 'var(--radius-xs)', background: '#F0ECE8', overflow: 'hidden' },
  dayBarFill: { height: '100%', borderRadius: 'var(--radius-xs)', transition: 'width 0.6s ease' },
  dayPct: { fontSize: 11, fontWeight: 600, color: 'var(--text-primary, #241B17)', width: 30, textAlign: 'right' },

  hardSlotList: { display: 'flex', flexDirection: 'column', gap: 8 },
  hardSlot: { display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 0', borderBottom: '1px solid #FAF8F5' },
  hardSlotText: { fontSize: 13, fontWeight: 600, color: '#E57373' },
  hardSlotNote: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },

  tipCard: {
    display: 'flex', alignItems: 'flex-start', gap: 4,
    background: '#FBF0F3', borderRadius: 16, padding: 14,
  },
  tipTitle: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--accent, #92405e)', marginBottom: 4 },
  tipText: { display: 'block', fontSize: 12, color: '#5A5550', lineHeight: 1.5 },

  // Empty
  loadingText: { textAlign: 'center', color: 'var(--text-muted, #6B5D54)', padding: 40, fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--text-primary, #241B17)' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted, #6B5D54)', margin: 0, lineHeight: 1.5 },
};
