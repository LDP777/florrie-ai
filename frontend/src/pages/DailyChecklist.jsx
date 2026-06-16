/**
 * Daily Checklist - Stitch M3, fully customisable.
 *
 * Beauticians can:
 *   - Add / delete / reorder items on ANY tab (opening, closing, tasks)
 *   - Save their current list as a reusable template ("Save as My Default")
 *   - Templates auto-seed each new day instead of hardcoded defaults
 *   - Reset to factory defaults at any time
 *
 * Connected data:
 *   - Today's appointment count + expected revenue
 *   - Streak from daily_checklists completion history
 *   - Smart insight adapts to appointment load
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useBeautician, fetchRows, supabase, updateRow, insertRow, deleteRow } from '../lib/supabase.js'
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
const todayStr = () => new Date().toISOString().slice(0, 10);
function MIcon({ name, fill, size, style }) {
  return (
    <span className="material-symbols-outlined" style={{
      fontSize: size || 24,
      fontVariationSettings: fill ? "'FILL' 1, 'wght' 300" : undefined,
      ...style,
    }}>{name}</span>
  );
}
/* ─── Factory default templates ─── */
const FACTORY_OPENING = [
  { label: 'Sanitise all stations & tools', icon: 'sanitizer' },
  { label: 'Check towel stock (clean & folded)', icon: 'dry_cleaning' },
  { label: 'Restock wax pots & tint supplies', icon: 'inventory_2' },
  { label: 'Turn on wax heater (15 min warm-up)', icon: 'device_thermostat' },
  { label: 'Review today\'s appointments', icon: 'calendar_today' },
  { label: 'Check for any client notes or flags', icon: 'flag' },
  { label: 'Open booking system & confirm walk-in availability', icon: 'event_available' },
  { label: 'Post "Open Today" story on Instagram', icon: 'photo_camera' },
];
const FACTORY_CLOSING = [
  { label: 'Sanitise & sterilise all tools', icon: 'sanitizer' },
  { label: 'Wipe down stations & mirrors', icon: 'cleaning_services' },
  { label: 'Empty bins & replace liners', icon: 'delete' },
  { label: 'Cash up & reconcile payments', icon: 'payments' },
  { label: 'Send follow-up messages to today\'s clients', icon: 'chat' },
  { label: 'Check tomorrow\'s bookings & prep notes', icon: 'event_note' },
  { label: 'Restock low supplies for tomorrow', icon: 'inventory' },
  { label: 'Lock up & set alarm', icon: 'lock' },
];
/* ─── Dev-mode sample data ─── */
const DEV_CHECKLISTS = {
  opening: FACTORY_OPENING.map((t, i) => ({
    id: `o${i + 1}`, label: t.label, icon: t.icon, done: i < 4, type: 'opening', sort_order: i,
  })),
  closing: FACTORY_CLOSING.map((t, i) => ({
    id: `c${i + 1}`, label: t.label, icon: t.icon, done: false, type: 'closing', sort_order: i,
  })),
  custom: [
    { id: 'x1', label: 'Order HD Brows tint (running low)', done: false, dueDate: todayStr(), type: 'custom', sort_order: 0 },
    { id: 'x2', label: 'Reply to Shauna about top-up date', done: false, dueDate: todayStr(), type: 'custom', sort_order: 1 },
    { id: 'x3', label: 'Upload before/after from Daisy\'s appointment', done: true, dueDate: todayStr(), type: 'custom', sort_order: 2 },
  ],
};
const DEV_APPOINTMENTS = [
  { id: 1, client_name: 'Shauna', treatment_name: 'Lamination & Hybrid Dye', starts_at: todayStr() + 'T11:00:00', price_cents: 4500 },
  { id: 2, client_name: 'Daisy S', treatment_name: 'Lamination & Tint', starts_at: todayStr() + 'T13:00:00', price_cents: 4000 },
  { id: 3, client_name: 'Jasmin', treatment_name: 'HD Brows', starts_at: todayStr() + 'T15:00:00', price_cents: 2500 },
];
export default function DailyChecklist() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('opening');
  const [checklists, setChecklists] = useState({ opening: [], closing: [], custom: [] });
  const [appointments, setAppointments] = useState([]);
  const [streakDays, setStreakDays] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newDate, setNewDate] = useState(todayStr());
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateToast, setTemplateToast] = useState('');
  useEffect(() => {
    if (bLoading || !beautician) return;
    loadAll();
  }, [beautician, bLoading]);
  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const td = todayStr();
      const [checklistRows, apptRows] = await Promise.all([
        fetchRows('daily_checklists', beautician.id, {
          eq: { date: td }, order: 'sort_order', ascending: true,
        }),
        fetchRows('appointments', beautician.id, {
          order: 'starts_at', ascending: true,
        }),
      ]);
      // Parse checklist rows
      if (checklistRows && checklistRows.length > 0) {
        const byType = { opening: [], closing: [], custom: [] };
        checklistRows.forEach(row => {
          const t = row.type || 'custom';
          if (byType[t]) byType[t].push(row);
          else byType.custom.push(row);
        });
        setChecklists(byType);
      } else {
        // First visit today - load from saved template or factory defaults
        await seedTodayFromTemplate(td);
      }
      // Appointments
      if (apptRows && apptRows.length > 0) {
        const todayAppts = apptRows.filter(a => a.starts_at?.slice(0, 10) === td);
        setAppointments(todayAppts.map(a => ({
          id: a.id,
          client_name: a.clients?.first_name || a.client_name || 'Client',
          treatment_name: a.treatments?.name || a.treatment_name || '',
          starts_at: a.starts_at,
          price_cents: a.price_cents || 0,
        })));
      }
      // Streak
      computeStreak();
    } catch (err) {
      logger.error('Load checklist error:', err);
      setError('Something went wrong loading your checklist');
    } finally {
      setLoading(false);
    }
  }
  async function seedTodayFromTemplate(td) {
    let openingTemplate = FACTORY_OPENING;
    let closingTemplate = FACTORY_CLOSING;
    // Try to load saved template
    if (supabase && beautician) {
      try {
        const { data: templates } = await supabase
          .from('checklist_templates')
          .select('*')
          .eq('beautician_id', beautician.id)
          .order('sort_order', { ascending: true });
        if (templates && templates.length > 0) {
          const savedOpening = templates.filter(t => t.type === 'opening');
          const savedClosing = templates.filter(t => t.type === 'closing');
          if (savedOpening.length > 0) openingTemplate = savedOpening;
          if (savedClosing.length > 0) closingTemplate = savedClosing;
        }
      } catch (err) {
        // Table might not exist yet - fall through to factory defaults
        logger.error('Load templates (non-critical):', err);
      }
    }
    const seeded = { opening: [], closing: [], custom: [] };
    const toInsert = [];
    openingTemplate.forEach((t, i) => {
      const item = {
        id: `temp-o${i}`, label: t.label, icon: t.icon || 'check_circle',
        done: false, type: 'opening', sort_order: i,
      };
      seeded.opening.push(item);
      toInsert.push({
        beautician_id: beautician.id, label: t.label, done: false,
        type: 'opening', date: td, sort_order: i,
      });
    });
    closingTemplate.forEach((t, i) => {
      const item = {
        id: `temp-c${i}`, label: t.label, icon: t.icon || 'check_circle',
        done: false, type: 'closing', sort_order: i,
      };
      seeded.closing.push(item);
      toInsert.push({
        beautician_id: beautician.id, label: t.label, done: false,
        type: 'closing', date: td, sort_order: i,
      });
    });
    setChecklists(seeded);
    // Bulk insert in background
    if (supabase && toInsert.length > 0) {
      try {
        const { data } = await supabase.from('daily_checklists').insert(toInsert).select();
        if (data) {
          const byType = { opening: [], closing: [], custom: [] };
          data.forEach(row => {
            const t = row.type || 'custom';
            if (byType[t]) byType[t].push(row);
          });
          setChecklists(prev => ({
            opening: byType.opening.length ? byType.opening : prev.opening,
            closing: byType.closing.length ? byType.closing : prev.closing,
            custom: prev.custom,
          }));
        }
      } catch (err) {
        logger.error('Seed checklists error:', err);
      }
    }
  }
  async function computeStreak() {
    if (!supabase || !beautician) return;
    try {
      const { data: recentDays } = await supabase
        .from('daily_checklists')
        .select('date, done, type')
        .eq('beautician_id', beautician.id)
        .eq('type', 'opening')
        .order('date', { ascending: false })
        .limit(500);
      if (!recentDays) return;
      const dayMap = {};
      recentDays.forEach(r => {
        if (!dayMap[r.date]) dayMap[r.date] = { total: 0, done: 0 };
        dayMap[r.date].total++;
        if (r.done) dayMap[r.date].done++;
      });
      const dates = Object.keys(dayMap).sort().reverse();
      let streak = 0;
      let best = 0;
      let runStreak = 0;
      for (const d of dates) {
        const day = dayMap[d];
        if (day.total > 0 && day.done === day.total) {
          runStreak++;
          if (d >= todayStr() || streak === runStreak - 1) streak = runStreak;
        } else {
          if (runStreak > best) best = runStreak;
          runStreak = 0;
        }
      }
      if (runStreak > best) best = runStreak;
      setStreakDays(streak);
      setBestStreak(best);
    } catch (err) {
      logger.error('Streak compute error:', err);
    }
  }
  const toggleItem = async (listKey, itemId) => {
    if (editing) return; // Don't toggle in edit mode
    const item = checklists[listKey]?.find(i => i.id === itemId);
    if (!item) return;
    setChecklists(prev => ({
      ...prev,
      [listKey]: prev[listKey].map(i =>
        i.id === itemId ? { ...i, done: !i.done } : i
      ),
    }));
    if (beautician && !String(itemId).startsWith('temp-')) {
      try {
        await updateRow('daily_checklists', itemId, { done: !item.done });
      } catch (err) {
        logger.error('Toggle error:', err);
        setChecklists(prev => ({
          ...prev,
          [listKey]: prev[listKey].map(i =>
            i.id === itemId ? { ...i, done: item.done } : i
          ),
        }));
      }
    }
  };
  const handleAddItem = async () => {
    const label = newLabel.trim();
    if (!label) return;
    const targetTab = tab;
    const dueDate = targetTab === 'custom' ? (newDate || todayStr()) : todayStr();
    const sortOrder = (checklists[targetTab]?.length || 0);
    const tempId = 'new-' + Date.now();
    const newItem = {
      id: tempId, label, done: false, type: targetTab,
      dueDate, sort_order: sortOrder, icon: 'check_circle',
    };
    setChecklists(prev => ({
      ...prev,
      [targetTab]: [...prev[targetTab], newItem],
    }));
    setNewLabel('');
    setNewDate(todayStr());
    setShowAdd(false);
    if (beautician) {
      try {
        const row = await insertRow('daily_checklists', {
          beautician_id: beautician.id, label, done: false,
          type: targetTab, date: dueDate, sort_order: sortOrder,
        });
        if (row) {
          setChecklists(prev => ({
            ...prev,
            [targetTab]: prev[targetTab].map(i =>
              i.id === tempId ? { ...row, label: row.label, done: row.done, dueDate: row.date, sort_order: row.sort_order } : i
            ),
          }));
        }
      } catch (err) {
        logger.error('Add item error:', err);
      }
    }
  };
  const handleDeleteItem = async (listKey, itemId) => {
    const prev = checklists[listKey];
    setChecklists(p => ({
      ...p,
      [listKey]: p[listKey].filter(i => i.id !== itemId),
    }));
    if (!String(itemId).startsWith('temp-') && !String(itemId).startsWith('new-')) {
      try {
        await deleteRow('daily_checklists', itemId);
      } catch (err) {
        logger.error('Delete item error:', err);
        setChecklists(p => ({ ...p, [listKey]: prev }));
      }
    }
  };
  const handleMove = async (listKey, index, direction) => {
    const list = [...checklists[listKey]];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= list.length) return;
    // Swap
    [list[index], list[targetIndex]] = [list[targetIndex], list[index]];
    // Update sort_order
    const updated = list.map((item, i) => ({ ...item, sort_order: i }));
    setChecklists(prev => ({ ...prev, [listKey]: updated }));
    // Persist sort order for both swapped items
    if (beautician) {
      const a = updated[index];
      const b = updated[targetIndex];
      const promises = [];
      if (!String(a.id).startsWith('temp-') && !String(a.id).startsWith('new-')) {
        promises.push(updateRow('daily_checklists', a.id, { sort_order: a.sort_order }));
      }
      if (!String(b.id).startsWith('temp-') && !String(b.id).startsWith('new-')) {
        promises.push(updateRow('daily_checklists', b.id, { sort_order: b.sort_order }));
      }
      try { await Promise.all(promises); } catch (err) { logger.error('Reorder error:', err); }
    }
  };
  const handleSaveAsTemplate = async () => {
    setTemplateSaving(true);
    try {
      if (!supabase || !beautician) return;
      // Delete existing templates for this beautician
      await supabase
        .from('checklist_templates')
        .delete()
        .eq('beautician_id', beautician.id);
      // Insert current opening + closing as templates
      const rows = [];
      checklists.opening.forEach((item, i) => {
        rows.push({
          beautician_id: beautician.id,
          type: 'opening',
          label: item.label,
          icon: item.icon || 'check_circle',
          sort_order: i,
        });
      });
      checklists.closing.forEach((item, i) => {
        rows.push({
          beautician_id: beautician.id,
          type: 'closing',
          label: item.label,
          icon: item.icon || 'check_circle',
          sort_order: i,
        });
      });
      if (rows.length > 0) {
        const { error: insertErr } = await supabase
          .from('checklist_templates')
          .insert(rows);
        if (insertErr) throw insertErr;
      }
      setTemplateToast('Template saved - tomorrow will use this list');
      setTimeout(() => setTemplateToast(''), 3000);
    } catch (err) {
      logger.error('Save template error:', err);
      setTemplateToast('Failed to save - try again');
      setTimeout(() => setTemplateToast(''), 3000);
    } finally {
      setTemplateSaving(false);
    }
  };
  const handleResetToFactory = async () => {
    const td = todayStr();
    // Delete all of today's opening/closing items
    if (supabase && beautician) {
      try {
        await supabase
          .from('daily_checklists')
          .delete()
          .eq('beautician_id', beautician.id)
          .eq('date', td)
          .in('type', ['opening', 'closing']);
      } catch (err) {
        logger.error('Reset delete error:', err);
      }
    }
    // Re-seed from factory
    const newOpening = FACTORY_OPENING.map((t, i) => ({
      id: `temp-o${i}`, label: t.label, icon: t.icon, done: false, type: 'opening', sort_order: i,
    }));
    const newClosing = FACTORY_CLOSING.map((t, i) => ({
      id: `temp-c${i}`, label: t.label, icon: t.icon, done: false, type: 'closing', sort_order: i,
    }));
    setChecklists(prev => ({ ...prev, opening: newOpening, closing: newClosing }));
    // Insert factory items into DB
    if (supabase && beautician) {
      const toInsert = [];
      FACTORY_OPENING.forEach((t, i) => {
        toInsert.push({ beautician_id: beautician.id, label: t.label, done: false, type: 'opening', date: td, sort_order: i });
      });
      FACTORY_CLOSING.forEach((t, i) => {
        toInsert.push({ beautician_id: beautician.id, label: t.label, done: false, type: 'closing', date: td, sort_order: i });
      });
      try {
        const { data } = await supabase.from('daily_checklists').insert(toInsert).select();
        if (data) {
          const byType = { opening: [], closing: [] };
          data.forEach(row => { if (byType[row.type]) byType[row.type].push(row); });
          setChecklists(prev => ({
            ...prev,
            opening: byType.opening.length ? byType.opening : prev.opening,
            closing: byType.closing.length ? byType.closing : prev.closing,
          }));
        }
      } catch (err) {
        logger.error('Reset insert error:', err);
      }
    }
    // Also clear saved template
    if (supabase && beautician) {
      try {
        await supabase.from('checklist_templates').delete().eq('beautician_id', beautician.id);
      } catch (err) {
        logger.error('Clear template error:', err);
      }
    }
    setTemplateToast('Reset to defaults');
    setTimeout(() => setTemplateToast(''), 2500);
  };
  const currentList = checklists[tab] || [];
  const doneCount = currentList.filter(i => i.done).length;
  const totalCount = currentList.length;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  const allOpeningDone = checklists.opening.length > 0 && checklists.opening.every(i => i.done);
  const allClosingDone = checklists.closing.length > 0 && checklists.closing.every(i => i.done);
  const todayInsights = useMemo(() => {
    const apptCount = appointments.length;
    const expectedRevenue = appointments.reduce((sum, a) => sum + (a.price_cents || 0), 0);
    const nextAppt = appointments.find(a => new Date(a.starts_at) > new Date());
    const nextTime = nextAppt
      ? new Date(nextAppt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : null;
    return { apptCount, expectedRevenue, nextAppt, nextTime };
  }, [appointments]);
  const iconForItem = (item) => {
    const allDefaults = [...FACTORY_OPENING, ...FACTORY_CLOSING];
    const match = allDefaults.find(d => d.label === item.label);
    return match?.icon || item.icon || 'check_circle';
  };
  if (bLoading || loading) return <PageLoader />;
  return (
    <div style={S.page}>
      {error && <ErrorCard message={error} onDismiss={() => setError(null)} />}
      {/* ─── Header + Edit toggle ─── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 2 }}>
        <h1 style={S.pageTitle}>Daily Checklist</h1>
        <button
          onClick={() => { setEditing(e => !e); setShowAdd(false); }}
          style={{
            ...S.editToggle,
            background: editing ? '#92405e' : 'rgba(146, 64, 94, 0.08)',
            color: editing ? '#fff' : '#92405e',
          }}
        >
          <MIcon name={editing ? 'check' : 'edit'} size={16} style={{ color: editing ? '#fff' : '#92405e' }} />
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>
      <p style={S.dateLabel}>
        {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
      </p>
      {/* ─── Template toast ─── */}
      {templateToast && (
        <div style={S.toast}>
          <MIcon name="check_circle" fill size={16} style={{ color: '#5ba97b' }} />
          {templateToast}
        </div>
      )}
      {/* ─── Today's Overview Card ─── */}
      {!editing && (
        <section style={S.overviewCard}>
          <div style={S.overviewDecor} />
          <div style={{ position: 'relative', zIndex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <MIcon name="today" fill size={16} style={{ color: 'rgba(255,255,255,0.8)' }} />
              <span style={S.overviewLabel}>Today's Overview</span>
            </div>
            <div style={{ display: 'flex', gap: 24, alignItems: 'baseline' }}>
              <div>
                <span style={S.overviewBig}>{todayInsights.apptCount}</span>
                <span style={S.overviewUnit}> client{todayInsights.apptCount !== 1 ? 's' : ''}</span>
              </div>
              <div>
                <span style={S.overviewBig}>
                  £{(todayInsights.expectedRevenue / 100).toFixed(0)}
                </span>
                <span style={S.overviewUnit}> expected</span>
              </div>
            </div>
            {todayInsights.nextAppt && (
              <p style={S.overviewSub}>
                Next: {todayInsights.nextAppt.client_name} at {todayInsights.nextTime} - {todayInsights.nextAppt.treatment_name}
              </p>
            )}
          </div>
          <div style={S.overviewIcon}>
            <MIcon name="checklist" size={64} style={{ opacity: 0.15, color: '#fff' }} />
          </div>
        </section>
      )}
      {/* ─── Edit mode banner ─── */}
      {editing && (
        <section style={S.editBanner}>
          <MIcon name="edit_note" size={20} style={{ color: '#92405e' }} />
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: '#1d1b19', margin: 0 }}>Editing Mode</p>
            <p style={{ fontSize: 11, color: '#867277', margin: '2px 0 0' }}>
              Add, remove, or reorder items. Save as template for future days.
            </p>
          </div>
        </section>
      )}
      {/* ─── Streak + Status Row (hide in edit mode) ─── */}
      {!editing && (
        <section style={S.streakRow}>
          <div style={S.streakCard}>
            <MIcon name="local_fire_department" fill size={22} style={{ color: streakDays > 0 ? '#E8753A' : '#867277' }} />
            <div>
              <span style={S.streakNum}>{streakDays}</span>
              <span style={S.streakLabel}> day streak</span>
            </div>
            {bestStreak > 0 && <span style={S.streakBest}>Best: {bestStreak}</span>}
          </div>
          <div style={S.statusPills}>
            <div style={{
              ...S.statusPill,
              background: allOpeningDone ? 'rgba(91,169,123,0.12)' : 'rgba(254,219,155,0.4)',
              borderColor: allOpeningDone ? 'rgba(91,169,123,0.15)' : 'rgba(116,90,39,0.1)',
            }}>
              <MIcon name={allOpeningDone ? 'check_circle' : 'schedule'} fill size={14}
                style={{ color: allOpeningDone ? 'var(--success, #5ba97b)' : '#745a27' }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: allOpeningDone ? 'var(--success, #5ba97b)' : '#745a27' }}>
                Open
              </span>
            </div>
            <div style={{
              ...S.statusPill,
              background: allClosingDone ? 'rgba(91,169,123,0.12)' : 'rgba(146,64,94,0.06)',
              borderColor: allClosingDone ? 'rgba(91,169,123,0.15)' : 'rgba(146,64,94,0.08)',
            }}>
              <MIcon name={allClosingDone ? 'check_circle' : 'radio_button_unchecked'} fill={allClosingDone} size={14}
                style={{ color: allClosingDone ? 'var(--success, #5ba97b)' : '#867277' }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: allClosingDone ? 'var(--success, #5ba97b)' : '#867277' }}>
                Close
              </span>
            </div>
          </div>
        </section>
      )}
      {/* ─── Tab Bar ─── */}
      <div style={S.tabBar}>
        {[
          { key: 'opening', label: 'Opening', icon: 'wb_sunny' },
          { key: 'closing', label: 'Closing', icon: 'nightlight' },
          { key: 'custom', label: 'Tasks', icon: 'task_alt' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setShowAdd(false); }}
            style={{ ...S.tab, ...(tab === t.key ? S.tabActive : {}) }}
          >
            <MIcon name={t.icon} fill={tab === t.key} size={16}
              style={{ color: tab === t.key ? '#fff' : '#867277' }} />
            {t.label}
            {editing && <span style={{
              fontSize: 9, fontWeight: 700, marginLeft: 2,
              background: 'rgba(255,255,255,0.25)', borderRadius: 4,
              padding: '1px 4px', color: tab === t.key ? '#fff' : '#867277',
            }}>{checklists[t.key]?.length || 0}</span>}
          </button>
        ))}
      </div>
      {/* ─── Progress Bar (hide in edit mode) ─── */}
      {!editing && (
        <div style={S.progressSection}>
          <div style={S.progressTrack}>
            <div style={{
              ...S.progressFill,
              width: `${progress}%`,
              background: progress === 100
                ? 'linear-gradient(90deg, #5ba97b 0%, #78c99b 100%)'
                : 'linear-gradient(90deg, #c76b8a 0%, #92405e 100%)',
            }} />
          </div>
          <span style={S.progressText}>{doneCount}/{totalCount} complete</span>
        </div>
      )}
      {/* ─── Checklist Items ─── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
        {currentList.length === 0 && (
          <EmptyState
            message={editing ? 'No items yet - tap the button below to add one' : 'No checklist items'}
            icon="📋"
          />
        )}
        {currentList.map((item, index) => (
          <div
            key={item.id}
            style={{
              ...S.checkItem,
              opacity: !editing && item.done ? 0.55 : 1,
              paddingRight: editing ? 8 : 14,
            }}
          >
            {/* ── Normal mode: checkbox ── */}
            {!editing && (
              <div
                onClick={() => toggleItem(tab, item.id)}
                style={{ ...S.checkbox, ...(item.done ? S.checkboxDone : {}), cursor: 'pointer' }}
              >
                {item.done && <MIcon name="check" size={15} style={{ color: '#fff' }} />}
              </div>
            )}
            {/* ── Edit mode: reorder arrows ── */}
            {editing && (
              <div style={S.reorderCol}>
                <button
                  onClick={() => handleMove(tab, index, -1)}
                  disabled={index === 0}
                  style={{ ...S.arrowBtn, opacity: index === 0 ? 0.25 : 1 }}
                >
                  <MIcon name="keyboard_arrow_up" size={18} />
                </button>
                <button
                  onClick={() => handleMove(tab, index, 1)}
                  disabled={index === currentList.length - 1}
                  style={{ ...S.arrowBtn, opacity: index === currentList.length - 1 ? 0.25 : 1 }}
                >
                  <MIcon name="keyboard_arrow_down" size={18} />
                </button>
              </div>
            )}
            <div
              style={{ flex: 1, minWidth: 0, cursor: editing ? 'default' : 'pointer' }}
              onClick={() => !editing && toggleItem(tab, item.id)}
            >
              <span style={{
                ...S.checkLabel,
                textDecoration: !editing && item.done ? 'line-through' : 'none',
              }}>
                {item.label}
              </span>
              {item.dueDate && item.dueDate !== todayStr() && (
                <span style={S.dueDate}>{formatDate(item.dueDate)}</span>
              )}
            </div>
            {/* ── Normal mode: icon ── */}
            {!editing && (
              <MIcon name={iconForItem(item)} size={18}
                style={{ color: item.done ? '#867277' : 'rgba(146,64,94,0.35)' }} />
            )}
            {/* ── Edit mode: delete button ── */}
            {editing && (
              <button
                onClick={(e) => { e.stopPropagation(); handleDeleteItem(tab, item.id); }}
                style={S.deleteBtn}
              >
                <MIcon name="close" size={16} style={{ color: '#ba1a1a' }} />
              </button>
            )}
          </div>
        ))}
      </div>
      {/* ─── All done celebration (normal mode) ─── */}
      {!editing && progress === 100 && totalCount > 0 && (
        <section style={S.celebrationCard}>
          <MIcon name="celebration" fill size={24} style={{ color: '#5ba97b' }} />
          <span style={S.celebrationText}>
            {tab === 'opening' ? 'Ready for the day!' : tab === 'closing' ? 'All wrapped up - see you tomorrow!' : 'All tasks done!'}
          </span>
        </section>
      )}
      {/* ─── Add Item (available on ALL tabs now) ─── */}
      {!showAdd && (
        <button style={S.addBtn} onClick={() => setShowAdd(true)}>
          <MIcon name="add" size={16} style={{ color: '#92405e' }} />
          Add {tab === 'opening' ? 'Opening' : tab === 'closing' ? 'Closing' : ''} Item
        </button>
      )}
      {showAdd && (
        <section style={S.addForm}>
          <input
            style={S.formInput}
            placeholder={tab === 'custom' ? 'What needs doing?' : `New ${tab} task...`}
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddItem()}
            autoFocus
          />
          <div style={{ display: 'flex', gap: 8 }}>
            {tab === 'custom' && (
              <input
                style={{ ...S.formInput, flex: 1 }}
                type="date"
                value={newDate}
                onChange={e => setNewDate(e.target.value)}
              />
            )}
            <button onClick={handleAddItem} style={S.saveBtn}>Add</button>
            <button onClick={() => { setShowAdd(false); setNewLabel(''); }} style={S.cancelBtn}>
              <MIcon name="close" size={16} />
            </button>
          </div>
        </section>
      )}
      {/* ─── Template Actions (edit mode only) ─── */}
      {editing && (tab === 'opening' || tab === 'closing') && (
        <section style={S.templateActions}>
          <p style={{ fontSize: 11, color: '#867277', margin: '0 0 10px', lineHeight: 1.4 }}>
            Save your current {tab} list as a template - it'll auto-load every day instead of the defaults.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleSaveAsTemplate}
              disabled={templateSaving}
              style={{ ...S.saveBtn, flex: 1, opacity: templateSaving ? 0.6 : 1 }}
            >
              <MIcon name="bookmark" size={15} style={{ color: '#fff', marginRight: 4 }} />
              {templateSaving ? 'Saving...' : 'Save as My Default'}
            </button>
            <button onClick={handleResetToFactory} style={{ ...S.cancelBtn, flex: 'none', padding: '10px 14px' }}>
              <MIcon name="restart_alt" size={15} style={{ color: '#534247', marginRight: 4 }} />
              Reset
            </button>
          </div>
        </section>
      )}
      {/* ─── Insights Card (normal mode) ─── */}
      {!editing && (
        <section style={S.insightsCard}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={S.insightsIconWrap}>
              <MIcon name="lightbulb" size={20} style={{ color: '#fff' }} />
            </div>
            <div>
              <h4 style={S.insightsTitle}>Daily Insight</h4>
              <p style={S.insightsText}>
                {todayInsights.apptCount === 0
                  ? 'No appointments today - great time to restock supplies, update your portfolio, or prep marketing content.'
                  : todayInsights.apptCount >= 4
                    ? `Busy day ahead with ${todayInsights.apptCount} clients and £${(todayInsights.expectedRevenue / 100).toFixed(0)} on the books. Make sure supplies are prepped before your first at ${todayInsights.nextTime || 'soon'}.`
                    : `${todayInsights.apptCount} appointment${todayInsights.apptCount > 1 ? 's' : ''} today - you have time between clients to handle your tasks list.`
                }
              </p>
            </div>
          </div>
        </section>
      )}
      {/* ─── Today's Clients (normal mode) ─── */}
      {!editing && appointments.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <div style={S.sectionHeader}>
            <h3 style={S.sectionHeading}>Today's Clients</h3>
            <span style={S.seeAll}>{appointments.length} total</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {appointments.slice(0, 4).map(apt => {
              const time = new Date(apt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
              return (
                <div key={apt.id} style={S.apptRow}>
                  <div style={{ textAlign: 'center', flexShrink: 0, width: 40 }}>
                    <p style={{ fontSize: 13, fontWeight: 700, color: '#92405e', margin: 0 }}>{time}</p>
                  </div>
                  <div style={S.apptDivider} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, color: '#1d1b19', margin: 0 }}>{apt.client_name}</p>
                    <p style={{ fontSize: 11, color: '#867277', margin: 0 }}>{apt.treatment_name}</p>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#745a27' }}>
                    £{(apt.price_cents / 100).toFixed(0)}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
const S = {
  page: {
    minHeight: '100vh',
    background: '#fef8f4',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    padding: '16px 24px 120px',
    maxWidth: 480, margin: '0 auto', color: '#1d1b19',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  pageTitle: {
    fontFamily: "var(--font-display, 'Playfair Display', serif)",
    fontSize: 24, fontStyle: 'italic', fontWeight: 400,
    color: '#92405e', margin: 0,
  },
  dateLabel: { fontSize: 13, color: '#867277', margin: '0 0 16px' },
  // Edit toggle
  editToggle: {
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '7px 14px', borderRadius: 12,
    border: 'none', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
    transition: 'all 0.2s ease',
  },
  // Toast
  toast: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: '#fff', borderRadius: 12, padding: '10px 16px',
    marginBottom: 12, fontSize: 13, fontWeight: 500, color: '#1d1b19',
    border: '1px solid rgba(91, 169, 123, 0.15)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
    animation: 'fadeIn 0.2s ease',
  },
  // Edit banner
  editBanner: {
    display: 'flex', gap: 12, alignItems: 'center',
    background: 'rgba(146, 64, 94, 0.06)',
    border: '1px solid rgba(146, 64, 94, 0.1)',
    borderRadius: 16, padding: 14, marginBottom: 16,
  },
  // Overview card
  overviewCard: {
    position: 'relative', overflow: 'hidden',
    background: 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',
    color: '#fff', borderRadius: 24, padding: 24, marginBottom: 16,
    boxShadow: '0 8px 32px rgba(146, 64, 94, 0.15)',
  },
  overviewDecor: {
    position: 'absolute', top: 0, right: 0,
    width: 128, height: 128,
    background: 'rgba(255,255,255,0.1)',
    borderRadius: '50%', marginRight: -64, marginTop: -64,
    filter: 'blur(32px)',
  },
  overviewIcon: { position: 'absolute', bottom: 16, right: 24 },
  overviewLabel: {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em',
    fontWeight: 700, opacity: 0.8,
  },
  overviewBig: {
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em',
  },
  overviewUnit: { fontSize: 14, opacity: 0.8, fontWeight: 500 },
  overviewSub: {
    fontSize: 13, opacity: 0.85, lineHeight: 1.4, margin: '10px 0 0', maxWidth: '85%',
  },
  // Streak row
  streakRow: { display: 'flex', gap: 10, marginBottom: 16, alignItems: 'stretch' },
  streakCard: {
    flex: 1, background: '#fff', borderRadius: 16, padding: '12px 14px',
    display: 'flex', alignItems: 'center', gap: 10,
    border: '1px solid rgba(146, 64, 94, 0.05)',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.04)',
  },
  streakNum: {
    fontSize: 18, fontWeight: 700, color: '#1d1b19',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
  },
  streakLabel: { fontSize: 12, color: '#867277', fontWeight: 500 },
  streakBest: {
    fontSize: 10, color: '#867277', marginLeft: 'auto',
    background: 'rgba(146, 64, 94, 0.06)', padding: '3px 8px', borderRadius: 8,
  },
  statusPills: { display: 'flex', flexDirection: 'column', gap: 6 },
  statusPill: {
    display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center',
    padding: '8px 14px', borderRadius: 12,
    border: '1px solid transparent',
  },
  // Tab bar
  tabBar: {
    display: 'flex', gap: 4,
    background: '#f3ede9', borderRadius: 14, padding: 4,
    marginBottom: 16,
  },
  tab: {
    flex: 1, padding: '9px 0', fontSize: 12, fontWeight: 500,
    border: 'none', borderRadius: 11, cursor: 'pointer',
    fontFamily: 'inherit', background: 'none', color: '#867277',
    transition: 'all 0.2s ease',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
  },
  tabActive: {
    background: '#92405e', color: '#fff',
    boxShadow: '0 2px 8px rgba(146, 64, 94, 0.2)',
    fontWeight: 600,
  },
  // Progress
  progressSection: { marginBottom: 16 },
  progressTrack: {
    height: 6, borderRadius: 3,
    background: 'rgba(146, 64, 94, 0.08)',
    overflow: 'hidden', marginBottom: 4,
  },
  progressFill: { height: '100%', borderRadius: 3, transition: 'width 0.3s ease' },
  progressText: { fontSize: 11, color: '#867277', fontWeight: 500 },
  // Checklist items
  checkItem: {
    display: 'flex', gap: 10, alignItems: 'center',
    background: '#fff', borderRadius: 14, padding: '13px 14px',
    transition: 'opacity 0.2s ease',
    border: '1px solid rgba(146, 64, 94, 0.04)',
    boxShadow: '0 1px 2px rgba(146, 64, 94, 0.03)',
  },
  checkbox: {
    width: 24, height: 24, borderRadius: 8,
    border: '2px solid rgba(146, 64, 94, 0.2)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'all 0.2s ease',
  },
  checkboxDone: { background: '#92405e', borderColor: '#92405e' },
  checkLabel: { fontSize: 14, color: '#1d1b19', lineHeight: 1.35, display: 'block' },
  dueDate: { fontSize: 11, color: '#867277', display: 'block', marginTop: 2 },
  // Reorder arrows
  reorderCol: {
    display: 'flex', flexDirection: 'column', gap: 0, flexShrink: 0,
  },
  arrowBtn: {
    background: 'none', border: 'none', padding: 0,
    cursor: 'pointer', color: '#92405e', lineHeight: 1,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  // Delete button
  deleteBtn: {
    background: 'rgba(186, 26, 26, 0.06)', border: 'none',
    borderRadius: 10, width: 32, height: 32,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', flexShrink: 0,
    transition: 'background 0.15s ease',
  },
  // Celebration
  celebrationCard: {
    background: 'rgba(91, 169, 123, 0.1)',
    border: '1px solid rgba(91, 169, 123, 0.12)',
    borderRadius: 16, padding: 16,
    display: 'flex', gap: 12, alignItems: 'center',
    marginBottom: 16,
  },
  celebrationText: { fontSize: 14, fontWeight: 600, color: '#5ba97b' },
  // Add item
  addBtn: {
    width: '100%', padding: '12px 0', borderRadius: 14,
    border: '1.5px dashed rgba(146, 64, 94, 0.15)',
    background: 'transparent', fontSize: 13, fontWeight: 600,
    color: '#92405e', cursor: 'pointer', fontFamily: 'inherit',
    marginBottom: 16,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  addForm: {
    background: '#fff', borderRadius: 16, padding: 14, marginBottom: 16,
    display: 'flex', flexDirection: 'column', gap: 8,
    border: '1px solid rgba(146, 64, 94, 0.06)',
    boxShadow: '0 2px 8px rgba(146, 64, 94, 0.06)',
  },
  formInput: {
    width: '100%', padding: '11px 14px', borderRadius: 12,
    border: '1.5px solid #d8c1c6', fontSize: 14,
    fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
    background: '#f8f2ef', color: '#1d1b19',
    transition: 'border-color 0.2s ease',
  },
  saveBtn: {
    padding: '11px 20px', borderRadius: 12, border: 'none',
    background: '#92405e', color: '#fff', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
    boxShadow: '0 2px 8px rgba(146, 64, 94, 0.25)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  cancelBtn: {
    padding: '11px 14px', borderRadius: 12, border: 'none',
    background: '#f3ede9', color: '#534247', fontSize: 13,
    cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  // Template actions
  templateActions: {
    background: 'rgba(146, 64, 94, 0.04)',
    border: '1px solid rgba(146, 64, 94, 0.08)',
    borderRadius: 16, padding: 16, marginBottom: 16,
  },
  // Insights card
  insightsCard: {
    background: 'rgba(254, 219, 155, 0.35)',
    border: '1px solid rgba(116, 90, 39, 0.1)',
    borderRadius: 16, padding: 18, marginBottom: 24,
  },
  insightsIconWrap: {
    width: 36, height: 36, borderRadius: '50%',
    background: '#745a27',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  insightsTitle: { fontSize: 13, fontWeight: 700, color: '#795f2b', margin: '0 0 4px' },
  insightsText: {
    fontSize: 12, color: 'rgba(121, 95, 43, 0.8)',
    lineHeight: 1.5, fontStyle: 'italic', margin: 0,
  },
  // Section headers
  sectionHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
    marginBottom: 10,
  },
  sectionHeading: {
    fontFamily: "var(--font-display, 'Playfair Display', serif)",
    fontSize: 18, fontStyle: 'italic', fontWeight: 400,
    color: '#92405e', margin: 0,
  },
  seeAll: {
    fontSize: 10, fontWeight: 700, color: '#867277',
    textTransform: 'uppercase', letterSpacing: '0.12em',
  },
  // Appointment rows
  apptRow: {
    background: '#f8f2ef', padding: 14, borderRadius: 14,
    display: 'flex', alignItems: 'center', gap: 12,
  },
  apptDivider: {
    height: 28, width: 1, background: 'rgba(146, 64, 94, 0.15)',
  },
};
