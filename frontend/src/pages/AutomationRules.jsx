import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow, deleteRow, isDevMode } from '../lib/supabase.js';
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

const mockRules = [
  {
    id: 1, name: 'Welcome new clients', enabled: true,
    trigger: 'new_client', actions: ['send_whatsapp', 'add_tag'],
    conditions: [{ type: 'visit_count', op: 'equals', value: '1' }],
    runs: 47, lastRun: '2 hours ago',
    description: 'Send welcome message + tag as "New" when first appointment completes'
  },
  {
    id: 2, name: 'No-show strike system', enabled: true,
    trigger: 'no_show', actions: ['add_tag', 'send_whatsapp'],
    conditions: [],
    runs: 8, lastRun: 'Yesterday',
    description: 'Tag client as "No-show warning", send policy reminder via WhatsApp'
  },
  {
    id: 3, name: 'Win-back dormant clients', enabled: true,
    trigger: 'dormant_client', actions: ['send_whatsapp', 'apply_discount'],
    conditions: [{ type: 'last_visit', op: 'is more than', value: '42' }],
    runs: 23, lastRun: '3 days ago',
    description: 'After 6 weeks inactive, send 10% off code via WhatsApp'
  },
  {
    id: 4, name: 'Birthday treat', enabled: false,
    trigger: 'birthday', actions: ['send_whatsapp', 'apply_discount'],
    conditions: [],
    runs: 0, lastRun: 'Never',
    description: 'Send birthday message with free brow wax voucher'
  },
  {
    id: 5, name: 'VIP loyalty upgrade', enabled: true,
    trigger: 'loyalty_milestone', actions: ['send_whatsapp', 'add_tag', 'notify_staff'],
    conditions: [{ type: 'loyalty_tier', op: 'is', value: 'VIP' }],
    runs: 5, lastRun: '1 week ago',
    description: 'Welcome to VIP — personal message, tag update, notify Ellie'
  },
];

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

  useEffect(() => {
    if (bLoading) return;
    if (isDevMode || !beautician) { setRules(mockRules); return; }
    fetchRows('automation_rules', beautician.id, { order: 'created_at', ascending: false })
      .then(rows => setRules(rows.length ? rows : mockRules));
  }, [beautician, bLoading]);

  if (bLoading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted, var(--text-muted, #7a7470))' }}>Loading...</div>;

  const toggleRule = async (id) => {
    const rule = rules.find(r => r.id === id);
    if (!rule) return;
    const newEnabled = !rule.enabled;
    setRules(rules.map(r => r.id === id ? { ...r, enabled: newEnabled } : r));
    if (!isDevMode && beautician) {
      try { await updateRow('automation_rules', id, { enabled: newEnabled }); } catch (e) { logger.error(e); }
    }
  };

  const activeCount = rules.filter(r => r.enabled).length;
  const totalRuns = rules.reduce((sum, r) => sum + r.runs, 0);

  const tabs = [
    { id: 'rules', label: `My Rules (${rules.length})` },
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
                style={{
                  ...styles.chip,
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
                style={{
                  ...styles.delayChip,
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
                style={{
                  ...styles.chip,
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
                setRules([{ ...saved, lastRun: 'Never' }, ...rules]);
                setNewRule({ name: '', trigger: null, actions: [], conditions: [], delay: '0' });
                setCreating(false);
              } catch (e) { logger.error('Save rule failed:', e); }
            }}
            style={{
              ...styles.saveRuleBtn,
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
            style={{
              ...styles.tab,
              ...(activeTab === tab.id ? styles.tabActive : {})
            }}
          >{tab.label}</button>
        ))}
      </div>

      {/* Rules list */}
      {activeTab === 'rules' && (
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
                    <span>{rule.actions.map(a => actionOptions.find(o => o.id === a)?.icon).join(' ')}</span>
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); toggleRule(rule.id); }}
                  style={{
                    ...styles.toggle,
                    background: rule.enabled ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, var(--border, #EDE9E4)))'
                  }}
                >
                  <div style={{
                    ...styles.toggleDot,
                    transform: rule.enabled ? 'translateX(18px)' : 'translateX(0)'
                  }} />
                </button>
              </div>
              {expandedRule === rule.id && (
                <div style={styles.ruleExpanded}>
                  <div style={styles.ruleStatRow}>
                    <div style={styles.ruleStatItem}>
                      <div style={{ fontSize: 18, fontWeight: 700 }}>{rule.runs}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted, var(--text-muted, #7a7470))' }}>Total runs</div>
                    </div>
                    <div style={styles.ruleStatItem}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{rule.lastRun}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted, var(--text-muted, #7a7470))' }}>Last fired</div>
                    </div>
                  </div>
                  <div style={styles.ruleActions}>
                    <button style={styles.ruleActionBtn}>✏️ Edit</button>
                    <button style={styles.ruleActionBtn}>📋 Duplicate</button>
                    <button style={{ ...styles.ruleActionBtn, color: '#E85D75' }}>🗑️ Delete</button>
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
          <div style={styles.templatesHint}>Pre-built automations — tap to add and customise</div>
          {templateRules.map((tmpl, i) => (
            <div key={i} style={styles.templateCard}>
              <div style={{ flex: 1 }}>
                <div style={styles.ruleName}>{tmpl.name}</div>
                <div style={styles.ruleDesc}>{tmpl.description}</div>
                <div style={styles.ruleMeta}>
                  <span>{triggerOptions.find(t => t.id === tmpl.trigger)?.icon} {triggerOptions.find(t => t.id === tmpl.trigger)?.label}</span>
                </div>
              </div>
              <button style={styles.useTemplateBtn}>+ Use</button>
            </div>
          ))}
        </div>
      )}

      {/* Activity log */}
      {activeTab === 'log' && (
        <div>
          {[
            { time: '14:32', rule: 'Welcome new clients', client: 'Sophie D.', action: 'WhatsApp sent', status: 'success' },
            { time: '14:32', rule: 'Welcome new clients', client: 'Sophie D.', action: 'Tag "New" added', status: 'success' },
            { time: '12:15', rule: 'No-show strike system', client: 'Danielle W.', action: 'Tag "No-show warning" added', status: 'success' },
            { time: '12:15', rule: 'No-show strike system', client: 'Danielle W.', action: 'WhatsApp policy reminder sent', status: 'success' },
            { time: '09:50', rule: 'Win-back dormant clients', client: 'Hannah J.', action: 'WhatsApp sent with 10% code', status: 'success' },
            { time: 'Yesterday', rule: 'VIP loyalty upgrade', client: 'Katie L.', action: 'WhatsApp VIP welcome sent', status: 'success' },
            { time: 'Yesterday', rule: 'Win-back dormant clients', client: 'Olivia S.', action: 'WhatsApp delivery failed', status: 'failed' },
          ].map((log, i) => (
            <div key={i} style={styles.logRow}>
              <div style={{
                ...styles.logDot,
                background: log.status === 'success' ? 'var(--success, #5BA97B)' : '#E85D75'
              }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary, #2D2A26)' }}>{log.action}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted, var(--text-muted, #7a7470))' }}>{log.rule} · {log.client}</div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted, var(--text-muted, #7a7470))' }}>{log.time}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: '16px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
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
