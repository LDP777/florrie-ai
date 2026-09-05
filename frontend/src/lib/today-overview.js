// Appointment timestamps contain salon wall time. Convert only the current
// clock to that frame; converting an appointment shifts it by an hour in BST.
export function salonClock(now = new Date(), timezone = 'Europe/London') {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return salonClock(now, 'Europe/London');
  }
  const get = type => parts.find(p => p.type === type)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

export function appointmentName(appointment) {
  const client = appointment?.clients || appointment?.client;
  return [client?.first_name, client?.last_name].filter(Boolean).join(' ').trim()
    || appointment?.client_name || 'Client';
}

export function appointmentTime(appointment) {
  return String(appointment?.starts_at || '').slice(11, 16);
}

export function todayOverview(appointments, clock) {
  const all = appointments.filter(a => String(a.starts_at).slice(0, 10) === clock.date);
  const diary = all.filter(a => ['confirmed', 'booked', 'completed'].includes(a.status))
    .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  const wallNow = `${clock.date}T${clock.time}`;
  const scheduled = diary.filter(a => a.status !== 'completed');
  const current = scheduled.find(a => String(a.starts_at).slice(0, 16) <= wallNow
    && String(a.ends_at || '').slice(0, 16) > wallNow) || null;
  const next = scheduled.find(a => String(a.starts_at).slice(0, 16) >= wallNow) || null;
  const dead = ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show'];
  const live = all.filter(a => !dead.includes(a.status));
  const price = a => a.price_cents ?? a.treatments?.price_cents ?? 0;
  return {
    diary, current, next, focus: current || next,
    date: clock.date,
    completed: diary.filter(a => a.status === 'completed').length,
    completedValue: diary.filter(a => a.status === 'completed').reduce((sum, a) => sum + price(a), 0),
    potentialValue: live.reduce((sum, a) => sum + price(a), 0),
    needsPrice: live.filter(a => price(a) === 0).length,
    pending: live.filter(a => !['confirmed', 'booked', 'completed'].includes(a.status)).length,
  };
}

export function decisionOverview(pending, escalations) {
  // Missing/malformed responses mean unknown, not an empty approval queue.
  if (!Array.isArray(pending?.pending) || !Array.isArray(escalations?.escalations)) {
    throw new Error('Decision queue unavailable');
  }
  return [
    ...pending.pending.map(row => ({ ...row, draft: row.body || '' })),
    ...escalations.escalations.filter(row => String(row.ai_response || '').trim())
      .map(row => ({ ...row, draft: row.ai_response })),
  ];
}
