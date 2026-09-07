import { createHash } from 'node:crypto';

// The deployed schema has a primary key, but no (client_id, beautician_id)
// unique constraint. A stable ID makes concurrent first writes converge.
export function intelligenceId(beauticianId, clientId) {
  const hex = createHash('sha256').update(`florrie-client-intelligence:${beauticianId}:${clientId}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export function visitPatterns(appointments, now = new Date()) {
  const rows = appointments.filter(a => a.status === 'completed' && Date.parse(a.starts_at) <= +now && Date.parse(a.ends_at) <= +now)
    .sort((a,b) => a.starts_at.localeCompare(b.starts_at));
  // Multiple treatments on the same day are one visit, not a zero-day rhythm.
  const visits = new Map();
  for (const a of rows) {
    const day = a.starts_at.slice(0,10);
    const visit = visits.get(day) || { day, spend: 0 };
    visit.spend += Math.max(0, Number(a.price_cents) || 0);
    visits.set(day, visit);
  }
  const days = [...visits.keys()];
  const gaps = days.slice(1).map((day,i) => (Date.parse(day)-Date.parse(days[i]))/86400000).filter(n=>n>0);
  const sorted = [...gaps].sort((a,b)=>a-b);
  const middle = Math.floor(sorted.length/2);
  const rhythm = sorted.length ? Math.round(sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2) : null;
  const deviation = rhythm ? gaps.reduce((sum,n)=>sum+Math.abs(n-rhythm),0)/gaps.length : 0;
  const counts = new Map();
  for (const a of rows) if(a.treatment_id) counts.set(a.treatment_id,(counts.get(a.treatment_id)||0)+1);
  const favourite = [...counts].sort((a,b)=>b[1]-a[1])[0]?.[0];
  const last = days.at(-1);
  const predicted = last && rhythm ? new Date(Date.parse(last)+rhythm*86400000).toISOString().slice(0,10) : null;
  return {
    rebooking_rhythm_days: rhythm,
    rebooking_consistency: gaps.length>=2 ? Math.max(0,1-deviation/(rhythm||1)) : 0,
    favourite_treatments: favourite ? [favourite] : [],
    avg_spend_cents: days.length ? Math.round([...visits.values()].reduce((sum,v)=>sum+v.spend,0)/days.length) : 0,
    next_predicted_visit: predicted,
    visits: days.length,
  };
}
