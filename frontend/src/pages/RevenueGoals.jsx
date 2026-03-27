/**
 * Revenue Goals — Monthly targets with visual progress tracking.
 *
 * Solo beauticians rarely track against a number. This page gives
 * them a clear target, shows daily/weekly pace, and projects whether
 * they'll hit it based on current bookings.
 */
import { useState } from 'react';
import { isDevMode } from '../lib/supabase.js';

const fmt = (cents) => `£${(cents / 100).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const DEV_GOALS = {
  current: {
    month: 'March 2026',
    target: 450000,
    earned: 312500,
    booked: 87500, // future bookings this month
    daysTotal: 31,
    daysPassed: 26,
    workingDays: 23,
    workingDaysPassed: 19,
  },
  breakdown: [
    { label: 'Brow treatments', earned: 145000, target: 200000 },
    { label: 'Lash treatments', earned: 82500, target: 100000 },
    { label: 'Semi-permanent', earned: 55000, target: 100000 },
    { label: 'Retail & add-ons', earned: 30000, target: 50000 },
  ],
  history: [
    { month: 'Feb 2026', target: 400000, actual: 425000, hit: true },
    { month: 'Jan 2026', target: 400000, actual: 378000, hit: false },
    { month: 'Dec 2025', target: 350000, actual: 410000, hit: true },
    { month: 'Nov 2025', target: 350000, actual: 342000, hit: false },
    { month: 'Oct 2025', target: 300000, actual: 335000, hit: true },
  ],
  weeklyPace: [
    { week: 'W1 (1-7)', earned: 68000 },
    { week: 'W2 (8-14)', earned: 82000 },
    { week: 'W3 (15-21)', earned: 95000 },
    { week: 'W4 (22-26)', earned: 67500 },
  ],
};

export default function RevenueGoals({ token }) {
  const [tab, setTab] = useState('progress');
  const [showSetGoal, setShowSetGoal] = useState(false);

  const g = DEV_GOALS.current;
  const percent = Math.round((g.earned / g.target) * 100);
  const projected = g.workingDaysPassed > 0
    ? Math.round((g.earned / g.workingDaysPassed) * g.workingDays)
    : 0;
  const projectedPercent = Math.round((projected / g.target) * 100);
  const onTrack = projected >= g.target;
  const remaining = Math.max(0, g.target - g.earned);
  const daysLeft = g.workingDays - g.workingDaysPassed;
  const dailyNeeded = daysLeft > 0 ? Math.round(remaining / daysLeft) : 0;

  const circumference = 2 * Math.PI * 58;
  const dashOffset = circumference - (circumference * Math.min(percent, 100)) / 100;

  return (
    <div style={S.page}>
      <h1 style={S.title}>Revenue Goals</h1>
      <p style={S.subtitle}>{g.month}</p>

      {/* Big ring */}
      <div style={S.ringContainer}>
        <svg width="140" height="140" viewBox="0 0 140 140" style={S.ringSvg}>
          <circle cx="70" cy="70" r="58" fill="none" stroke="#F0ECE8" strokeWidth="10" />
          <circle cx="70" cy="70" r="58" fill="none" stroke={onTrack ? '#4CAF50' : '#FF9800'} strokeWidth="10"
            strokeDasharray={circumference} strokeDashoffset={dashOffset}
            strokeLinecap="round" transform="rotate(-90 70 70)" style={{ transition: 'stroke-dashoffset .6s' }} />
        </svg>
        <div style={S.ringCenter}>
          <span style={S.ringPercent}>{percent}%</span>
          <span style={S.ringLabel}>of {fmt(g.target)}</span>
        </div>
      </div>

      {/* Key numbers */}
      <div style={S.statsRow}>
        <div style={S.statCard}>
          <span style={{ ...S.statNum, color: '#C76B8A' }}>{fmt(g.earned)}</span>
          <span style={S.statLabel}>Earned</span>
        </div>
        <div style={S.statCard}>
          <span style={{ ...S.statNum, color: '#4CAF50' }}>{fmt(g.booked)}</span>
          <span style={S.statLabel}>Booked</span>
        </div>
        <div style={S.statCard}>
          <span style={{ ...S.statNum, color: remaining > 0 ? '#FF9800' : '#4CAF50' }}>{fmt(remaining)}</span>
          <span style={S.statLabel}>Remaining</span>
        </div>
      </div>

      {/* Projection card */}
      <div style={{ ...S.projCard, background: onTrack ? '#E8F5E9' : '#FFF5E6' }}>
        <span style={S.projIcon}>{onTrack ? '🚀' : '⏰'}</span>
        <div style={S.projInfo}>
          <span style={{ ...S.projTitle, color: onTrack ? '#4CAF50' : '#FF9800' }}>
            {onTrack ? 'On track!' : 'Behind pace'}
          </span>
          <span style={S.projDetail}>
            Projected: {fmt(projected)} ({projectedPercent}%). {daysLeft} working day{daysLeft !== 1 ? 's' : ''} left — need {fmt(dailyNeeded)}/day.
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['progress', 'breakdown', 'history'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Progress tab — weekly pace */}
      {tab === 'progress' && (
        <div style={S.section}>
          <h3 style={S.sectionTitle}>Weekly Pace</h3>
          {DEV_GOALS.weeklyPace.map((w, i) => {
            const weekTarget = Math.round(g.target / 4);
            const wp = Math.min(100, Math.round((w.earned / weekTarget) * 100));
            return (
              <div key={i} style={S.barRow}>
                <span style={S.barLabel}>{w.week}</span>
                <div style={S.barTrack}>
                  <div style={{ ...S.barFill, width: `${wp}%`, background: wp >= 100 ? '#4CAF50' : '#C76B8A' }} />
                </div>
                <span style={S.barValue}>{fmt(w.earned)}</span>
              </div>
            );
          })}
          <div style={S.targetLine}>
            <span style={S.targetLineLabel}>Weekly target: {fmt(Math.round(g.target / 4))}</span>
          </div>
        </div>
      )}

      {/* Breakdown tab */}
      {tab === 'breakdown' && (
        <div style={S.section}>
          <h3 style={S.sectionTitle}>By Category</h3>
          {DEV_GOALS.breakdown.map((cat, i) => {
            const cp = Math.min(100, Math.round((cat.earned / cat.target) * 100));
            return (
              <div key={i} style={S.breakdownCard}>
                <div style={S.breakdownHeader}>
                  <span style={S.breakdownLabel}>{cat.label}</span>
                  <span style={S.breakdownPct}>{cp}%</span>
                </div>
                <div style={S.barTrack}>
                  <div style={{ ...S.barFill, width: `${cp}%`, background: cp >= 100 ? '#4CAF50' : '#C76B8A' }} />
                </div>
                <div style={S.breakdownNums}>
                  <span style={S.breakdownEarned}>{fmt(cat.earned)}</span>
                  <span style={S.breakdownTarget}>/ {fmt(cat.target)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* History tab */}
      {tab === 'history' && (
        <div style={S.section}>
          <h3 style={S.sectionTitle}>Past Months</h3>
          {DEV_GOALS.history.map((h, i) => (
            <div key={i} style={S.historyCard}>
              <div style={S.historyLeft}>
                <span style={S.historyMonth}>{h.month}</span>
                <span style={S.historyNums}>{fmt(h.actual)} / {fmt(h.target)}</span>
              </div>
              <span style={{ ...S.historyBadge, background: h.hit ? '#E8F5E9' : '#FFEBEE', color: h.hit ? '#4CAF50' : '#F44336' }}>
                {h.hit ? '✓ Hit' : '✗ Missed'}
              </span>
            </div>
          ))}
          <div style={S.streakCard}>
            <span style={S.streakText}>Hit rate: {DEV_GOALS.history.filter(h => h.hit).length}/{DEV_GOALS.history.length} months ({Math.round((DEV_GOALS.history.filter(h => h.hit).length / DEV_GOALS.history.length) * 100)}%)</span>
          </div>
        </div>
      )}

      {/* Set goal button */}
      <button style={S.setGoalBtn} onClick={() => setShowSetGoal(true)}>Set Next Month's Goal</button>

      {/* Set goal modal */}
      {showSetGoal && (
        <div style={S.overlay} onClick={() => setShowSetGoal(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h2 style={S.modalTitle}>Set April Goal</h2>
              <button style={S.closeBtn} onClick={() => setShowSetGoal(false)}>✕</button>
            </div>
            <div style={S.formBody}>
              <label style={S.fLabel}>Monthly Revenue Target (£)</label>
              <input style={S.input} type="number" placeholder="4500" defaultValue="4500" />
              <div style={S.suggestionCard}>
                <span style={S.suggestionIcon}>💡</span>
                <span style={S.suggestionText}>Based on your 3-month average ({fmt(Math.round((425000 + 378000 + 410000) / 3))}), try £4,500 — a 10% stretch.</span>
              </div>
              <label style={S.fLabel}>Breakdown (optional)</label>
              {['Brow treatments', 'Lash treatments', 'Semi-permanent', 'Retail & add-ons'].map(c => (
                <div key={c} style={S.breakdownInputRow}>
                  <span style={S.breakdownInputLabel}>{c}</span>
                  <input style={{ ...S.input, width: 90, textAlign: 'right' }} type="number" placeholder="0" />
                </div>
              ))}
            </div>
            <button style={S.saveBtn}>Save Goal</button>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { padding: '20px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: '#AAA5A0', margin: '0 0 20px' },

  ringContainer: { position: 'relative', width: 140, height: 140, margin: '0 auto 20px' },
  ringSvg: { display: 'block' },
  ringCenter: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
  ringPercent: { fontSize: 28, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  ringLabel: { fontSize: 11, color: '#AAA5A0' },

  statsRow: { display: 'flex', gap: 8, marginBottom: 14 },
  statCard: { flex: 1, background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statNum: { fontSize: 16, fontWeight: 700 },
  statLabel: { fontSize: 10, color: '#AAA5A0', fontWeight: 500 },

  projCard: { borderRadius: 12, padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 },
  projIcon: { fontSize: 22 },
  projInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  projTitle: { fontSize: 14, fontWeight: 700 },
  projDetail: { fontSize: 12, color: '#8B6F5E', lineHeight: 1.4 },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: '#AAA5A0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },

  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 12px' },

  barRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  barLabel: { fontSize: 11, color: '#AAA5A0', width: 70, flexShrink: 0 },
  barTrack: { flex: 1, height: 8, borderRadius: 4, background: '#F0ECE8', overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4, transition: 'width .4s' },
  barValue: { fontSize: 12, fontWeight: 600, color: 'var(--text, #2D2A26)', width: 55, textAlign: 'right' },
  targetLine: { paddingTop: 6, borderTop: '1px dashed #D0CBC5' },
  targetLineLabel: { fontSize: 11, color: '#AAA5A0' },

  breakdownCard: { background: 'var(--card, #fff)', borderRadius: 12, padding: 12, marginBottom: 8 },
  breakdownHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: 6 },
  breakdownLabel: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  breakdownPct: { fontSize: 13, fontWeight: 700, color: '#C76B8A' },
  breakdownNums: { display: 'flex', gap: 4, marginTop: 6 },
  breakdownEarned: { fontSize: 12, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  breakdownTarget: { fontSize: 12, color: '#AAA5A0' },

  historyCard: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 14px', marginBottom: 8 },
  historyLeft: { display: 'flex', flexDirection: 'column', gap: 2 },
  historyMonth: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  historyNums: { fontSize: 12, color: '#AAA5A0' },
  historyBadge: { padding: '4px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600 },
  streakCard: { background: '#F9F7F4', borderRadius: 10, padding: 12, textAlign: 'center' },
  streakText: { fontSize: 13, fontWeight: 600, color: '#8B6F5E' },

  setGoalBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: '1px dashed #C76B8A', background: 'transparent', fontSize: 14, fontWeight: 600, color: '#C76B8A', cursor: 'pointer', fontFamily: 'inherit', marginTop: 8 },

  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg, #FAF8F5)', borderRadius: '18px 18px 0 0', width: '100%', maxWidth: 480, maxHeight: '85vh', overflow: 'auto', padding: '20px 16px 32px' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, color: '#AAA5A0', cursor: 'pointer' },
  formBody: { display: 'flex', flexDirection: 'column', gap: 10 },
  fLabel: { fontSize: 12, fontWeight: 600, color: '#AAA5A0', marginTop: 4 },
  input: { padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: 'var(--text, #2D2A26)', background: 'var(--card, #fff)' },
  suggestionCard: { background: '#F9F7F4', borderRadius: 10, padding: 12, display: 'flex', gap: 8, alignItems: 'flex-start' },
  suggestionIcon: { fontSize: 16, flexShrink: 0 },
  suggestionText: { fontSize: 12, color: '#8B6F5E', lineHeight: 1.4 },
  breakdownInputRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  breakdownInputLabel: { fontSize: 13, color: 'var(--text, #2D2A26)' },
  saveBtn: { marginTop: 16, width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
