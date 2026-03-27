/**
 * Follow-up Sequences — Automated multi-step message flows.
 *
 * After a treatment, Ellie wants a sequence:
 *   Day 0: aftercare instructions
 *   Day 1: "How are your brows feeling?"
 *   Day 3: photo request
 *   Day 7: rebook nudge
 *
 * This page lets her build, preview, and manage these flows.
 */
import { useState } from 'react';
import { isDevMode } from '../lib/supabase.js';

const DEV_SEQUENCES = [
  {
    id: 'seq1',
    name: 'Post Semi-Permanent Care',
    trigger: 'after-appointment',
    treatments: ['Ombre Brows (Semi-Permanent)', 'Combination Brows (Semi-Permanent)'],
    active: true,
    steps: [
      { delay: '0h', channel: 'whatsapp', message: 'Hey {name}! Your new brows are looking gorgeous 😍 Here\'s your aftercare guide — dead important for the first 10 days: {aftercare_link} xx' },
      { delay: '24h', channel: 'whatsapp', message: 'Hey {name}, how are your brows feeling today? A little bit of redness is totally normal on day 1! Remember — no water on them for the first 24 hours xx' },
      { delay: '3d', channel: 'whatsapp', message: 'Hey girl, would love to see how they\'re healing! Send me a pic when you get a sec 📸 xx' },
      { delay: '7d', channel: 'whatsapp', message: 'One week in! They should be starting to peel now — don\'t pick at them! The colour will come back stronger once healed. Any questions just shout xx' },
      { delay: '35d', channel: 'whatsapp', message: 'Hey {name}! Your top-up is coming up soon — shall I get you booked in? I\'ve got a few slots next week if that works for you xx' },
    ],
    stats: { sent: 45, opened: 42, replied: 18 },
  },
  {
    id: 'seq2',
    name: 'Post Lamination Care',
    trigger: 'after-appointment',
    treatments: ['Lamination & Hybrid Dye', 'Lamination & Tint'],
    active: true,
    steps: [
      { delay: '0h', channel: 'whatsapp', message: 'Hey {name}! Brows are looking fab 💕 Remember — keep them dry for the next 24 hours and brush them up in the morning! xx' },
      { delay: '24h', channel: 'whatsapp', message: 'Morning girl! You can get them wet now — how are they looking? xx' },
      { delay: '21d', channel: 'whatsapp', message: 'Hey {name}, it\'s been about 3 weeks since your lamination — fancy getting booked in again before they start dropping? I\'ve got spaces this week and next xx' },
    ],
    stats: { sent: 72, opened: 68, replied: 31 },
  },
  {
    id: 'seq3',
    name: 'Birthday Flow',
    trigger: 'on-birthday',
    treatments: [],
    active: true,
    steps: [
      { delay: '0h', channel: 'whatsapp', message: 'Happy birthday {name}!! 🎂 Hope you have the most amazing day! As a little treat from me, here\'s 15% off your next appointment — just mention this message when you book xx' },
    ],
    stats: { sent: 8, opened: 8, replied: 5 },
  },
  {
    id: 'seq4',
    name: 'Dormant Client Win-Back',
    trigger: 'no-visit-60-days',
    treatments: [],
    active: false,
    steps: [
      { delay: '0h', channel: 'whatsapp', message: 'Hey {name}! It\'s been a while — miss your face! I\'ve got some new treatments on the menu and I\'d love to get you booked in. Fancy a catch-up appointment? xx' },
      { delay: '7d', channel: 'sms', message: 'Hi {name}, just checking in! I\'ve got a few slots this week if you fancy it. Book here: {booking_link}' },
    ],
    stats: { sent: 12, opened: 9, replied: 4 },
  },
];

const TRIGGERS = [
  { value: 'after-appointment', label: 'After Appointment', icon: '✅' },
  { value: 'on-birthday', label: 'On Birthday', icon: '🎂' },
  { value: 'no-visit-30-days', label: 'No Visit 30 Days', icon: '📅' },
  { value: 'no-visit-60-days', label: 'No Visit 60 Days', icon: '⏰' },
  { value: 'manual', label: 'Manual Start', icon: '▶️' },
];

const DELAY_OPTIONS = ['0h', '1h', '2h', '4h', '12h', '24h', '2d', '3d', '5d', '7d', '14d', '21d', '30d', '35d'];
const CHANNELS = ['whatsapp', 'sms', 'email'];
const VARIABLES = ['{name}', '{treatment}', '{date}', '{time}', '{booking_link}', '{aftercare_link}'];

