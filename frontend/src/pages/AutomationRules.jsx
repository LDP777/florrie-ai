import { useEffect, useState } from 'react';
import { useBeautician, fetchRowsStrict, insertRow, updateRow, deleteRow } from '../lib/supabase.js';
import PageLoader from '../components/PageLoader.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Button from '../components/ui/Button.jsx';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';

const DELAYS = ['0h', '1h', '4h', '12h', '24h', '2d', '3d', '7d', '14d', '30d'];
const emptyForm = () => ({ name: '', steps: [{ delay: '24h', message: '' }] });
const delayLabel = delay => delay === '0h' ? 'No delay' : `${parseInt(delay, 10)} ${delay.endsWith('h') ? 'hours' : 'days'}`;

export default function AutomationRules() {
  const { beautician, loading: profileLoading } = useBeautician();
  const [sequences, setSequences] = useState([]);
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [activityError, setActivityError] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [tab, setTab] = useState('sequences');
  useEffect(() => { if (!profileLoading) load(); }, [beautician, profileLoading]);
  async function load() {
    setLoading(true); setLoadError(null); setActivityError(null);
    if (!beautician) { setLoadError('Your business profile is unavailable.'); setLoading(false); return; }
    const results = await Promise.allSettled([
      fetchRowsStrict('follow_up_sequences', beautician.id, { order: 'created_at', ascending: false }),
      fetchRowsStrict('ai_actions', beautician.id, { order: 'created_at', ascending: false, limit: 50 }),
    ]);
    if (results[0].status === 'fulfilled') setSequences(results[0].value); else setLoadError('Could not load your sequences. Try again.');
    if (results[1].status === 'fulfilled') setActions(results[1].value); else setActivityError('Could not load activity. Try again.');
    setLoading(false);
  }
  async function toggle(sequence) {
    if (pending) return;
    setPending(sequence.id); setError(null);
    try {
      const saved = await updateRow('follow_up_sequences', sequence.id, { active: !sequence.active });
      if (!saved?.id) throw new Error('No sequence returned');
      setSequences(prev => prev.map(item => item.id === sequence.id ? { ...item, ...saved } : item));
    } catch { setError('Could not change this sequence. Try again.'); }
    finally { setPending(null); }
  }
  async function remove(sequence) {
    if (pending || !window.confirm(`Delete “${sequence.name}” and its enrolments?`)) return;
    setPending(sequence.id); setError(null);
    try { await deleteRow('follow_up_sequences', sequence.id); setSequences(prev => prev.filter(item => item.id !== sequence.id)); }
    catch { setError('Could not delete this sequence. Try again.'); }
    finally { setPending(null); }
  }
  async function create(event) {
    event.preventDefault();
    if (pending || !beautician) return;
    if (!form.name.trim() || !form.steps.length || form.steps.some(step => !step.message.trim())) { setError('Give the sequence a name and write a message for each step.'); return; }
    if (form.steps.some(step => /\{[^}]+\}/.test(step.message))) { setError('Write the final message text. Personalisation fields such as {name} are not supported in sequences.'); return; }
    setPending('create'); setError(null);
    try {
      const saved = await insertRow('follow_up_sequences', { beautician_id: beautician.id, name: form.name.trim(), trigger: 'after-appointment', active: false, steps: form.steps.map(step => ({ delay: step.delay, message: step.message.trim() })) });
      if (!saved?.id) throw new Error('No saved sequence');
      setSequences(prev => [saved, ...prev]); setEditing(false); setForm(emptyForm());
    } catch { setError('Could not save this sequence. Your draft is still here; try again.'); }
    finally { setPending(null); }
  }
  const activeCount = sequences.filter(sequence => sequence.active && sequence.trigger === 'after-appointment').length;
  if (loading || profileLoading) return <PageLoader />;
  return <div className="automation-tools" style={s.page}>
    <style>{`.automation-tools input,.automation-tools textarea,.automation-tools select{font:inherit;color:var(--text-primary);background:var(--bg-card,#FFFCF9)}.automation-tools :is(input,textarea,select,summary):focus-visible{outline:3px solid var(--accent);outline-offset:3px}.automation-tools summary{cursor:pointer;min-height:64px;list-style:none}.automation-tools summary::-webkit-details-marker{display:none}`}</style>
    <PageHeader title="Automations" eyebrow="Business setup" subtitle="Follow up after completed appointments." />
    <section style={s.intro}><Icon name="send" size={25} /><div><h2 style={s.title}>Keep in touch after a visit.</h2><p style={s.text}>Create a message sequence, then turn on new enrolments when you’re ready. Delivery follows each client’s messaging preferences and consent.</p></div></section>
    <div style={s.notice}><strong>Custom rules aren’t available.</strong><p style={{ ...s.text, marginBottom: 0 }}>Event-based rules and templates do not run. You can manage appointment follow-up sequences below.</p></div>
    <div style={s.tabs}><Button variant={tab === 'sequences' ? 'primary' : 'secondary'} aria-pressed={tab === 'sequences'} onClick={() => setTab('sequences')}>Sequences</Button><Button variant={tab === 'activity' ? 'primary' : 'secondary'} aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>Activity</Button></div>
    {error && <div role="alert"><ErrorCard message={error} /></div>}
    {tab === 'sequences' ? <>
      {loadError ? <div role="alert"><ErrorCard message={loadError} /><Button onClick={load} variant="secondary">Retry</Button></div> : <>
        <div style={s.toolbar}><p style={s.text}>{activeCount} {activeCount === 1 ? 'sequence accepts' : 'sequences accept'} new enrolments</p><Button onClick={() => { setEditing(true); setError(null); }} disabled={editing}>New sequence</Button></div>
        {editing && <form onSubmit={create} style={s.card}>
          <h2 style={s.subtitle}>New follow-up sequence</h2>
          <p style={s.text}>For completed appointments. Save it paused so you can check the messages before turning it on.</p>
          <label style={s.label}>Sequence name<input required maxLength={120} value={form.name} onChange={event => setForm(prev => ({ ...prev, name: event.target.value }))} style={s.input} /></label>
          {form.steps.map((step, index) => <fieldset key={index} style={s.step}><legend style={s.legend}>Message {index + 1}</legend><label style={s.label}>{index ? 'Wait after the previous message' : 'Wait after enrolment'}<select style={s.input} value={step.delay} onChange={event => setForm(prev => ({ ...prev, steps: prev.steps.map((value, i) => i === index ? { ...value, delay: event.target.value } : value) }))}>{DELAYS.map(delay => <option key={delay} value={delay}>{delayLabel(delay)}</option>)}</select></label><label style={s.label}>Message text<textarea required rows={3} maxLength={4000} style={s.input} value={step.message} onChange={event => setForm(prev => ({ ...prev, steps: prev.steps.map((value, i) => i === index ? { ...value, message: event.target.value } : value) }))} /></label>{form.steps.length > 1 && <Button variant="quiet" onClick={() => setForm(prev => ({ ...prev, steps: prev.steps.filter((_, i) => i !== index) }))}>Remove message {index + 1}</Button>}</fieldset>)}
          <Button variant="secondary" onClick={() => setForm(prev => ({ ...prev, steps: [...prev.steps, { delay: '24h', message: '' }] }))}>Add message</Button>
          <div style={s.tabs}><Button type="submit" disabled={Boolean(pending)}>{pending === 'create' ? 'Saving…' : 'Save paused sequence'}</Button><Button variant="quiet" disabled={Boolean(pending)} onClick={() => { setEditing(false); setError(null); }}>Cancel</Button></div>
        </form>}
        {!sequences.length && !editing && <EmptyState icon="send" title="No follow-up sequences" subtitle="Create a sequence for clients after their completed appointments." />}
        {sequences.map(sequence => <details key={sequence.id} style={s.card}><summary><div style={s.summary}><span><strong>{sequence.name}</strong><span style={s.meta}>{Array.isArray(sequence.steps) ? sequence.steps.length : 0} messages · {sequence.trigger === 'after-appointment' ? 'After completed appointments' : 'Unsupported trigger'}</span></span><span style={s.badge}>{sequence.active && sequence.trigger === 'after-appointment' ? 'Enrolling' : 'Paused'}</span><Icon name="chevron-down" size={18} /></div></summary>
          {sequence.trigger !== 'after-appointment' && <p style={s.text}>This trigger does not enrol clients. Create an appointment follow-up sequence to use a supported trigger.</p>}
          {(Array.isArray(sequence.steps) ? sequence.steps : []).map((step, index) => <div key={index} style={s.message}><span style={s.meta}>Message {index + 1} · {typeof step.delay === 'string' ? delayLabel(step.delay) : 'No delay'}</span><p style={{ ...s.text, whiteSpace: 'pre-wrap' }}>{step.message || 'No message text'}</p></div>)}
          <p style={s.text}>Pausing stops new enrolments. Clients already enrolled can still receive the remaining messages.</p>
          <div style={s.tabs}>{(sequence.trigger === 'after-appointment' || sequence.active) && <Button variant="secondary" disabled={Boolean(pending)} onClick={() => toggle(sequence)}>{pending === sequence.id ? 'Saving…' : sequence.active ? 'Pause new enrolments' : 'Start new enrolments'}</Button>}<Button variant="danger" disabled={Boolean(pending)} onClick={() => remove(sequence)}>Delete sequence</Button></div>
        </details>)}
      </>}
    </> : activityError ? <div role="alert"><ErrorCard message={activityError} /><Button onClick={load} variant="secondary">Retry</Button></div> : <><p style={s.text}>Recent Florrie activity across your business. Sequence delivery reports are unavailable.</p>{!actions.length ? <EmptyState icon="list" title="No recorded activity" subtitle="Recorded Florrie actions will appear here." /> : actions.map(action => <article key={action.id} style={s.card}><p style={{ ...s.text, color: 'var(--text-primary)' }}>{action.summary || 'Activity recorded'}</p><time style={s.meta}>{action.created_at ? new Date(action.created_at).toLocaleString('en-GB') : 'Date unavailable'}</time></article>)}</>}
  </div>;
}
const s = {
 page:{maxWidth:760,margin:'0 auto',padding:'20px 16px var(--scroll-pad-bottom,100px)',fontFamily:"'Plus Jakarta Sans',sans-serif",color:'var(--text-primary)'},
 intro:{display:'flex',gap:18,padding:24,borderRadius:24,background:'var(--accent-wash,#FBF2F5)',border:'1px solid var(--border)',margin:'8px 0 16px',color:'var(--accent)'},
 title:{fontFamily:"'Playfair Display',Georgia,serif",fontSize:25,fontWeight:500,margin:'0 0 10px',color:'var(--text-primary)'},
 text:{fontSize:13,lineHeight:1.7,color:'var(--text-secondary)',margin:'8px 0 12px'},notice:{padding:18,border:'1px solid var(--border)',borderRadius:16,fontSize:13,background:'var(--tone-1,#fbf1ea)'},
 tabs:{display:'flex',gap:10,flexWrap:'wrap',margin:'18px 0'},toolbar:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap',marginBottom:18},
 card:{background:'var(--bg-card,#FFFCF9)',border:'1px solid var(--border)',borderRadius:20,padding:20,marginBottom:14},subtitle:{fontSize:18,margin:'0 0 12px'},
 label:{display:'block',fontSize:12,fontWeight:600,marginBottom:14},input:{display:'block',boxSizing:'border-box',width:'100%',minHeight:44,padding:12,marginTop:8,border:'1px solid var(--border)',borderRadius:11,fontSize:13},step:{border:'1px solid var(--border)',borderRadius:14,padding:15,margin:'20px 0'},legend:{fontSize:12,fontWeight:700,padding:'0 6px'},
 summary:{display:'flex',alignItems:'center',gap:12,justifyContent:'space-between',fontSize:14},meta:{display:'block',fontSize:11,lineHeight:1.6,color:'var(--text-secondary)',marginTop:6},badge:{fontSize:10,padding:'6px 8px',background:'var(--tone-1,#fbf1ea)',borderRadius:8},message:{borderTop:'1px solid var(--border)',paddingTop:12,marginTop:12},
};
