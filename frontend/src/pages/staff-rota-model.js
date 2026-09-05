export const ROTA_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const ROTA_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function weekDates(offset = 0, now = new Date()) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7 + offset * 7);
  return ROTA_KEYS.map((_, i) => { const date = new Date(monday); date.setDate(date.getDate() + i); return date; });
}
const minutes = value => {
  if (!/^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value || '')) return NaN;
  const [h,m] = value.split(':').map(Number); return h * 60 + m;
};
export function validShift(shift) {
  return !shift || (Number.isFinite(minutes(shift.start)) && minutes(shift.end) > minutes(shift.start));
}
const time = value => `${String(Math.floor(value / 60)).padStart(2,'0')}:${String(value % 60).padStart(2,'0')}`;
export function effectiveShift(member, day, date, exceptions = []) {
  if (member.is_active === false) return { label: 'Inactive', hours: 0 };
  const shift = member.working_hours?.[day];
  if (!shift) return { label: 'Off', hours: 0 };
  if (!validShift(shift)) return { label: 'Check hours', hours: null };
  const applicable = exceptions.filter(item => item.date === localDateKey(date));
  if (applicable.some(item => item.type === 'closed' || (item.type === 'time-off' && !item.start_time && !item.end_time))) return { label: 'Salon closed', hours: 0 };
  let intervals = [[minutes(shift.start), minutes(shift.end)]];
  for (const item of applicable) {
    const start = minutes(item.start_time), end = minutes(item.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { label: 'Check exception', hours: null };
    if (item.type === 'amended' || item.type === 'extended') intervals = intervals.map(([a,b]) => [Math.max(a,start),Math.min(b,end)]).filter(([a,b]) => b > a);
    else if (item.type === 'time-off') intervals = intervals.flatMap(([a,b]) => start >= b || end <= a ? [[a,b]] : [[a,Math.min(b,start)],[Math.max(a,end),b]].filter(([x,y]) => y > x));
    else return { label: 'Check exception', hours: null };
  }
  return { label: intervals.length ? intervals.map(([a,b]) => `${time(a)}–${time(b)}`).join(', ') : 'Off', hours: intervals.reduce((sum,[a,b])=>sum+(b-a)/60,0) };
}
