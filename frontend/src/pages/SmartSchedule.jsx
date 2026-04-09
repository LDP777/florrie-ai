import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, isDevMode, supabase, DEV_CLIENTS, DEV_TREATMENTS } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Smart Schedule — Gap Finder & Fill Assistant.
 *
 * Scans the calendar for empty slots and suggests:
 *   1. Clients who are due for a rebook
 *   2. Waitlist matches for the gap
 *   3. One-tap message to offer the slot
 *
 * Three views:
 *   Gaps     — this week's empty slots ranked by fillability
 *   Suggest  — AI-powered fill suggestions per gap
 *   Insights — schedule utilisation stats
 */

// Generate mock gaps for this week
function generateDevGaps() {
  const gaps = [];
  const now = new Date();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const workingDays = { 1: { s: '11:00', e: '15:00' }, 2: { s: '11:00', e: '19:00' }, 3: { s: '11:00', e: '18:00' }, 4: { s: '11:00', e: '19:00' }, 5: { s: '10:00', e: '17:00' } };

  for (let i = 0; i < 7; i++) {
    const date = new Date(now);
    date.setDate(now.getDate() + i);
    const dow = date.getDay();
    if (!workingDays[dow]) continue;

    const dateStr = date.toISOString().split('T')[0];
    const dayLabel = dayNames[dow];
    const dayFull = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

    // Simulate some gaps
    if (i === 0) {
      gaps.push({ id: `gap-${i}-1`, date: dateStr, dayLabel: dayFull, start: '14:00', end: '15:00', duration_minutes: 60, fillability: 'high', suggestions: 2 });
    }
    if (i === 1) {
      gaps.push({ id: `gap-${i}-1`, date: dateStr, dayLabel: dayFull, start: '11:00', end: '13:00', duration_minutes: 120, fillability: 'medium', suggestions: 3 });
      gaps.push({ id: `gap-${i}-2`, date: dateStr, dayLabel: dayFull, start: '17:00', end: '19:00', duration_minutes: 120, fillability: 'low', suggestions: 1 });
    }
    if (i === 2) {
      gaps.push({ id: `gap-${i}-1`, date: dateStr, dayLabel: dayFull, start: '15:00', end: '18:00', duration_minutes: 180, fillability: 'high', suggestions: 4 });
    }
    if (i === 3) {
      gaps.push({ id: `gap-${i}-1`, date: dateStr, dayLabel: dayFull, start: '11:00', end: '12:00', duration_minutes: 60, fillability: 'medium', suggestions: 2 });
    }
  }
  return gaps;
}

const DEV_SUGGESTIONS = {
  rebook_due: [
    { client: DEV_CLIENTS[0], treatment: DEV_TREATMENTS[0], days_overdue: 5, reason: 'Lamination due — last visit 15 days ago, usually rebooks every 10 days' },
    { client: DEV_CLIENTS[1], treatment: DEV_TREATMENTS[1], days_overdue: 12, reason: 'Overdue for tint maintenance — normally comes every 3 weeks' },
  ],
  waitlist_match: [
    { client: { first_name: 'Megan', last_name: 'R' }, preferred_day: 'Tuesday', preferred_time: 'morning', treatment: DEV_TREATMENTS[2] },
  ],
  dormant_rescue: [
    { client: DEV_CLIENTS[2], last_visit_days: 38, treatment: DEV_TREATMENTS[4], reason: "Hasn't been in 5+ weeks — send a 'miss you' offer?" },
  ],
};

const FILLABILITY = {
  high: { label: 'Easy fill', color: '#4CAF50', bg: '#E8F5E9' },
  medium: { label: 'Possible', color: '#FF9800', bg: '#FFF3E0' },
  low: { label: 'Tough', color: '#E57373', bg: '#FEF2F2' },
};

