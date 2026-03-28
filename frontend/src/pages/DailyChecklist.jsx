/**
 * Daily Checklist — Start-of-day & end-of-day routine tracker.
 *
 * Solo beauticians juggle a lot before and after clients walk in.
 * This page keeps the routine tight: stock checks, hygiene prep,
 * end-of-day cash-up, social posting — all in one tappable list.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, updateRow, insertRow, isDevMode } from '../lib/supabase.js';
import logger from '../lib/logger.js';

const today = () => new Date().toISOString().slice(0, 10);

const DEV_CHECKLISTS = {
  opening: [
    { id: 'o1', label: 'Sanitise all stations & tools', done: true },
    { id: 'o2', label: 'Check towel stock (clean & folded)', done: true },
    { id: 'o3', label: 'Restock wax pots & tint supplies', done: false },
    { id: 'o4', label: 'Turn on wax heater (15 min warm-up)', done: true },
    { id: 'o5', label: 'Review today\'s appointments', done: true },
    { id: 'o6', label: 'Check for any client notes or flags', done: false },
    { id: 'o7', label: 'Open booking system & confirm walk-in availability', done: false },
    { id: 'o8', label: 'Post "Open Today" story on Instagram', done: false },
  ],
  closing: [
    { id: 'c1', label: 'Sanitise & sterilise all tools', done: false },
    { id: 'c2', label: 'Wipe down stations & mirrors', done: false },
    { id: 'c3', label: 'Empty bins & replace liners', done: false },
    { id: 'c4', label: 'Cash up & reconcile payments', done: false },
    { id: 'c5', label: 'Send follow-up messages to today\'s clients', done: false },
    { id: 'c6', label: 'Check tomorrow\'s bookings & prep notes', done: false },
    { id: 'c7', label: 'Restock low supplies for tomorrow', done: false },
    { id: 'c8', label: 'Lock up & set alarm', done: false },
  ],
  custom: [
    { id: 'x1', label: 'Order HD Brows tint (running low)', done: false, dueDate: '2026-03-26' },
    { id: 'x2', label: 'Reply to Shauna about top-up date', done: false, dueDate: '2026-03-26' },
    { id: 'x3', label: 'Upload before/after from Daisy\'s appointment', done: true, dueDate: '2026-03-25' },
  ],
};

const STREAK_DATA = { current: 5, best: 12, thisWeek: 3, thisMonth: 18 };

export default function DailyChecklist({ token }) {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('opening');
  const [checklists, setChecklists] = useState(DEV_CHECKLISTS);
  const [showAdd, setShowAdd] = useState(false);

  // Fetch daily checklists on mount or when beautician changes
  useEffect(() => {
    if (bLoading || !beautician) return;
    if (isDevMode) {
      setChecklists(DEV_CHECKLISTS);
      return;
    }
    const todayStr = today();
    fetchRows('daily_checklists', beautician.id, { eq: { date: todayStr }, order: 'type', ascending: true })
      .then(rows => {
        if (rows.length === 0) return;
        const byType = {};
        rows.forEach(row => {
          const type = row.type || 'custom';
          if (!byType[type]) byType[type] = [];
          byType[type].push(row);
        });
        setChecklists(prev => ({ ...prev, ...byType }));
      });
  }, [beautician, bLoading]);

  const toggleItem = async (listKey, itemId) => {
    const item = checklists[listKey]?.find(i => i.id === itemId);
    if (!item) return;

    // Optimistic update
    setChecklists(prev => ({
      ...prev,
      [listKey]: prev[listKey].map(i =>
        i.id === itemId ? { ...i, done: !i.done } : i
      ),
    }));

    // Update in DB if not in dev mode
    if (!isDevMode && beautician) {
      try {
        await updateRow('daily_checklists', itemId, { done: !item.done });
      } catch (err) {
        logger.error('Failed to update checklist item:', err);
        // Revert on error
        setChecklists(prev => ({
          ...prev,
          [listKey]: prev[listKey].map(i =>
            i.id === itemId ? { ...i, done: item.done } : i
          ),
        }));
      }
    }
  };

  const currentList = checklists[tab] || [];
  const doneCount = currentList.filter(i => i.done).length;
  const totalCount = currentList.length;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const allOpeningDone = checklists.opening.every(i => i.done);
  const allClosingDone = checklists.closing.every(i => i.done);

  return (
    <div style={S.page}>
      <h1 style={S.title}>Daily Checklist</h1>
      <p style={S.dateLabel}>{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>

      {/* Streak card */}
      <div style={S.streakCard}>
        <div style={S.streakMain}>
          <span style={S.streakFire}>🔥</span>
          <div style={S.streakInfo}>
            <span style={S.streakNum}>{STREAK_DATA.current}-day streak</span>
            <span style={S.streakSub}>Best: {STREAK_DATA.best} days</span>
          </div>
        </div>
        <div style={S.streakStats}>
          <div style={S.streakStat}>
            <span style={S.streakStatNum}>{STREAK_DATA.thisWeek}</span>
            <span style={S.streakStatLabel}>This week</span>
          </div>
          <div style={S.streakStat}>
            <span style={S.streakStatNum}>{STREAK_DATA.thisMonth}</span>
            <span style={S.streakStatLabel}>This month</span>
          </div>
        </div>
      </div>

      {/* Quick status */}
      <div style={S.statusRow}>
        <div style={{ ...S.statusChip, background: allOpeningDone ? '#E8F5E9' : '#FFF5E6' }}>
          <span>{allOpeningDone ? '✅' : '⏳'}</span>
          <span style={{ color: allOpeningDone ? '#4CAF50' : '#B8860B', fontSize: 12, fontWeight: 600 }}>Opening</span>
        </div>
        <div style={{ ...S.statusChip, background: allClosingDone ? '#E8F5E9' : '#F9F7F4' }}>
          <span>{allClosingDone ? '✅' : '🔲'}</span>
          <span style={{ color: allClosingDone ? '#4CAF50' : '#AAA5A0', fontSize: 12, fontWeight: 600 }}>Closing</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {[
          { key: 'opening', label: 'Opening' },
          { key: 'closing', label: 'Closing' },
          { key: 'custom', label: 'Tasks' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{ ...S.tab, ...(tab === t.key ? S.tabActive : {}) }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Progress bar */}
      <div style={S.progressSection}>
        <div style={S.progressTrack}>
          <div style={{ ...S.progressFill, width: `${progress}%` }} />
        </div>
        <span style={S.progressText}>{doneCount}/{totalCount} complete</span>
      </div>

      {/* Checklist items */}
      <div style={S.list}>
        {currentList.map(item => (
          <div key={item.id} style={{ ...S.checkItem, opacity: item.done ? 0.6 : 1 }} onClick={() => toggleItem(tab, item.id)}>
            <div style={{ ...S.checkbox, ...(item.done ? S.checkboxDone : {}) }}>
              {item.done && <span style={S.checkmark}>✓</span>}
            </div>
            <div style={S.checkContent}>
              <span style={{ ...S.checkLabel, textDecoration: item.done ? 'line-through' : 'none' }}>{item.label}</span>
              {item.dueDate && (
                <span style={S.dueDate}>{item.dueDate === today() ? 'Today' : formatDate(item.dueDate)}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* All done celebration */}
      {progress === 100 && (
        <div style={S.celebrationCard}>
          <span style={S.celebrationEmoji}>🎉</span>
          <span style={S.celebrationText}>
            {tab === 'opening' ? 'Ready for the day!' : tab === 'closing' ? 'All wrapped up — see you tomorrow!' : 'All tasks done!'}
          </span>
        </div>
      )}

      {/* Add task (custom tab only) */}
      {tab === 'custom' && !showAdd && (
        <button style={S.addBtn} onClick={() => setShowAdd(true)}>+ Add Task</button>
      )}

      {showAdd && (
        <div style={S.addForm}>
          <input style={S.input} placeholder="What needs doing?" autoFocus />
          <div style={S.addFormRow}>
            <input style={{ ...S.input, flex: 1 }} type="date" defaultValue={today()} />
            <button style={S.addFormSave} onClick={() => setShowAdd(false)}>Add</button>
            <button style={S.addFormCancel} onClick={() => setShowAdd(false)}>✕</button>
          </div>
        </div>
      )}

      {/* Tip card */}
      <div style={S.tipCard}>
        <span style={S.tipIcon}>💡</span>
        <p style={S.tipText}>
          Completing your opening checklist every day keeps your streak going and helps florrie.ai track your salon readiness score.
        </p>
      </div>
    </div>
  );
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 2px' },
  dateLabel: { fontSize: 13, color: '#AAA5A0', margin: '0 0 16px' },

  streakCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 16, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  streakMain: { display: 'flex', gap: 10, alignItems: 'center' },
  streakFire: { fontSize: 28 },
  streakInfo: { display: 'flex', flexDirection: 'column' },
  streakNum: { fontSize: 16, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  streakSub: { fontSize: 12, color: '#AAA5A0' },
  streakStats: { display: 'flex', gap: 14 },
  streakStat: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  streakStatNum: { fontSize: 16, fontWeight: 700, color: '#C76B8A' },
  streakStatLabel: { fontSize: 10, color: '#AAA5A0' },

  statusRow: { display: 'flex', gap: 8, marginBottom: 14 },
  statusChip: { flex: 1, display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center', padding: '8px 0', borderRadius: 10 },

  tabs: { display: 'flex', gap: 8, marginBottom: 12 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: '#AAA5A0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },

  progressSection: { marginBottom: 14 },
  progressTrack: { height: 6, borderRadius: 3, background: '#F0ECE8', overflow: 'hidden', marginBottom: 4 },
  progressFill: { height: '100%', borderRadius: 3, background: '#C76B8A', transition: 'width .3s' },
  progressText: { fontSize: 12, color: '#AAA5A0' },

  list: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 },
  checkItem: { display: 'flex', gap: 12, alignItems: 'center', background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 14px', cursor: 'pointer' },
  checkbox: { width: 24, height: 24, borderRadius: 7, border: '2px solid #D0CBC5', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all .2s' },
  checkboxDone: { background: '#C76B8A', borderColor: '#C76B8A' },
  checkmark: { color: '#fff', fontSize: 14, fontWeight: 700 },
  checkContent: { display: 'flex', flexDirection: 'column', gap: 2 },
  checkLabel: { fontSize: 14, color: 'var(--text, #2D2A26)', lineHeight: 1.3 },
  dueDate: { fontSize: 11, color: '#AAA5A0' },

  celebrationCard: { background: '#E8F5E9', borderRadius: 12, padding: 16, display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 },
  celebrationEmoji: { fontSize: 24 },
  celebrationText: { fontSize: 14, fontWeight: 600, color: '#4CAF50' },

  addBtn: { width: '100%', padding: '12px 0', borderRadius: 10, border: '1px dashed #D0CBC5', background: 'transparent', fontSize: 14, fontWeight: 600, color: '#C76B8A', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 14 },
  addForm: { background: 'var(--card, #fff)', borderRadius: 12, padding: 14, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 },
  addFormRow: { display: 'flex', gap: 8 },
  addFormSave: { padding: '10px 20px', borderRadius: 10, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  addFormCancel: { padding: '10px 14px', borderRadius: 10, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: '#AAA5A0' },
  input: { padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: 'var(--text, #2D2A26)', background: 'var(--card, #fff)' },

  tipCard: { background: '#F9F7F4', borderRadius: 12, padding: 14, display: 'flex', gap: 10, alignItems: 'flex-start' },
  tipIcon: { fontSize: 18, flexShrink: 0 },
  tipText: { fontSize: 12, color: '#8B6F5E', lineHeight: 1.4, margin: 0 },
};
