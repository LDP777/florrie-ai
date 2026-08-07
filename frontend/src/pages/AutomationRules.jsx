import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow, deleteRow } from '../lib/supabase.js'
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
const triggerOptions = [
  { id: 'appointment_booked', label: 'Appointment booked', icon: '📅' },
  { id: 'appointment_completed', label: 'Appointment completed', icon: '✅' },
  { id: 'no_show', label: 'Client no-shows', icon: '🚫' },
  { id: 'cancellation', label: 'Cancellation received', icon: '❌' },
  { id: 'new_client', label: 'New client created', icon: '👤' },
  { id: 'dormant_client', label: 'Client goes dormant', icon: '💤' },
  { id: 'birthday', label: 'Client birthday', icon: '🎂' },
  { id: 'review_received', label: 'Review received', icon: '⭐' },
  { id: 'payment_received', label: 'Payment received', icon: '💰' },
  { id: 'waitlist_match', label: 'Waitlist slot opens', icon: '⏳' },
  { id: 'loyalty_milestone', label: 'Loyalty tier reached', icon: '🏆' },
  { id: 'patch_test_expiry', label: 'Patch test expiring', icon: '🩹' },
];
const actionOptions = [
  { id: 'send_whatsapp', label: 'Send WhatsApp message', icon: '💬' },
  { id: 'send_email', label: 'Send email', icon: '📧' },
  { id: 'send_sms', label: 'Send SMS', icon: '📱' },
  { id: 'add_tag', label: 'Add client tag', icon: '🏷️' },
  { id: 'remove_tag', label: 'Remove client tag', icon: '🏷️' },
  { id: 'add_loyalty', label: 'Award loyalty points', icon: '⭐' },
  { id: 'create_task', label: 'Create task', icon: '☑️' },
  { id: 'apply_discount', label: 'Apply discount code', icon: '🎟️' },
  { id: 'block_booking', label: 'Block booking ability', icon: '🔒' },
  { id: 'notify_staff', label: 'Notify team member', icon: '🔔' },
  { id: 'move_to_waitlist', label: 'Add to waitlist', icon: '📋' },
  { id: 'schedule_followup', label: 'Schedule follow-up', icon: '🔄' },
];
const conditionOptions = [
  { id: 'visit_count', label: 'Visit count', options: ['is more than', 'is less than', 'equals'] },
  { id: 'total_spend', label: 'Total spend', options: ['is more than', 'is less than'] },
  { id: 'last_visit', label: 'Days since last visit', options: ['is more than', 'is less than'] },
  { id: 'treatment_type', label: 'Treatment type', options: ['is', 'is not'] },
  { id: 'client_tag', label: 'Client has tag', options: ['includes', 'does not include'] },
  { id: 'loyalty_tier', label: 'Loyalty tier', options: ['is', 'is above', 'is below'] },
];
// Normalise a DB row to the shape this page renders.
// The real columns are is_active, trigger_count and last_triggered_at. There is
// no enabled / runs / last_run, and the ?? chain below was masking that.
//
// STILL BROKEN, needs a decision, not a rename: duplicateRule, useTemplate and
// the create form all insert trigger, actions, conditions, delay_minutes, runs
// and last_run. None of those are columns either, and the page's trigger ids
// ('appointment_booked', 'payment_received', 'waitlist_match' and the rest) are
// not in the trigger_type CHECK, so no rule can be created from this page at
// all. That is why automation_rules is empty and the executor in
// services/automations.js has never fired. Fixing it means agreeing what an
// automation rule is, not guessing at column names.
function normaliseRule(r) {
  return {
    ...r,
    enabled: r.enabled ?? r.is_active ?? false,
    actions: Array.isArray(r.actions) ? r.actions : [],
    runs: r.runs ?? r.trigger_count ?? 0,
  };
}
const templateRules = [
  { name: 'Post-appointment thank you', trigger: 'appointment_completed', actions: ['send_whatsapp'], description: 'Send thank you + aftercare link after each visit' },
  { name: 'Review request (5-star clients)', trigger: 'appointment_completed', actions: ['send_whatsapp'], description: 'Ask happy clients to leave a Google review' },
  { name: 'Patch test reminder', trigger: 'patch_test_expiry', actions: ['send_whatsapp', 'create_task'], description: 'Remind client and flag for rebooking when patch test expires' },
  { name: 'Cancellation follow-up', trigger: 'cancellation', actions: ['send_whatsapp', 'schedule_followup'], description: 'Sympathetic message + offer to rebook within 7 days' },
];
export default function AutomationRules() {
  const [activeTab, setActiveTab] = useState('rules');
  const [rules, setRules] = useState([]);
  const [creating, setCreating] = useState(false);
  const [newRule, setNewRule] = useState({ name: '', trigger: null, actions: [], conditions: [], delay: '0' });
  const [expandedRule, setExpandedRule] = useState(null);
  const { beautician, loading: bLoading } = useBeautician();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (bLoading) return;
    if (!beautician) { setRules([]); setLoaded(true); return; }
    fetchRows('automation_rules', beautician.id, { order: 'created_at', ascending: false })
      .then(rows => { setRules(rows.map(normaliseRule)); setLoaded(true); });
  }, [beautician, bLoading]);
  if (bLoading || !loaded) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted, var(--text-muted, #7a7470))' }}>Loading...</div>;
  const toggleRule = async (id) => {
    const rule = rules.find(r => r.id === id);
    if (!rule) return;
    const newEnabled = !rule.enabled;
    setRules(rules.map(r => r.id === id ? { ...r, enabled: newEnabled } : r));
    if (beautician) {
      // The column is is_active, not enabled (007_all_features.sql). Sending
      // `enabled` got the whole update rejected, so the toggle animated on and
      // then silently snapped back on the next load.
      try { await updateRow('automation_rules', id, { is_active: newEnabled }); } catch (e) { logger.error(e); }
    }
  };
  const deleteRule = async (id) => {
    setRules(rules.filter(r => r.id !== id));
    setExpandedRule(null);
    if (beautician) {
      try { await deleteRow('automation_rules', id); } catch (e) { logger.error(e); }
    }
  };
  const duplicateRule = async (rule) => {
    const copy = {
      beautician_id: beautician?.id,
      name: `${rule.name} (copy)`,
      trigger: rule.trigger,
      actions: rule.actions || [],
      conditions: rule.conditions || [],
      delay_minutes: rule.delay_minutes || 0,
      enabled: false,
      runs: 0,
      last_run: null,
    };
    if (beautician) {
      try {
        const saved = await insertRow('automation_rules', copy);
        setRules([normaliseRule(saved), ...rules]);
      } catch (e) { logger.error('Duplicate rule failed:', e); }
    } else {
      setRules([{ ...copy, id: 'new-' + Date.now() }, ...rules]);
    }
  };
  const useTemplate = async (tmpl) => {
    const rule = {
      beautician_id: beautician?.id,
      name: tmpl.name,
      trigger: tmpl.trigger,
      actions: tmpl.actions || [],
      conditions: [],
      delay_minutes: 0,
      enabled: false,
      runs: 0,
      last_run: null,
    };
    if (beautician) {
      try {
        const saved = await insertRow('automation_rules', rule);
        setRules([normaliseRule(saved), ...rules]);
        setActiveTab('rules');
      } catch (e) { logger.error('Use template failed:', e); }
    } else {
      setRules([{ ...rule, id: 'new-' + Date.now() }, ...rules]);
      setActiveTab('rules');
    }
  };
  const activeCount = rules.filter(r => r.enabled).length;
  const totalRuns = rules.reduce((sum, r) => sum + (r.runs || 0), 0);
  const tabs = [
    { id: 'rules', label: `Rules (${rules.length})` },
    { id: 'sequences', label: 'Sequences' },
    { id: 'templates', label: 'Templates' },
    { id: 'log', label: 'Activity' },
  ];
  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Automations</h1>
          <div style={styles.subtitle}>{activeCount} active · {totalRuns} total runs</div>
        </div>
        <button onClick={() => setCreating(!creating)} style={styles.createBtn}>
          {creating ? '✕' : '+ New'}
        </button>
      </div>
      {/* Create new rule */}
      {creating && (
        <div style={styles.createCard}>
          <div style={styles.createTitle}>Build a rule</div>
          {/* Rule name */}
          <input
            type="text"
            value={newRule.name}
            onChange={e => setNewRule({ ...newRule, name: e.target.value })}
            placeholder="Rule name..."
            style={styles.ruleInput}
          />
          {/* When (trigger) */}
          <div style={styles.stepLabel}>⚡ WHEN this happens...</div>
          <div style={styles.chipGrid}>
            {triggerOptions.map(t => (
              <button
                key={t.id}
                onClick={() => setNewRule({ ...newRule, trigger: t.id })}
                style={{ ...styles.chip,
                  ...(newRule.trigger === t.id ? styles.chipSelected : {})
                }}
              >
                <span>{t.icon}</span> {t.label}
              </button>
            ))}
          </div>
          {/* Delay */}
          <div style={styles.stepLabel}>⏱️ Wait...</div>
          <div style={styles.delayRow}>
            {['0', '5', '30', '60', '1440'].map(mins => (
              <button
                key={mins}
                onClick={() => setNewRule({ ...newRule, delay: mins })}
                style={{ ...styles.delayChip,
                  ...(newRule.delay === mins ? styles.chipSelected : {})
                }}
              >
                {mins === '0' ? 'Immediately' : mins === '5' ? '5 min' : mins === '30' ? '30 min' : mins === '60' ? '1 hour' : '24 hours'}
              </button>
            ))}
          </div>
          {/* Then (actions) */}
          <div style={styles.stepLabel}>🎯 THEN do this...</div>
          <div style={styles.chipGrid}>
            {actionOptions.map(a => (
              <button
                key={a.id}
                onClick={() => {
                  const actions = newRule.actions.includes(a.id)
                    ? newRule.actions.filter(x => x !== a.id)
                    : [...newRule.actions, a.id];
                  setNewRule({ ...newRule, actions });
                }}
                style={{ ...styles.chip,
                  ...(newRule.actions.includes(a.id) ? styles.chipSelected : {})
                }}
              >
                <span>{a.icon}</span> {a.label}
              </button>
            ))}
          </div>
          {/* Only if (conditions) */}
          <div style={styles.stepLabel}>🔍 ONLY IF... <span style={{ fontSize: 11, color: 'var(--text-muted, var(--text-muted, #7a7470))', fontWeight: 400 }}>(optional)</span></div>
          <div style={styles.conditionsList}>
            {conditionOptions.map(c => (
              <div key={c.id} style={styles.conditionRow}>
                <span style={{ fontSize: 13, color: '#6B6560', flex: 1 }}>{c.label}</span>
                <select style={styles.condSelect}>
                  {c.options.map(o => <option key={o}>{o}</option>)}
                </select>
                <input type="text" placeholder="value" style={styles.condInput} />
              </div>
            ))}
          </div>
          <button
            onClick={async () => {
              if (!newRule.name || !newRule.trigger || !newRule.actions.length) return;
              const rule = {
                beautician_id: beautician?.id,
                name: newRule.name,
                trigger: newRule.trigger,
                actions: newRule.actions,
                conditions: newRule.conditions || [],
                delay_minutes: parseInt(newRule.delay) || 0,
                enabled: true,
                runs: 0,
                last_run: null,
              };
              try {
                const saved = await insertRow('automation_rules', rule);
                setRules([normaliseRule(saved), ...rules]);
                setNewRule({ name: '', trigger: null, actions: [], conditions: [], delay: '0' });
                setCreating(false);
              } catch (e) { logger.error('Save rule failed:', e); }
            }}
            style={{ ...styles.saveRuleBtn,
              opacity: newRule.name && newRule.trigger && newRule.actions.length ? 1 : 0.5
            }}
          >
            Save Automation
          </button>
        </div>
      )}
      {/* Tabs */}
      <div style={styles.tabs}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{ ...styles.tab,
              ...(activeTab === tab.id ? styles.tabActive : {})
            }}
          >{tab.label}</button>
        ))}
      </div>
      {/* Rules list */}
      {activeTab === 'rules' && rules.length === 0 && !creating && (
        <EmptyState
          icon="⚡"
          title="No automations yet"
          subtitle="Create a rule to handle the busywork automatically, or start from a template."
          actionLabel="+ New rule"
          onAction={() => setCreating(true)}
        />
      )}
      {activeTab === 'rules' && rules.length > 0 && (
        <div>
          {rules.map(rule => (
            <div key={rule.id} style={styles.ruleCard}>
              <div style={styles.ruleHeader} onClick={() => setExpandedRule(expandedRule === rule.id ? null : rule.id)}>
                <div style={{ flex: 1 }}>
                  <div style={styles.ruleName}>{rule.name}</div>
                  <div style={styles.ruleDesc}>{rule.description}</div>
                  <div style={styles.ruleMeta}>
                    <span>{triggerOptions.find(t => t.id === rule.trigger)?.icon} {triggerOptions.find(t => t.id === rule.trigger)?.label}</span>
                    <span style={{ color: 'var(--border, var(--border, var(--border, #EDE9E4)))' }}>→</span>
                    <span>{(rule.actions || []).map(a => actionOptions.find(o => o.id === a)?.icon).join(' ')}</span>
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); toggleRule(rule.id); }}
                  style={{ ...styles.toggle,
                    background: rule.enabled ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, var(--border, #EDE9E4)))'
                  }}
                >
                  <div style={{ ...styles.toggleDot,
                    transform: rule.enabled ? 'translateX(18px)' : 'translateX(0)'
                  }} />
                </button>
              </div>
              {expandedRule === rule.id && (
                <div style={styles.ruleExpanded}>
                  <div style={styles.ruleStatRow}>
                    <div style={styles.ruleStatItem}>
                      <div style={{ fontSize: 18, fontWeight: 700 }}>{rule.runs || 0}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted, var(--text-muted, #7a7470))' }}>Total runs</div>
                    </div>
                    <div style={styles.ruleStatItem}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{rule.lastRun || (rule.last_run ? new Date(rule.last_run).toLocaleDateString() : 'Never')}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted, var(--text-muted, #7a7470))' }}>Last fired</div>
                    </div>
                  </div>
                  <div style={styles.ruleActions}>
                    <button onClick={() => duplicateRule(rule)} style={styles.ruleActionBtn}>📋 Duplicate</button>
                    <button onClick={() => deleteRule(rule.id)} style={{ ...styles.ruleActionBtn, color: '#E85D75' }}>🗑️ Delete</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {/* Templates */}
      {activeTab === 'templates' && (
        <div>
          <div style={styles.templatesHint}>Pre-built automations - tap to add and customise</div>
          {templateRules.map((tmpl, i) => (
            <div key={i} style={styles.templateCard}>
              <div style={{ flex: 1 }}>
                <div style={styles.ruleName}>{tmpl.name}</div>
                <div style={styles.ruleDesc}>{tmpl.description}</div>
                <div style={styles.ruleMeta}>
                  <span>{triggerOptions.find(t => t.id === tmpl.trigger)?.icon} {triggerOptions.find(t => t.id === tmpl.trigger)?.label}</span>
                </div>
              </div>
              <button onClick={() => useTemplate(tmpl)} style={styles.useTemplateBtn}>+ Use</button>
            </div>
          ))}
        </div>
      )}
      {/* Follow-up sequences - merged from FollowUpSequences.jsx */}
      {activeTab === 'sequences' && <SequencesPanel beautician={beautician} />}
      {/* Activity log */}
      {activeTab === 'log' && <ActivityPanel beautician={beautician} />}
    </div>
  );
}
const styles = {
  page: { padding: '16px 16px 24px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text-primary, #2D2A26)', margin: 0 },
  subtitle: { fontSize: 13, color: 'var(--text-muted, var(--text-muted, #7a7470))', marginTop: 2 },
  createBtn: { padding: '8px 16px', borderRadius: 10, border: 'none', background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  createCard: { background: 'var(--bg-card, #fff)', borderRadius: 16, padding: 16, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', marginBottom: 16 },
  createTitle: { fontSize: 16, fontWeight: 700, color: 'var(--text-primary, #2D2A26)', marginBottom: 12 },
  ruleInput: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border, var(--border, var(--border, #EDE9E4)))', fontSize: 14, fontFamily: 'inherit', outline: 'none', marginBottom: 16, boxSizing: 'border-box', background: 'var(--bg, var(--bg, #FAF8F5))' },
  stepLabel: { fontSize: 12, fontWeight: 700, color: '#6B6560', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 12 },
  chipGrid: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chip: { display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', background: 'var(--bg, var(--bg, #FAF8F5))', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: '#4A4540' },
  chipSelected: { background: 'var(--accent-light, #FFF0F3)', borderColor: 'var(--accent, #C76B8A)', color: 'var(--accent, #C76B8A)' },
  delayRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 },
  delayChip: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', background: 'var(--bg, var(--bg, #FAF8F5))', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: '#4A4540' },
  conditionsList: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 },
  conditionRow: { display: 'flex', alignItems: 'center', gap: 6 },
  condSelect: { padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', fontSize: 11, fontFamily: 'inherit', background: 'var(--bg, var(--bg, #FAF8F5))', color: '#4A4540' },
  condInput: { width: 60, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', fontSize: 11, fontFamily: 'inherit', background: 'var(--bg, var(--bg, #FAF8F5))' },
  saveRuleBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 8 },
  tabs: { display: 'flex', gap: 4, marginBottom: 16, background: 'var(--border, var(--border, var(--border, #EDE9E4)))', borderRadius: 12, padding: 4 },
  tab: { flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 500, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: 'none', color: '#6B6560' },
  tabActive: { background: 'var(--bg-card, #fff)', color: 'var(--text-primary, #2D2A26)', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },
  ruleCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', marginBottom: 10, overflow: 'hidden' },
  ruleHeader: { display: 'flex', alignItems: 'center', gap: 12, padding: 14, cursor: 'pointer' },
  ruleName: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)', marginBottom: 2 },
  ruleDesc: { fontSize: 12, color: '#6B6560', lineHeight: 1.4, marginBottom: 6 },
  ruleMeta: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted, var(--text-muted, #7a7470))' },
  toggle: { width: 42, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleDot: { width: 20, height: 20, borderRadius: 10, background: 'var(--bg-card, #fff)', position: 'absolute', top: 2, left: 2, transition: 'transform 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.15)' },
  ruleExpanded: { padding: '0 14px 14px', borderTop: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))' },
  ruleStatRow: { display: 'flex', gap: 24, padding: '12px 0' },
  ruleStatItem: { textAlign: 'center' },
  ruleActions: { display: 'flex', gap: 8 },
  ruleActionBtn: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', background: 'var(--bg, var(--bg, #FAF8F5))', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: '#6B6560' },
  templatesHint: { fontSize: 13, color: 'var(--text-muted, var(--text-muted, #7a7470))', marginBottom: 12 },
  templateCard: { display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 14, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', marginBottom: 10 },
  useTemplateBtn: { padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--border, var(--border, var(--border, #EDE9E4)))', color: 'var(--text-primary, #2D2A26)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 },
  logRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', borderBottom: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))' },
  logDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
};
const SEQ_TRIGGERS = [
  { value: 'after-appointment', label: 'After Appointment', icon: '✅' },
  { value: 'on-birthday',       label: 'On Birthday',       icon: '🎂' },
  { value: 'no-visit-30-days',  label: 'No Visit 30 Days',  icon: '📅' },
  { value: 'no-visit-60-days',  label: 'No Visit 60 Days',  icon: '⏰' },
  { value: 'manual',            label: 'Manual Start',       icon: '▶️' },
];
const SEQ_DELAYS  = ['0h','1h','2h','4h','12h','24h','2d','3d','5d','7d','14d','21d','30d','35d'];
const SEQ_CHANNELS = ['whatsapp', 'sms', 'email'];
const SEQ_VARS = ['{name}','{treatment}','{date}','{time}','{booking_link}','{aftercare_link}'];
function formatSeqDelay(d) {
  if (!d) return 'Immediately';
  if (d === '0h') return 'Immediately';
  const match = d.match(/^(\d+)(h|d)$/);
  if (!match) return d;
  const [, n, unit] = match;
  if (unit === 'h') return n === '1' ? '1 hour' : `${n} hours`;
  return n === '1' ? '1 day' : `${n} days`;
}
function SequencesPanel({ beautician }) {
  const [sequences, setSequences] = useState([]);
  const [expanded, setExpanded]   = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving]        = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '', trigger: 'after-appointment', steps: [{ delay: '0h', channel: 'whatsapp', message: '' }],
  });
  const [seqLoaded, setSeqLoaded] = useState(false);
  useEffect(() => {
    if (!beautician) { setSequences([]); setSeqLoaded(true); return; }
    fetchRows('follow_up_sequences', beautician.id, { order: 'created_at' })
      .then(rows => { setSequences(rows || []); setSeqLoaded(true); })
      .catch(() => { setSequences([]); setSeqLoaded(true); });
  }, [beautician]);
  async function handleToggle(seq) {
    const next = !seq.active;
    setSequences(prev => prev.map(s => s.id === seq.id ? { ...s, active: next } : s));
    if (beautician) {
      try { await updateRow('follow_up_sequences', seq.id, { active: next }); }
      catch (e) { logger.error(e); setSequences(prev => prev.map(s => s.id === seq.id ? { ...s, active: seq.active } : s)); }
    }
  }
  async function handleDelete(id) {
    setSequences(prev => prev.filter(s => s.id !== id));
    if (beautician) {
      try { await deleteRow('follow_up_sequences', id); } catch (e) { logger.error(e); }
    }
  }
  async function handleCreate() {
    if (!createForm.name.trim()) return;
    setSaving(true);
    try {
      if (beautician) {
        const row = await insertRow('follow_up_sequences', {
          beautician_id: beautician.id,
          name: createForm.name.trim(),
          trigger: createForm.trigger,
          steps: createForm.steps,
          active: true,
          stats: { sent: 0, opened: 0, replied: 0 },
        });
        if (row) setSequences(prev => [...prev, row]);
      } else {
        setSequences(prev => [...prev, { id: 'new-' + Date.now(), ...createForm, active: true, stats: { sent: 0, opened: 0, replied: 0 } }]);
      }
      setShowCreate(false);
      setCreateForm({ name: '', trigger: 'after-appointment', steps: [{ delay: '0h', channel: 'whatsapp', message: '' }] });
    } catch (e) { logger.error(e); }
    finally { setSaving(false); }
  }
  const totalSent    = sequences.reduce((s, q) => s + (q.stats?.sent    || 0), 0);
  const totalReplied = sequences.reduce((s, q) => s + (q.stats?.replied || 0), 0);
  const replyRate    = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;
  return (
    <div>
      {/* Stats strip */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          { label: 'Active',     value: sequences.filter(s => s.active).length, color: 'var(--success, #5BA97B)' },
          { label: 'Msgs sent',  value: totalSent,    color: 'var(--accent-rose, #C76B8A)' },
          { label: 'Reply rate', value: `${replyRate}%`, color: '#7B6BA8' },
        ].map(s => (
          <div key={s.label} style={{ flex: 1, background: 'var(--bg-card, #fff)', borderRadius: 12, padding: '10px 8px', border: '1px solid var(--border-light, #EDE9E4)', textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted, #B5AFA8)', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
        <button
          onClick={() => setShowCreate(true)}
          style={{ padding: '10px 14px', borderRadius: 12, border: 'none', background: 'var(--accent-rose, #C76B8A)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
        >+ New</button>
      </div>
      {/* Sequence cards */}
      {seqLoaded && sequences.length === 0 && !showCreate && (
        <EmptyState
          icon="📨"
          title="No sequences yet"
          subtitle="Build a follow-up flow to keep clients warm after their appointment."
          actionLabel="+ New sequence"
          onAction={() => setShowCreate(true)}
        />
      )}
      {sequences.map(seq => {
        const trigger  = SEQ_TRIGGERS.find(t => t.value === seq.trigger);
        const isOpen   = expanded === seq.id;
        return (
          <div key={seq.id} style={{ background: 'var(--bg-card, #fff)', borderRadius: 14, border: '1px solid var(--border-light, #EDE9E4)', marginBottom: 10, overflow: 'hidden' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, cursor: 'pointer' }}
              onClick={() => setExpanded(isOpen ? null : seq.id)}
            >
              <div style={{ width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, background: seq.active ? 'var(--success-bg, #EDF7F0)' : '#F0ECE8', flexShrink: 0 }}>
                {trigger?.icon || '📨'}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)', marginBottom: 2 }}>{seq.name}</div>
                <div style={{ fontSize: 12, color: '#8B8580' }}>{seq.steps.length} steps · {trigger?.label}</div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 8, background: seq.active ? 'var(--success-bg, #EDF7F0)' : '#F0ECE8', color: seq.active ? '#5BA97B' : '#B5AFA8' }}>
                {seq.active ? 'Active' : 'Paused'}
              </span>
            </div>
            {isOpen && (
              <div style={{ padding: '0 14px 14px', borderTop: '1px solid var(--border-light, #EDE9E4)' }}>
                {/* Steps timeline */}
                <div style={{ paddingTop: 12 }}>
                  {seq.steps.map((step, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <div style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--accent-rose, #C76B8A)', marginTop: 4, flexShrink: 0 }} />
                        {i < seq.steps.length - 1 && <div style={{ width: 1, flex: 1, background: 'var(--border-light, #EDE9E4)', marginTop: 4 }} />}
                      </div>
                      <div style={{ flex: 1, paddingBottom: 4 }}>
                        <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#C76B8A', background: '#FFF0F3', padding: '2px 7px', borderRadius: 6 }}>{formatSeqDelay(step.delay)}</span>
                          <span style={{ fontSize: 10, color: '#8B8580' }}>{step.channel === 'whatsapp' ? '💬' : step.channel === 'sms' ? '📱' : '✉️'} {step.channel}</span>
                        </div>
                        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary, #534247)', lineHeight: 1.5 }}>{step.message}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {/* Stats */}
                <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#8B8580', padding: '8px 0', borderTop: '1px solid var(--border-light, #EDE9E4)', marginTop: 4 }}>
                  <span>{seq.stats?.sent || 0} sent</span>
                  <span>{seq.stats?.opened || 0} opened</span>
                  <span>{seq.stats?.replied || 0} replied</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button onClick={() => handleToggle(seq)} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-light, #EDE9E4)', background: '#FAF8F5', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: '#6B6560' }}>{seq.active ? 'Pause' : 'Activate'}</button>
                  <button onClick={() => handleDelete(seq.id)} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-light, #EDE9E4)', background: '#FAF8F5', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: '#E85D75' }}>Delete</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {/* Create modal */}
      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-end', zIndex: 960 }} onClick={() => setShowCreate(false)}>
          <div style={{ background: 'var(--bg-card, #fff)', borderRadius: '20px 20px 0 0', padding: '20px 16px 40px', width: '100%', maxHeight: '85vh', overflowY: 'auto', boxSizing: 'border-box' }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 16px' }}>New Sequence</h2>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#8B8580', marginBottom: 6 }}>Name</div>
            <input style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border-light, #EDE9E4)', fontSize: 14, fontFamily: 'inherit', outline: 'none', marginBottom: 14, boxSizing: 'border-box' }}
              placeholder="e.g. Post Lamination Care" value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))} />
            <div style={{ fontSize: 12, fontWeight: 700, color: '#8B8580', marginBottom: 6 }}>Trigger</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {SEQ_TRIGGERS.map(t => (
                <button key={t.value} onClick={() => setCreateForm(f => ({ ...f, trigger: t.value }))}
                  style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-light, #EDE9E4)', background: createForm.trigger === t.value ? '#FFF0F3' : '#FAF8F5', color: createForm.trigger === t.value ? '#C76B8A' : '#4A4540', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#8B8580', marginBottom: 8 }}>Steps</div>
            {createForm.steps.map((step, i) => (
              <div key={i} style={{ background: '#FAF8F5', borderRadius: 10, padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <select value={step.delay} onChange={e => setCreateForm(f => ({ ...f, steps: f.steps.map((s, j) => j === i ? { ...s, delay: e.target.value } : s) }))}
                    style={{ flex: 1, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border-light, #EDE9E4)', fontSize: 12, fontFamily: 'inherit', background: 'var(--bg-card, #fff)' }}>
                    {SEQ_DELAYS.map(d => <option key={d} value={d}>{formatSeqDelay(d)}</option>)}
                  </select>
                  <select value={step.channel} onChange={e => setCreateForm(f => ({ ...f, steps: f.steps.map((s, j) => j === i ? { ...s, channel: e.target.value } : s) }))}
                    style={{ flex: 1, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border-light, #EDE9E4)', fontSize: 12, fontFamily: 'inherit', background: 'var(--bg-card, #fff)' }}>
                    {SEQ_CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {createForm.steps.length > 1 && (
                    <button onClick={() => setCreateForm(f => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))}
                      style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-light, #EDE9E4)', background: 'var(--bg-card, #fff)', fontSize: 12, cursor: 'pointer', color: '#E85D75', fontFamily: 'inherit' }}>✕</button>
                  )}
                </div>
                <textarea value={step.message} onChange={e => setCreateForm(f => ({ ...f, steps: f.steps.map((s, j) => j === i ? { ...s, message: e.target.value } : s) }))}
                  placeholder="Message... use {name}, {booking_link} etc."
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-light, #EDE9E4)', fontSize: 12, fontFamily: 'inherit', resize: 'vertical', minHeight: 72, boxSizing: 'border-box', background: 'var(--bg-card, #fff)' }} />
              </div>
            ))}
            <button onClick={() => setCreateForm(f => ({ ...f, steps: [...f.steps, { delay: '24h', channel: 'whatsapp', message: '' }] }))}
              style={{ width: '100%', padding: '10px 0', borderRadius: 10, border: '1px dashed var(--accent-rose, #C76B8A)', background: 'none', color: 'var(--accent-rose, #C76B8A)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 14 }}>
              + Add step
            </button>
            <button onClick={handleCreate} disabled={saving || !createForm.name.trim()}
              style={{ width: '100%', padding: 14, borderRadius: 12, border: 'none', background: 'var(--accent-rose, #C76B8A)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: saving || !createForm.name.trim() ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Create Sequence'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Activity feed - real automation/AI actions from the ai_actions table.
function ActivityPanel({ beautician }) {
  const [actions, setActions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!beautician) { setActions([]); setLoaded(true); return; }
    fetchRows('ai_actions', beautician.id, { order: 'created_at', ascending: false, limit: 50 })
      .then(rows => { setActions(rows || []); setLoaded(true); })
      .catch(() => { setActions([]); setLoaded(true); });
  }, [beautician]);
  if (!loaded) return <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted, #7a7470)' }}>Loading...</div>;
  if (actions.length === 0) {
    return (
      <EmptyState
        icon="📜"
        title="No automation activity yet"
        subtitle="Once your automations start firing, what they do will show up here."
      />
    );
  }
  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  };
  return (
    <div>
      {actions.map(a => (
        <div key={a.id} style={styles.logRow}>
          <div style={{ ...styles.logDot, background: 'var(--success, #5BA97B)' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary, #2D2A26)' }}>{a.summary}</div>
            {a.digital_employee && <div style={{ fontSize: 12, color: 'var(--text-muted, #7a7470)' }}>{a.digital_employee.replace(/_/g, ' ')}</div>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted, #7a7470)' }}>{fmtTime(a.created_at)}</div>
        </div>
      ))}
    </div>
  );
}