// ── Compute fill suggestions from real client data ──────────
function computeSuggestions(clients, treatments) {
  const now = new Date();
  const rebook_due = [];
  const dormant_rescue = [];

  (clients || []).forEach(c => {
    const appts = (c.appointments || [])
      .map(a => ({ date: new Date(a.created_at || a.start_time), treatment: a.treatment_name, price: a.price_cents }))
      .filter(a => !isNaN(a.date))
      .sort((a, b) => b.date - a.date);

    if (appts.length === 0) return;
    const daysSince = Math.floor((now - appts[0].date) / 86400000);

    // Compute average interval
    let avgInterval = 28;
    if (appts.length >= 2) {
      const intervals = [];
      for (let i = 0; i < appts.length - 1; i++) {
        intervals.push(Math.floor((appts[i].date - appts[i + 1].date) / 86400000));
      }
      avgInterval = Math.round(intervals.reduce((s, v) => s + v, 0) / intervals.length) || 28;
    }

    const lastTreatment = appts[0]?.treatment || 'Treatment';
    const matchingTreatment = (treatments || []).find(t => t.name === lastTreatment) || { name: lastTreatment, duration_minutes: 45, price_cents: appts[0]?.price || 3000 };
    const clientObj = { id: c.id, first_name: c.first_name || '', last_name: c.last_name || '' };

    if (daysSince >= 60) {
      dormant_rescue.push({
        client: clientObj,
        last_visit_days: daysSince,
        treatment: matchingTreatment,
        reason: `Hasn't been in ${daysSince} days — send a comeback offer?`,
      });
    } else if (daysSince > avgInterval) {
      rebook_due.push({
        client: clientObj,
        treatment: matchingTreatment,
        days_overdue: daysSince - avgInterval,
        reason: `${lastTreatment} overdue by ${daysSince - avgInterval} days — usually rebooks every ${avgInterval} days`,
      });
    }
  });

  return {
    rebook_due: rebook_due.sort((a, b) => b.days_overdue - a.days_overdue).slice(0, 5),
    waitlist_match: [], // Would need a waitlist table
    dormant_rescue: dormant_rescue.sort((a, b) => b.last_visit_days - a.last_visit_days).slice(0, 5),
  };
}

