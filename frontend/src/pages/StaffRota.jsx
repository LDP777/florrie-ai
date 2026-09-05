import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useBeautician, fetchRowsStrict, updateRow } from '../lib/supabase.js';
import PageLoader from '../components/PageLoader.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Button from '../components/ui/Button.jsx';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';
import { ROTA_DAYS, ROTA_KEYS, weekDates, localDateKey, validShift, effectiveShift } from './staff-rota-model.js';

export default function StaffRota() {
  const { beautician, loading: profileLoading } = useBeautician();
  const [members, setMembers] = useState([]);
  const [exceptions, setExceptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(null);
  const [hours, setHours] = useState({});
  const [saving, setSaving] = useState(false);
  const dates = weekDates(offset);
  const weekExceptions = exceptions.filter(item => item.date >= localDateKey(dates[0]) && item.date <= localDateKey(dates[6]));
  useEffect(() => { if (!profileLoading) load(); }, [beautician, profileLoading]);
  async function load() {
    setLoading(true); setLoadError(null);
    if (!beautician) { setLoadError('Your business profile is unavailable.'); setLoading(false); return; }
    try {
      const [team, changes] = await Promise.all([fetchRowsStrict('team_members', beautician.id, { order: 'created_at' }), fetchRowsStrict('hours_exceptions', beautician.id, { order: 'date', ascending: true })]);
      setMembers(team); setExceptions(changes);
    } catch { setLoadError('Could not load your rota and salon exceptions. Try again.'); }
    finally { setLoading(false); }
  }
  function edit(member) { setEditing(member.id); setHours(member.working_hours || {}); setError(null); }
  async function save(event) {
    event.preventDefault();
    if (saving || !editing) return;
    if (ROTA_KEYS.some(day => !validShift(hours[day]))) { setError('Each working day needs an end time after its start time.'); return; }
    setSaving(true); setError(null);
    try {
      const saved = await updateRow('team_members', editing, { working_hours: hours });
      if (!saved?.id) throw new Error('No saved member returned');
      setMembers(prev => prev.map(member => member.id === editing ? { ...member, ...saved } : member));
      setEditing(null);
    } catch { setError('Could not save these hours. Your changes are still here; try again.'); }
    finally { setSaving(false); }
  }
  if (loading || profileLoading) return <PageLoader />;
  const active = members.filter(member => member.is_active !== false);
  const daily = active.flatMap(member => ROTA_KEYS.map((day,i) => effectiveShift(member,day,dates[i],exceptions)));
  const total = daily.some(shift => shift.hours === null) ? null : daily.reduce((sum,shift) => sum+shift.hours,0);
  return <div className="staff-rota" style={s.page}>
    <style>{`.staff-rota *{box-sizing:border-box}.staff-rota input{font:inherit;color:var(--text-primary);background:var(--bg-card,#FFFCF9)}.staff-rota input:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.rota-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}.rota-edit-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.rota-day{padding:12px 5px;text-align:center;background:var(--tone-1,#fbf1ea);border-radius:12px;min-width:0}.rota-day span{display:block}.rota-time{font-size:10px;line-height:1.6;margin-top:8px;overflow-wrap:anywhere}@media(max-width:600px){.rota-week{grid-template-columns:1fr}.rota-day{display:grid;grid-template-columns:80px 1fr;text-align:left;padding:12px 14px}.rota-day .rota-time{margin-top:0;font-size:12px}.rota-day .rota-day-date{display:inline;margin-left:5px}}`}</style>
    <PageHeader title="Staff rota" eyebrow="Team" subtitle="Plan the full week, including Sunday." action={<Button as={Link} to="/hours" variant="secondary" size="sm">Salon time off</Button>} />
    {loadError ? <div role="alert"><ErrorCard message={loadError} /><Button onClick={load} variant="secondary">Retry</Button></div> : <>
      <div style={s.stats}><div><strong style={s.number}>{active.length}</strong><span style={s.meta}>Active members</span></div><div><strong style={s.number}>{total === null ? 'Unavailable' : `${Number(total.toFixed(2))}h`}</strong><span style={s.meta}>Scheduled this week</span></div><div><strong style={s.number}>{weekExceptions.length}</strong><span style={s.meta}>Salon exceptions</span></div></div>
      <div style={s.weekNav}><Button variant="secondary" icon size="icon" aria-label="Previous week" onClick={() => setOffset(value => value - 1)}><Icon name="chevron-left" size={20} /></Button><span style={s.weekLabel}>{dates[0].toLocaleDateString('en-GB',{day:'numeric',month:'short'})} – {dates[6].toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</span><Button variant="secondary" icon size="icon" aria-label="Next week" onClick={() => setOffset(value => value + 1)}><Icon name="chevron-right" size={20} /></Button></div>
      {offset !== 0 && <Button variant="quiet" onClick={() => setOffset(0)}>Back to this week</Button>}
      <p style={s.text}>Scheduled hours reflect staff schedules and salon closures or amended hours. Inactive members contribute no hours.</p>
      {!members.length && <EmptyState icon="users" title="No team members yet" subtitle="Add your team to plan their working hours." actionLabel="Open Team" onAction={() => { window.location.href = '/team'; }} />}
      {members.map(member => {
        const name = [member.first_name,member.last_name].filter(Boolean).join(' ') || 'Team member';
        return <section key={member.id} style={s.card}>
          <div style={s.memberHeader}><div><h2 style={s.memberName}>{name}</h2><span style={s.meta}>{member.role || 'Team member'}{member.is_active === false ? ' · Inactive' : ''}</span></div><Button variant="quiet" size="sm" disabled={Boolean(editing)} onClick={() => edit(member)}>Edit hours</Button></div>
          {editing === member.id ? <form onSubmit={save}>
            <p style={s.text}>Set regular weekly hours. Salon exceptions still apply to specific dates.</p>
            {error && <div role="alert"><ErrorCard message={error} /></div>}
            {ROTA_KEYS.map((day,index) => <div key={day} className="rota-edit-row" style={s.editRow}>
              <label style={s.dayLabel}><input type="checkbox" checked={Boolean(hours[day])} onChange={event => setHours(prev => ({ ...prev, [day]: event.target.checked ? { start: '09:00', end: '17:00' } : null }))} />{ROTA_DAYS[index]}</label>
              {hours[day] ? <><input aria-label={`${ROTA_DAYS[index]} start time`} type="time" required value={(hours[day].start || '').slice(0,5)} style={s.timeInput} onChange={event => setHours(prev => ({...prev,[day]:{...prev[day],start:event.target.value}}))} /><span>to</span><input aria-label={`${ROTA_DAYS[index]} end time`} type="time" required value={(hours[day].end || '').slice(0,5)} style={s.timeInput} onChange={event => setHours(prev => ({...prev,[day]:{...prev[day],end:event.target.value}}))} /></> : <span style={s.meta}>Off</span>}
            </div>)}
            <div style={s.actions}><Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save hours'}</Button><Button variant="quiet" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button></div>
          </form> : <div className="rota-week">{ROTA_KEYS.map((day,index) => {
            const shift=effectiveShift(member,day,dates[index],exceptions);
            return <div key={day} className="rota-day"><span><strong style={{fontSize:11}}>{ROTA_DAYS[index]}</strong><span className="rota-day-date" style={s.meta}>{dates[index].getDate()}</span></span><span className="rota-time">{shift.label}</span></div>;
          })}</div>}
        </section>;
      })}
      <section style={s.card}><h2 style={s.memberName}>Salon exceptions this week</h2><p style={s.text}>These changes apply across the salon.</p>{weekExceptions.length ? weekExceptions.map(item=><div key={item.id} style={s.exception}><strong style={{fontSize:12}}>{item.date}</strong><span style={s.text}>{item.reason || item.note || (item.type==='closed' ? 'Salon closed' : 'Changed hours')}{item.start_time && item.end_time ? ` · ${item.start_time.slice(0,5)}–${item.end_time.slice(0,5)}` : ''}</span></div>) : <p style={s.text}>No salon exceptions for this week.</p>}<Button as={Link} to="/hours" variant="secondary">Manage hours & time off</Button></section>
    </>}
  </div>;
}
const s={page:{maxWidth:960,margin:'0 auto',padding:'20px 16px var(--scroll-pad-bottom,100px)',fontFamily:"'Plus Jakarta Sans',sans-serif",color:'var(--text-primary)'},stats:{display:'flex',flexWrap:'wrap',justifyContent:'space-between',gap:18,padding:22,borderRadius:22,border:'1px solid var(--border)',background:'var(--accent-wash,#FBF2F5)',margin:'8px 0 22px'},number:{display:'block',fontSize:25,fontWeight:650,color:'var(--accent)'},meta:{display:'block',fontSize:11,lineHeight:1.5,color:'var(--text-secondary)',marginTop:4},weekNav:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8},weekLabel:{fontSize:13,fontWeight:700,textAlign:'center'},text:{fontSize:12,lineHeight:1.7,color:'var(--text-secondary)',margin:'12px 0'},card:{padding:19,border:'1px solid var(--border)',borderRadius:21,background:'var(--bg-card,#FFFCF9)',marginBottom:14},memberHeader:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:16},memberName:{fontSize:15,margin:0},editRow:{padding:'10px 0',borderBottom:'1px solid var(--border)'},dayLabel:{display:'flex',alignItems:'center',gap:8,fontSize:12,fontWeight:600,minHeight:44,minWidth:74},timeInput:{minHeight:44,padding:8,border:'1px solid var(--border)',borderRadius:9,width:112},actions:{display:'flex',gap:10,marginTop:18},exception:{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap',borderTop:'1px solid var(--border)',padding:'8px 0'}};