export default function FollowUpSequences({ token }) {
  const [tab, setTab] = useState('sequences');
  const [expanded, setExpanded] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '', trigger: 'after-appointment', steps: [{ delay: '0h', channel: 'whatsapp', message: '' }],
  });

  const sequences = DEV_SEQUENCES;
  const totalSent = sequences.reduce((s, seq) => s + seq.stats.sent, 0);
  const totalReplied = sequences.reduce((s, seq) => s + seq.stats.replied, 0);
  const replyRate = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;

  const addStep = () => {
    setCreateForm(f => ({
      ...f,
      steps: [...f.steps, { delay: '24h', channel: 'whatsapp', message: '' }],
    }));
  };

  const updateStep = (idx, field, value) => {
    setCreateForm(f => ({
      ...f,
      steps: f.steps.map((s, i) => i === idx ? { ...s, [field]: value } : s),
    }));
  };

  const removeStep = (idx) => {
    setCreateForm(f => ({ ...f, steps: f.steps.filter((_, i) => i !== idx) }));
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h1 style={S.title}>Follow-up Sequences</h1>
        <button style={S.createBtn} onClick={() => setShowCreate(true)}>+ New</button>
      </div>

      {/* Stats */}
      <div style={S.statsRow}>
        {[
          { label: 'Active', value: sequences.filter(s => s.active).length, colour: '#6B8F7B' },
          { label: 'Messages Sent', value: totalSent, colour: '#C76B8A' },
          { label: 'Reply Rate', value: `${replyRate}%`, colour: '#8B6F5E' },
        ].map(s => (
          <div key={s.label} style={S.statCard}>
            <span style={{ ...S.statValue, color: s.colour }}>{s.value}</span>
            <span style={S.statLabel}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['sequences', 'analytics'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Sequences list */}
      {tab === 'sequences' && (
        <div style={S.list}>
          {sequences.map(seq => {
            const isExpanded = expanded === seq.id;
            const trigger = TRIGGERS.find(t => t.value === seq.trigger);
            return (
              <div key={seq.id} style={S.seqCard}>
                <div style={S.seqHeader} onClick={() => setExpanded(isExpanded ? null : seq.id)}>
                  <div style={S.seqLeft}>
                    <div style={{ ...S.seqIcon, background: seq.active ? '#E8F5E9' : '#F0ECE8' }}>
                      {trigger?.icon || '📨'}
                    </div>
                    <div style={S.seqInfo}>
                      <span style={S.seqName}>{seq.name}</span>
                      <span style={S.seqMeta}>{seq.steps.length} steps · {trigger?.label}</span>
                    </div>
                  </div>
                  <div style={S.seqRight}>
                    <span style={{ ...S.activeBadge, background: seq.active ? '#E8F5E9' : '#F0ECE8', color: seq.active ? '#4CAF50' : '#AAA5A0' }}>
                      {seq.active ? 'Active' : 'Paused'}
                    </span>
                  </div>
                </div>

                {isExpanded && (
                  <div style={S.seqExpanded}>
                    {/* Timeline */}
                    <div style={S.timeline}>
                      {seq.steps.map((step, i) => (
                        <div key={i} style={S.timelineStep}>
                          <div style={S.timelineLeft}>
                            <div style={S.timelineDot} />
                            {i < seq.steps.length - 1 && <div style={S.timelineLine} />}
                          </div>
                          <div style={S.timelineContent}>
                            <div style={S.stepHeader}>
                              <span style={S.stepDelay}>{formatDelay(step.delay)}</span>
                              <span style={S.stepChannel}>{step.channel === 'whatsapp' ? '💬' : step.channel === 'sms' ? '📱' : '✉️'} {step.channel}</span>
                            </div>
                            <p style={S.stepMessage}>{step.message}</p>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Treatments */}
                    {seq.treatments.length > 0 && (
                      <div style={S.treatmentRow}>
                        <span style={S.treatmentLabel}>Applies to:</span>
                        {seq.treatments.map((t, i) => (
                          <span key={i} style={S.treatmentTag}>{t}</span>
                        ))}
                      </div>
                    )}

                    {/* Stats */}
                    <div style={S.seqStats}>
                      <span style={S.seqStatItem}>{seq.stats.sent} sent</span>
                      <span style={S.seqStatItem}>{seq.stats.opened} opened</span>
                      <span style={S.seqStatItem}>{seq.stats.replied} replied</span>
                    </div>

                    <div style={S.seqActions}>
                      <button style={S.seqActionBtn}>Edit</button>
                      <button style={S.seqActionBtn}>Duplicate</button>
                      <button style={S.seqActionBtn}>{seq.active ? 'Pause' : 'Activate'}</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Analytics */}
      {tab === 'analytics' && (
        <div style={S.analyticsContainer}>
          {sequences.map(seq => {
            const openRate = seq.stats.sent > 0 ? Math.round((seq.stats.opened / seq.stats.sent) * 100) : 0;
            const repRate = seq.stats.sent > 0 ? Math.round((seq.stats.replied / seq.stats.sent) * 100) : 0;
            return (
              <div key={seq.id} style={S.analyticsCard}>
                <span style={S.analyticsName}>{seq.name}</span>
                <div style={S.analyticsRow}>
                  <div style={S.analyticsMetric}>
                    <span style={S.analyticsVal}>{openRate}%</span>
                    <span style={S.analyticsLabel}>Open Rate</span>
                    <div style={S.miniBar}><div style={{ ...S.miniBarFill, width: `${openRate}%`, background: '#6B8F7B' }} /></div>
                  </div>
                  <div style={S.analyticsMetric}>
                    <span style={S.analyticsVal}>{repRate}%</span>
                    <span style={S.analyticsLabel}>Reply Rate</span>
                    <div style={S.miniBar}><div style={{ ...S.miniBarFill, width: `${repRate}%`, background: '#C76B8A' }} /></div>
                  </div>
                  <div style={S.analyticsMetric}>
                    <span style={S.analyticsVal}>{seq.stats.sent}</span>
                    <span style={S.analyticsLabel}>Sent</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div style={S.overlay} onClick={() => setShowCreate(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h2 style={S.modalTitle}>New Sequence</h2>

            <div style={S.fieldLabel}>Sequence Name</div>
            <input style={S.input} placeholder="e.g. Post Lamination Care" value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))} />

            <div style={S.fieldLabel}>Trigger</div>
            <div style={S.chipRow}>
              {TRIGGERS.map(t => (
                <button key={t.value} onClick={() => setCreateForm(f => ({ ...f, trigger: t.value }))} style={{ ...S.chip, ...(createForm.trigger === t.value ? S.chipActive : {}) }}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>

            {/* Steps */}
            <div style={S.fieldLabel}>Steps</div>
            {createForm.steps.map((step, i) => (
              <div key={i} style={S.stepForm}>
                <div style={S.stepFormHeader}>
                  <span style={S.stepNum}>Step {i + 1}</span>
                  {createForm.steps.length > 1 && <button style={S.removeBtn} onClick={() => removeStep(i)}>✕</button>}
                </div>

                <div style={S.stepFormRow}>
                  <select style={{ ...S.miniSelect, flex: 1 }} value={step.delay} onChange={e => updateStep(i, 'delay', e.target.value)}>
                    {DELAY_OPTIONS.map(d => <option key={d} value={d}>{formatDelay(d)}</option>)}
                  </select>
                  <select style={{ ...S.miniSelect, flex: 1 }} value={step.channel} onChange={e => updateStep(i, 'channel', e.target.value)}>
                    {CHANNELS.map(ch => <option key={ch} value={ch}>{ch}</option>)}
                  </select>
                </div>

                <textarea style={S.textarea} rows={2} placeholder="Message text..." value={step.message} onChange={e => updateStep(i, 'message', e.target.value)} />

                <div style={S.varRow}>
                  {VARIABLES.map(v => (
                    <button key={v} style={S.varChip} onClick={() => updateStep(i, 'message', step.message + v)}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            <button style={S.addStepBtn} onClick={addStep}>+ Add Step</button>
            <button style={S.saveBtn} onClick={() => setShowCreate(false)}>Create Sequence</button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDelay(delay) {
  if (delay === '0h') return 'Immediately';
  const num = parseInt(delay);
  if (delay.endsWith('h')) return `After ${num} hour${num > 1 ? 's' : ''}`;
  if (delay.endsWith('d')) return `After ${num} day${num > 1 ? 's' : ''}`;
  return delay;
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  createBtn: { background: '#C76B8A', color: '#fff', border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  statsRow: { display: 'flex', gap: 10, marginBottom: 16 },
  statCard: { flex: 1, background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 18, fontWeight: 700 },
  statLabel: { fontSize: 11, color: '#AAA5A0' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: '#AAA5A0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },

  list: { display: 'flex', flexDirection: 'column', gap: 10 },

  seqCard: { background: 'var(--card, #fff)', borderRadius: 14, overflow: 'hidden' },
  seqHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, cursor: 'pointer' },
  seqLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  seqIcon: { width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 },
  seqInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  seqName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  seqMeta: { fontSize: 12, color: '#AAA5A0' },
  seqRight: {},
  activeBadge: { padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600 },

  seqExpanded: { padding: '0 14px 14px' },

  // Timeline
  timeline: { marginBottom: 12 },
  timelineStep: { display: 'flex', gap: 12 },
  timelineLeft: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12 },
  timelineDot: { width: 10, height: 10, borderRadius: 5, background: '#C76B8A', flexShrink: 0, marginTop: 4 },
  timelineLine: { width: 2, flex: 1, background: '#F0ECE8', margin: '4px 0' },
  timelineContent: { flex: 1, paddingBottom: 12 },
  stepHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 },
  stepDelay: { fontSize: 12, fontWeight: 600, color: '#C76B8A' },
  stepChannel: { fontSize: 11, color: '#AAA5A0' },
  stepMessage: { fontSize: 13, color: '#8B6F5E', lineHeight: 1.4, margin: 0, background: '#F9F7F4', borderRadius: 8, padding: '8px 10px' },

  treatmentRow: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 12 },
  treatmentLabel: { fontSize: 11, fontWeight: 600, color: '#AAA5A0' },
  treatmentTag: { padding: '3px 8px', borderRadius: 6, background: '#F0E6ED', color: '#C76B8A', fontSize: 11 },

  seqStats: { display: 'flex', gap: 16, marginBottom: 12 },
  seqStatItem: { fontSize: 12, color: '#8B6F5E' },

  seqActions: { display: 'flex', gap: 8 },
  seqActionBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#2D2A26' },

  // Analytics
  analyticsContainer: { display: 'flex', flexDirection: 'column', gap: 10 },
  analyticsCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14 },
  analyticsName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)', display: 'block', marginBottom: 10 },
  analyticsRow: { display: 'flex', gap: 12 },
  analyticsMetric: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  analyticsVal: { fontSize: 18, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  analyticsLabel: { fontSize: 10, color: '#AAA5A0' },
  miniBar: { height: 4, borderRadius: 2, background: '#F0ECE8', marginTop: 4 },
  miniBarFill: { height: 4, borderRadius: 2 },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: '#fff', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' },
  modalTitle: { fontSize: 18, fontWeight: 700, color: '#2D2A26', margin: '0 0 16px' },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: '#8B6F5E', marginBottom: 6, marginTop: 12 },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: '#2D2A26', outline: 'none', boxSizing: 'border-box' },
  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: { padding: '6px 10px', borderRadius: 8, border: '1px solid #F0ECE8', background: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: '#2D2A26' },
  chipActive: { background: '#C76B8A', color: '#fff', border: '1px solid #C76B8A' },

  stepForm: { background: '#F9F7F4', borderRadius: 10, padding: 12, marginBottom: 8 },
  stepFormHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: 8 },
  stepNum: { fontSize: 12, fontWeight: 600, color: '#C76B8A' },
  removeBtn: { background: 'none', border: 'none', color: '#AAA5A0', fontSize: 14, cursor: 'pointer' },
  stepFormRow: { display: 'flex', gap: 8, marginBottom: 8 },
  miniSelect: { padding: '8px 10px', borderRadius: 8, border: '1px solid #F0ECE8', fontSize: 13, fontFamily: 'inherit', color: '#2D2A26', background: '#fff', outline: 'none' },
  textarea: { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #F0ECE8', fontSize: 13, fontFamily: 'inherit', color: '#2D2A26', outline: 'none', resize: 'vertical', boxSizing: 'border-box' },
  varRow: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 },
  varChip: { padding: '3px 8px', borderRadius: 6, border: '1px solid #E0DCD8', background: '#fff', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', color: '#8B6F5E' },

  addStepBtn: { width: '100%', padding: '10px 0', borderRadius: 10, border: '1px dashed #E0DCD8', background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#8B6F5E', marginTop: 4 },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 16 },
};