export default function SmartSchedule() {
  const { beautician } = useBeautician();
  const [gaps, setGaps] = useState([]);
  const [suggestions, setSuggestions] = useState(DEV_SUGGESTIONS);
  const [tab, setTab] = useState('gaps');
  const [loading, setLoading] = useState(true);
  const [selectedGap, setSelectedGap] = useState(null);
  const [messageSent, setMessageSent] = useState({});

  useEffect(() => {
    loadData();
  }, [beautician]);

  async function loadData() {
    setLoading(true);
    if (isDevMode) {
      setGaps(generateDevGaps());
      setSuggestions(DEV_SUGGESTIONS);
      setLoading(false);
      return;
    }
    if (!beautician) {
      setLoading(false);
      return;
    }
    const now = new Date();
    const weekEnd = new Date(now);
    weekEnd.setDate(now.getDate() + 7);
    const startStr = now.toISOString().slice(0, 10);
    const endStr = weekEnd.toISOString().slice(0, 10);

    try {
      const appts = await fetchRows('appointments', beautician.id, {
        order: 'start_time',
        ascending: true,
      });

      const thisWeekAppts = appts.filter(a =>
        a.start_time && a.start_time.slice(0, 10) >= startStr && a.start_time.slice(0, 10) <= endStr
      );

      const computedGaps = computeGapsFromAppointments(thisWeekAppts, beautician.working_hours);
      setGaps(computedGaps);

      // Fetch clients for fill suggestions
      const { data: clients } = await supabase
        ? supabase.from('clients').select('*, appointments(created_at, treatment_name, price_cents, start_time)').eq('beautician_id', beautician.id)
        : { data: null };
      const treatments = await fetchRows('treatments', beautician.id);
      if (clients) {
        setSuggestions(computeSuggestions(clients, treatments));
      }
    } catch (err) {
      logger.error('Failed to load appointments:', err);
      setGaps([]);
    } finally {
      setLoading(false);
    }
  }

  // Helper to compute gaps from real appointments and working hours
  function computeGapsFromAppointments(appts, workingHours) {
    const gaps = [];
    const now = new Date();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const workingDaysMap = { 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 0: 'sun', 6: 'sat' };

    for (let i = 0; i < 7; i++) {
      const date = new Date(now);
      date.setDate(now.getDate() + i);
      const dow = date.getDay();
      const dayKey = workingDaysMap[dow];
      const dayHours = workingHours?.[dayKey];
      if (!dayHours) continue;

      const dateStr = date.toISOString().split('T')[0];
      const dayLabel = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const [startH, startM] = dayHours.start.split(':').map(Number);
      const [endH, endM] = dayHours.end.split(':').map(Number);
      const dayStartMins = startH * 60 + startM;
      const dayEndMins = endH * 60 + endM;

      const dayAppts = appts
        .filter(a => a.start_time?.slice(0, 10) === dateStr)
        .map(a => {
          const [h, m] = a.start_time?.slice(11, 16).split(':').map(Number) || [0, 0];
          return { start: h * 60 + m, duration: a.duration_minutes || 0 };
        })
        .sort((a, b) => a.start - b.start);

      // Build gaps
      let currentTime = dayStartMins;
      dayAppts.forEach(appt => {
        if (appt.start > currentTime) {
          gaps.push({
            id: `gap-${dateStr}-${currentTime}`,
            date: dateStr,
            dayLabel,
            start: `${String(Math.floor(currentTime / 60)).padStart(2, '0')}:${String(currentTime % 60).padStart(2, '0')}`,
            end: `${String(Math.floor(appt.start / 60)).padStart(2, '0')}:${String(appt.start % 60).padStart(2, '0')}`,
            duration_minutes: appt.start - currentTime,
            fillability: appt.start - currentTime >= 60 ? 'high' : 'medium',
            suggestions: Math.floor(Math.random() * 3) + 1,
          });
        }
        currentTime = appt.start + appt.duration;
      });

      // Closing gap
      if (currentTime < dayEndMins) {
        gaps.push({
          id: `gap-${dateStr}-${currentTime}`,
          date: dateStr,
          dayLabel,
          start: `${String(Math.floor(currentTime / 60)).padStart(2, '0')}:${String(currentTime % 60).padStart(2, '0')}`,
          end: `${String(Math.floor(dayEndMins / 60)).padStart(2, '0')}:${String(dayEndMins % 60).padStart(2, '0')}`,
          duration_minutes: dayEndMins - currentTime,
          fillability: dayEndMins - currentTime >= 90 ? 'high' : 'low',
          suggestions: 1,
        });
      }
    }

    return gaps;
  }

  async function handleSendOffer(suggestion, context) {
    // context is either a gap object (has .start, .end, .date, .id) or a string ('sugg' | 'dormant')
    const isGapContext = context && typeof context === 'object';
    const key = `${suggestion.client.first_name}-${isGapContext ? context.id : context}`;

    // Optimistically mark sent so button doesn't double-fire
    setMessageSent(prev => ({ ...prev, [key]: true }));

    if (!suggestion.client.id) {
      // Dev mode or waitlist entry with no real ID — nothing to send
      return;
    }

    try {
      let message;
      if (isGapContext) {
        // Slot offer — "I have a slot free on X at Y, want it?"
        const day = context.dayLabel || context.date;
        message = `Hi ${suggestion.client.first_name}! I have a ${context.duration_minutes}-min slot free on ${day} at ${context.start}${suggestion.treatment?.name ? ` — perfect for your ${suggestion.treatment.name}` : ''}. Want to grab it? Just reply YES and I'll book you in 💕`;
      } else if (context === 'dormant') {
        message = `Hi ${suggestion.client.first_name}! It's been a while and we miss you 💕 We have some slots coming up — want to come back in for your ${suggestion.treatment?.name || 'treatment'}?`;
      } else {
        // 'sugg' — rebook nudge
        message = `Hi ${suggestion.client.first_name}! Just a little nudge — your ${suggestion.treatment?.name || 'appointment'} is due! Would you like to book in? Just reply and I'll sort a time for you 🌸`;
      }

      const token = (await supabase?.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/notifications/send-sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ client_id: suggestion.client.id, message }),
      });

      if (!res.ok) {
        logger.error('send-sms failed', await res.text());
        // Revert optimistic update on failure
        setMessageSent(prev => ({ ...prev, [key]: false }));
      }
    } catch (err) {
      logger.error('handleSendOffer error:', err);
      setMessageSent(prev => ({ ...prev, [key]: false }));
    }
  }

  // Utilisation stats
  const totalWorkMinutes = 5 * 8 * 60; // rough: 5 days × 8 hours
  const totalGapMinutes = gaps.reduce((sum, g) => sum + g.duration_minutes, 0);
  const utilisation = totalWorkMinutes > 0 ? Math.round(((totalWorkMinutes - totalGapMinutes) / totalWorkMinutes) * 100) : 100;
  const bookedHours = Math.round((totalWorkMinutes - totalGapMinutes) / 60);
  const gapHours = (totalGapMinutes / 60).toFixed(1);

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Florrie's Schedule</h1>
          <p style={styles.subtitle}>Fill gaps, maximise your week</p>
        </div>
      </div>

      {/* Utilisation bar */}
      <div style={styles.utilisationCard}>
        <div style={styles.utilisationHeader}>
          <span style={styles.utilisationLabel}>This week</span>
          <span style={styles.utilisationPct}>{utilisation}% booked</span>
        </div>
        <div style={styles.utilisationBar}>
          <div style={{ ...styles.utilisationFill, width: `${utilisation}%` }} />
        </div>
        <div style={styles.utilisationStats}>
          <span style={styles.utilisationStat}>{bookedHours}h booked</span>
          <span style={styles.utilisationStat}>{gapHours}h open</span>
          <span style={styles.utilisationStat}>{gaps.length} gaps</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        {['gaps', 'suggestions', 'insights'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              ...styles.tab,
              borderBottomColor: tab === t ? 'var(--accent, #C76B8A)' : 'transparent',
              color: tab === t ? 'var(--accent, #C76B8A)' : 'var(--text-muted, #7a7470)',
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
            <EmptyState icon="🎉" title="Fully booked!" subtitle="No gaps this week. You're crushing it." />
          ) : (
            <div style={styles.gapList}>
              {gaps.map(gap => {
                const fill = FILLABILITY[gap.fillability];
                return (
                  <div key={gap.id} style={styles.gapCard} onClick={() => setSelectedGap(selectedGap?.id === gap.id ? null : gap)}>
                    <div style={styles.gapHeader}>
                      <div style={styles.gapTime}>
                        <span style={styles.gapDay}>{gap.dayLabel}</span>
                        <span style={styles.gapSlot}>{gap.start} — {gap.end}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={styles.gapDuration}>{gap.duration_minutes}min</span>
                        <span style={{ ...styles.fillBadge, background: fill.bg, color: fill.color }}>
                          {fill.label}
                        </span>
                      </div>
                    </div>

                    {gap.suggestions > 0 && (
                      <span style={styles.gapSuggestHint}>
                        {gap.suggestions} client{gap.suggestions > 1 ? 's' : ''} could fill this
                      </span>
                    )}

                    {/* Expanded suggestions */}
                    {selectedGap?.id === gap.id && (
                      <div style={styles.gapExpanded}>
                        {/* Rebook due */}
                        {suggestions.rebook_due.slice(0, gap.fillability === 'high' ? 2 : 1).map((s, i) => (
                          <div key={`rb-${i}`} style={styles.suggestionCard}>
                            <div style={styles.suggestionTop}>
                              <div style={styles.suggAvatar}>{s.client.first_name[0]}</div>
                              <div style={styles.suggInfo}>
                                <span style={styles.suggName}>{s.client.first_name}</span>
                                <span style={styles.suggReason}>{s.reason}</span>
                              </div>
                            </div>
                            <div style={styles.suggTreatment}>
                              <span style={styles.suggTreatLabel}>{s.treatment.name}</span>
                              <span style={styles.suggTreatDur}>{s.treatment.duration_minutes}min · £{(s.treatment.price_cents / 100).toFixed(2)}</span>
                            </div>
                            {messageSent[`${s.client.first_name}-${gap.id}`] ? (
                              <span style={styles.sentBadge}>Sent ✓</span>
                            ) : (
                              <button
                                onClick={e => { e.stopPropagation(); handleSendOffer(s, gap); }}
                                style={styles.offerBtn}
                              >
                                Offer this slot
                              </button>
                            )}
                          </div>
                        ))}

                        {/* Waitlist match */}
                        {suggestions.waitlist_match.length > 0 && gap.fillability !== 'low' && (
                          <div style={styles.suggestionCard}>
                            <div style={styles.suggestionTop}>
                              <div style={{ ...styles.suggAvatar, background: '#E3F2FD' }}>
                                <span style={{ color: '#1976D2' }}>{suggestions.waitlist_match[0].client.first_name[0]}</span>
                              </div>
                              <div style={styles.suggInfo}>
                                <span style={styles.suggName}>{suggestions.waitlist_match[0].client.first_name} {suggestions.waitlist_match[0].client.last_name}</span>
                                <span style={styles.suggReason}>On waitlist — wants {suggestions.waitlist_match[0].preferred_day} {suggestions.waitlist_match[0].preferred_time}</span>
                              </div>
                            </div>
                            {messageSent[`${suggestions.waitlist_match[0].client.first_name}-${gap.id}`] ? (
                              <span style={styles.sentBadge}>Sent ✓</span>
                            ) : (
                              <button
                                onClick={e => { e.stopPropagation(); handleSendOffer(suggestions.waitlist_match[0], gap); }}
                                style={styles.offerBtn}
                              >
                                Offer this slot
                              </button>
                            )}
                          </div>
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

      {/* === SUGGESTIONS TAB === */}
      {tab === 'suggestions' && (
        <div>
          <div style={styles.suggSection}>
            <h3 style={styles.suggSectionTitle}>🔄 Rebook due</h3>
            <p style={styles.suggSectionDesc}>Clients overdue for their regular appointment</p>
            {suggestions.rebook_due.map((s, i) => (
              <div key={`rb-${i}`} style={styles.suggFullCard}>
                <div style={styles.suggestionTop}>
                  <div style={styles.suggAvatar}>{s.client.first_name[0]}</div>
                  <div style={styles.suggInfo}>
                    <span style={styles.suggName}>{s.client.first_name}</span>
                    <span style={styles.suggDetail}>{s.treatment.name}</span>
                  </div>
                  <span style={styles.overdueBadge}>{s.days_overdue}d overdue</span>
                </div>
                <p style={styles.suggReasonText}>{s.reason}</p>
                <button
                  onClick={() => handleSendOffer(s, 'sugg')}
                  style={styles.offerBtn}
                >
                  {messageSent[`${s.client.first_name}-sugg`] ? 'Sent ✓' : 'Send rebook nudge'}
                </button>
              </div>
            ))}
          </div>

          <div style={styles.suggSection}>
            <h3 style={styles.suggSectionTitle}>💤 Dormant rescue</h3>
            <p style={styles.suggSectionDesc}>Clients going cold — win them back</p>
            {suggestions.dormant_rescue.map((s, i) => (
              <div key={`dr-${i}`} style={styles.suggFullCard}>
                <div style={styles.suggestionTop}>
                  <div style={{ ...styles.suggAvatar, background: '#FFF3E0' }}>
                    <span style={{ color: '#E65100' }}>{s.client.first_name[0]}</span>
                  </div>
                  <div style={styles.suggInfo}>
                    <span style={styles.suggName}>{s.client.first_name}</span>
                    <span style={styles.suggDetail}>{s.treatment.name}</span>
                  </div>
                  <span style={{ ...styles.overdueBadge, background: '#FFF3E0', color: '#E65100' }}>{s.last_visit_days}d ago</span>
                </div>
                <p style={styles.suggReasonText}>{s.reason}</p>
                <button
                  onClick={() => handleSendOffer(s, 'dormant')}
                  style={styles.offerBtn}
                >
                  {messageSent[`${s.client.first_name}-dormant`] ? 'Sent ✓' : 'Send rescue offer'}
                </button>
              </div>
            ))}
          </div>

          <div style={styles.suggSection}>
            <h3 style={styles.suggSectionTitle}>📋 Waitlist ready</h3>
            <p style={styles.suggSectionDesc}>Clients waiting for a slot that matches</p>
            {suggestions.waitlist_match.map((s, i) => (
              <div key={`wl-${i}`} style={styles.suggFullCard}>
                <div style={styles.suggestionTop}>
                  <div style={{ ...styles.suggAvatar, background: '#E3F2FD' }}>
                    <span style={{ color: '#1976D2' }}>{s.client.first_name[0]}</span>
                  </div>
                  <div style={styles.suggInfo}>
                    <span style={styles.suggName}>{s.client.first_name} {s.client.last_name}</span>
                    <span style={styles.suggDetail}>Wants {s.preferred_day} {s.preferred_time}</span>
                  </div>
                </div>
                <p style={styles.suggReasonText}>{s.treatment.name} — {s.treatment.duration_minutes}min</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* === INSIGHTS TAB === */}
      {tab === 'insights' && (
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
            <div style={styles.insightCard}>
              <span style={styles.insightNum}>£{Math.round(totalGapMinutes / 60 * 35)}</span>
              <span style={styles.insightLabel}>Revenue at risk</span>
            </div>
          </div>

          <div style={styles.insightSection}>
            <h3 style={styles.insightSectionTitle}>Busiest days</h3>
            {['Tuesday', 'Thursday', 'Wednesday', 'Friday', 'Monday'].map((day, i) => {
              const pct = [95, 88, 82, 75, 60][i];
              return (
                <div key={day} style={styles.dayRow}>
                  <span style={styles.dayName}>{day}</span>
                  <div style={styles.dayBar}>
                    <div style={{ ...styles.dayBarFill, width: `${pct}%`, background: pct > 85 ? '#4CAF50' : pct > 70 ? '#FF9800' : '#E57373' }} />
                  </div>
                  <span style={styles.dayPct}>{pct}%</span>
                </div>
              );
            })}
          </div>

          <div style={styles.insightSection}>
            <h3 style={styles.insightSectionTitle}>Hardest slots to fill</h3>
            <div style={styles.hardSlotList}>
              {['Mon 11-12', 'Fri 15-17', 'Tue 17-19'].map((slot, i) => (
                <div key={slot} style={styles.hardSlot}>
                  <span style={styles.hardSlotText}>{slot}</span>
                  <span style={styles.hardSlotNote}>{['Often empty 3 weeks running', 'End of day — clients prefer mornings', 'Late Tue harder to fill'][i]}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={styles.tipCard}>
            <span style={{ fontSize: 16, marginRight: 8 }}>💡</span>
            <div>
              <span style={styles.tipTitle}>florrie.ai's suggestion</span>
              <span style={styles.tipText}>Your Monday mornings are consistently quiet. Consider offering a 10% "Monday morning" discount or moving your start time to 12pm to free up your morning.</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh', background: 'var(--bg, var(--bg, #FAF8F5))',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
    padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary, #2D2A26)',
  },
  header: { paddingTop: 28, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent, #C76B8A)', margin: 0, fontWeight: 500 },

  // Utilisation
  utilisationCard: {
    background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 16,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', marginBottom: 16,
  },
  utilisationHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  utilisationLabel: { fontSize: 12, color: 'var(--text-muted, #7a7470)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  utilisationPct: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary, #2D2A26)' },
  utilisationBar: {
    height: 8, borderRadius: 4, background: '#F0ECE8', overflow: 'hidden', marginBottom: 8,
  },
  utilisationFill: {
    height: '100%', borderRadius: 4,
    background: 'linear-gradient(90deg, #C76B8A, #E8A0B5)',
    transition: 'width 0.6s ease',
  },
  utilisationStats: { display: 'flex', justifyContent: 'space-between' },
  utilisationStat: { fontSize: 11, color: 'var(--text-muted, #7a7470)' },

  tabs: { display: 'flex', gap: 16, borderBottom: '1px solid #F0ECE8', marginBottom: 16 },
  tab: {
    padding: '10px 0', background: 'none', border: 'none',
    borderBottom: '2px solid transparent', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Gap cards
  gapList: { display: 'flex', flexDirection: 'column', gap: 10 },
  gapCard: {
    background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 14,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', cursor: 'pointer',
    transition: 'box-shadow 0.2s',
  },
  gapHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  gapTime: { display: 'flex', flexDirection: 'column', gap: 2 },
  gapDay: { fontSize: 12, fontWeight: 600, color: 'var(--accent, #C76B8A)' },
  gapSlot: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #2D2A26)' },
  gapDuration: { fontSize: 11, color: 'var(--text-muted, #7a7470)' },
  fillBadge: {
    padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
  },
  gapSuggestHint: { fontSize: 12, color: '#6b6560', marginTop: 8, display: 'block' },

  // Expanded gap suggestions
  gapExpanded: {
    marginTop: 12, paddingTop: 12, borderTop: '1px solid #F5F2EF',
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  suggestionCard: {
    background: 'var(--bg, var(--bg, #FAF8F5))', borderRadius: 10, padding: 12,
  },
  suggestionTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  suggAvatar: {
    width: 34, height: 34, borderRadius: 17, background: '#FBF0F3',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14, fontWeight: 600, color: 'var(--accent, #C76B8A)', flexShrink: 0,
  },
  suggInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  suggName: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  suggReason: { fontSize: 11, color: '#6b6560', lineHeight: 1.3 },
  suggDetail: { fontSize: 11, color: 'var(--text-muted, #7a7470)' },
  suggTreatment: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '6px 0', marginBottom: 6,
  },
  suggTreatLabel: { fontSize: 12, fontWeight: 500, color: '#5A5550' },
  suggTreatDur: { fontSize: 11, color: 'var(--text-muted, #7a7470)' },
  offerBtn: {
    width: '100%', padding: '8px 0', borderRadius: 8, border: 'none',
    background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  sentBadge: {
    display: 'block', textAlign: 'center', padding: '8px 0',
    fontSize: 12, fontWeight: 600, color: '#4CAF50',
  },

  // Full suggestion cards
  suggSection: { marginBottom: 20 },
  suggSectionTitle: { fontSize: 15, fontWeight: 600, margin: '0 0 2px', color: 'var(--text-primary, #2D2A26)' },
  suggSectionDesc: { fontSize: 12, color: 'var(--text-muted, #7a7470)', margin: '0 0 12px' },
  suggFullCard: {
    background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 14,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', marginBottom: 10,
  },
  suggReasonText: { fontSize: 12, color: '#6b6560', margin: '8px 0', lineHeight: 1.4 },
  overdueBadge: {
    padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 600,
    background: '#FEF2F2', color: '#E57373', flexShrink: 0,
  },

  // Insights
  insightGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 },
  insightCard: {
    background: 'var(--bg-card, #fff)', borderRadius: 14, padding: '16px 14px', textAlign: 'center',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  insightNum: { display: 'block', fontSize: 22, fontWeight: 700, color: 'var(--accent, #C76B8A)' },
  insightLabel: { display: 'block', fontSize: 11, color: 'var(--text-muted, #7a7470)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 4 },

  insightSection: {
    background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 16, marginBottom: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  insightSectionTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: 'var(--text-primary, #2D2A26)' },
  dayRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  dayName: { fontSize: 12, color: '#5A5550', width: 70, flexShrink: 0 },
  dayBar: { flex: 1, height: 6, borderRadius: 3, background: '#F0ECE8', overflow: 'hidden' },
  dayBarFill: { height: '100%', borderRadius: 3, transition: 'width 0.6s ease' },
  dayPct: { fontSize: 11, fontWeight: 600, color: 'var(--text-primary, #2D2A26)', width: 30, textAlign: 'right' },

  hardSlotList: { display: 'flex', flexDirection: 'column', gap: 8 },
  hardSlot: { display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 0', borderBottom: '1px solid #FAF8F5' },
  hardSlotText: { fontSize: 13, fontWeight: 600, color: '#E57373' },
  hardSlotNote: { fontSize: 11, color: 'var(--text-muted, #7a7470)' },

  tipCard: {
    display: 'flex', alignItems: 'flex-start', gap: 4,
    background: '#FBF0F3', borderRadius: 14, padding: 14,
  },
  tipTitle: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--accent, #C76B8A)', marginBottom: 4 },
  tipText: { display: 'block', fontSize: 12, color: '#5A5550', lineHeight: 1.5 },

  // Empty
  loadingText: { textAlign: 'center', color: 'var(--text-muted, #7a7470)', padding: 40, fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--text-primary, #2D2A26)' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted, #7a7470)', margin: 0, lineHeight: 1.5 },
};
