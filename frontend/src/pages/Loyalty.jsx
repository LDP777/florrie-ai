import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Loyalty
 *
 * One earn rule, one reward. Points accrue automatically server-side when an
 * appointment completes (backend/src/services/loyalty.js, idempotent), so this
 * page is just the dials and the truth:
 *  - Settings: is_active, points_per_pound, reward_name + reward_threshold.
 *    All persisted to loyalty_config (owner-scoped RLS, migration 007).
 *  - Members: per-client balances aggregated from the loyalty_points ledger,
 *    with progress towards the reward and a "mark reward used" action that
 *    writes a negative ledger row.
 *  - Activity: the last few ledger rows, humanised.
 */

const DEFAULT_THRESHOLD = 100;

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function clientName(row) {
  const c = row.clients;
  if (!c) return 'A client';
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || 'A client';
}

function firstName(row) {
  return row.clients?.first_name || 'A client';
}

function describeRow(row) {
  const treatment = row.appointments?.treatments?.name;
  if (row.reason === 'reward_redeemed' || (row.points || 0) < 0) {
    return `${firstName(row)} used their reward`;
  }
  const base = `${firstName(row)} earned ${row.points} pts`;
  return treatment ? `${base} · ${treatment}` : base;
}

export default function Loyalty() {
  const { beautician, loading: bLoading } = useBeautician();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [tab, setTab] = useState('members');

  // Settings form state
  const [pointsPerPound, setPointsPerPound] = useState(1);
  const [rewardName, setRewardName] = useState('');
  const [rewardThreshold, setRewardThreshold] = useState(DEFAULT_THRESHOLD);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [redeemingId, setRedeemingId] = useState(null);

  useEffect(() => {
    if (beautician && !bLoading) load();
  }, [beautician, bLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { data: cfg, error: cfgErr } = await supabase
        .from('loyalty_config')
        .select('*')
        .eq('beautician_id', beautician.id)
        .maybeSingle();
      if (cfgErr) throw cfgErr;

      const { data: rows, error: rowsErr } = await supabase
        .from('loyalty_points')
        .select('id, client_id, points, reason, created_at, clients(first_name, last_name), appointments(treatments(name))')
        .eq('beautician_id', beautician.id)
        .order('created_at', { ascending: false });
      if (rowsErr) throw rowsErr;

      setConfig(cfg || null);
      setLedger(rows || []);
      setPointsPerPound(cfg?.points_per_pound ?? 1);
      setRewardName(cfg?.reward_name ?? '');
      setRewardThreshold(cfg?.reward_threshold ?? DEFAULT_THRESHOLD);
    } catch (err) {
      logger.error('Load loyalty error:', err);
      setError('Could not load your loyalty programme. Pull to refresh or try again in a minute.');
    } finally {
      setLoading(false);
    }
  }

  /** Persist a partial update to loyalty_config. Returns true on success. */
  async function saveConfig(patch) {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const { data, error: upErr } = await supabase
        .from('loyalty_config')
        .upsert({ beautician_id: beautician.id, ...patch }, { onConflict: 'beautician_id' })
        .select()
        .single();
      if (upErr) throw upErr;
      setConfig(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      return true;
    } catch (err) {
      logger.error('Save loyalty config error:', err);
      setSaveError(err.message || 'Could not save. Check your connection and try again.');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    const next = !(config?.is_active ?? false);
    await saveConfig({ is_active: next });
  }

  async function saveSettings() {
    const threshold = Math.max(1, parseInt(rewardThreshold, 10) || DEFAULT_THRESHOLD);
    setRewardThreshold(threshold);
    await saveConfig({
      points_per_pound: pointsPerPound,
      reward_name: rewardName.trim() || null,
      reward_threshold: threshold,
    });
  }

  async function markRewardUsed(member) {
    const threshold = config?.reward_threshold ?? DEFAULT_THRESHOLD;
    const label = config?.reward_name ? `their ${config.reward_name}` : 'their reward';
    const ok = window.confirm(
      `Mark ${label} as used for ${member.name}? This takes ${threshold} points off their balance.`
    );
    if (!ok) return;
    setRedeemingId(member.clientId);
    setSaveError(null);
    try {
      const { error: insErr } = await supabase.from('loyalty_points').insert({
        beautician_id: beautician.id,
        client_id: member.clientId,
        points: -threshold,
        reason: 'reward_redeemed',
        balance_after: member.balance - threshold,
      });
      if (insErr) throw insErr;
      await load();
    } catch (err) {
      logger.error('Mark reward used error:', err);
      setSaveError(err.message || 'Could not mark the reward as used. Try again.');
    } finally {
      setRedeemingId(null);
    }
  }

  // Per-client aggregation: sum of the ledger per client, sorted by balance.
  const members = useMemo(() => {
    const byClient = new Map();
    for (const row of ledger) {
      if (!row.client_id) continue;
      const existing = byClient.get(row.client_id);
      if (existing) {
        existing.balance += row.points || 0;
      } else {
        byClient.set(row.client_id, {
          clientId: row.client_id,
          name: clientName(row),
          balance: row.points || 0,
        });
      }
    }
    return [...byClient.values()]
      .filter((m) => m.balance !== 0)
      .sort((a, b) => b.balance - a.balance);
  }, [ledger]);

  const recent = ledger.slice(0, 10);
  const isActive = config?.is_active ?? false;
  const threshold = config?.reward_threshold ?? DEFAULT_THRESHOLD;
  const rewardLabel = config?.reward_name || 'reward';

  if (bLoading || loading) return <PageLoader />;

  if (error) {
    return (
      <div style={styles.page}>
        <div style={styles.header}>
          <h1 style={styles.title}>Loyalty</h1>
        </div>
        <ErrorCard message={error} onDismiss={() => setError(null)} />
        <button type="button" onClick={load} style={styles.retryBtn}>Try again</button>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Loyalty</h1>
        <p style={styles.subtitle}>
          Clients earn points automatically when their appointments complete. Nothing to stamp, nothing to remember.
        </p>
      </div>

      {/* Settings */}
      <div style={styles.card}>
        <div style={styles.settingRow}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={styles.settingLabel}>Loyalty programme</span>
            <span style={styles.settingHint}>
              {isActive
                ? 'On. Completed appointments earn points.'
                : 'Off. No points are being earned right now.'}
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isActive}
            onClick={toggleActive}
            disabled={saving}
            style={{
              ...styles.toggle,
              background: isActive ? 'var(--accent, #92405e)' : 'var(--border, #ECD5DD)',
              opacity: saving ? 0.6 : 1,
            }}
          >
            <span style={{ ...styles.toggleDot, transform: isActive ? 'translateX(16px)' : 'translateX(0)' }} />
          </button>
        </div>

        <div style={styles.settingRow}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={styles.settingLabel}>Points per £1 spent</span>
            <span style={styles.settingHint}>A £45 set earns {45 * (pointsPerPound || 1)} points.</span>
          </div>
          <div style={styles.stepper}>
            <button
              type="button"
              onClick={() => setPointsPerPound((v) => Math.max(1, (v || 1) - 1))}
              disabled={pointsPerPound <= 1}
              style={{ ...styles.stepBtn, opacity: pointsPerPound <= 1 ? 0.4 : 1 }}
              aria-label="Fewer points per pound"
            >
              &minus;
            </button>
            <span style={styles.stepValue}>{pointsPerPound}</span>
            <button
              type="button"
              onClick={() => setPointsPerPound((v) => Math.min(10, (v || 1) + 1))}
              disabled={pointsPerPound >= 10}
              style={{ ...styles.stepBtn, opacity: pointsPerPound >= 10 ? 0.4 : 1 }}
              aria-label="More points per pound"
            >
              +
            </button>
          </div>
        </div>

        <div style={styles.rewardFields}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label htmlFor="loyalty-reward-name" style={styles.fieldLabel}>The reward</label>
            <input
              id="loyalty-reward-name"
              type="text"
              value={rewardName}
              onChange={(e) => setRewardName(e.target.value)}
              placeholder="Free lash infill"
              maxLength={60}
              style={styles.input}
            />
          </div>
          <div style={{ width: 96 }}>
            <label htmlFor="loyalty-reward-threshold" style={styles.fieldLabel}>At</label>
            <input
              id="loyalty-reward-threshold"
              type="number"
              inputMode="numeric"
              min={1}
              value={rewardThreshold}
              onChange={(e) => setRewardThreshold(e.target.value)}
              style={styles.input}
            />
          </div>
        </div>
        <p style={styles.rewardPreview}>
          {rewardName.trim()
            ? `Clients see: "${rewardName.trim()} at ${parseInt(rewardThreshold, 10) || DEFAULT_THRESHOLD} points".`
            : 'Name the reward so clients know what they are working towards.'}
        </p>

        {saveError && <div style={styles.errorBox}>{saveError}</div>}

        <button type="button" onClick={saveSettings} disabled={saving} style={styles.saveBtn}>
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
        </button>
      </div>

      {/* How it works */}
      <div style={styles.howStrip}>
        <div style={styles.howLine}>
          <span style={styles.howNum}>1</span>
          <span>Points land automatically when a visit completes, based on what they paid.</span>
        </div>
        <div style={styles.howLine}>
          <span style={styles.howNum}>2</span>
          <span>Progress shows on each client's card and on your booking page, so the scheme sells itself.</span>
        </div>
        <div style={styles.howLine}>
          <span style={styles.howNum}>3</span>
          <span>When someone claims their reward, mark it used below and their balance resets.</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        {[
          { key: 'members', label: `Members${members.length ? ` (${members.length})` : ''}` },
          { key: 'activity', label: 'Recent activity' },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={{
              ...styles.tab,
              borderBottomColor: tab === t.key ? 'var(--accent, #92405e)' : 'transparent',
              color: tab === t.key ? 'var(--accent, #92405e)' : 'var(--text-muted, #8A7A72)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Members */}
      {tab === 'members' && (
        members.length === 0 ? (
          <EmptyState
            icon="🪙"
            title="No points on the books yet"
            subtitle={isActive
              ? 'Balances appear here as appointments complete. Nothing for you to do.'
              : 'Turn the programme on above and completed appointments will start earning points.'}
          />
        ) : (
          <div style={styles.list}>
            {members.map((m) => {
              const progress = Math.min((m.balance / threshold) * 100, 100);
              const reached = m.balance >= threshold;
              return (
                <div key={m.clientId} style={styles.memberCard}>
                  <button
                    type="button"
                    onClick={() => navigate('/clients', { state: { clientId: m.clientId } })}
                    style={styles.memberMain}
                  >
                    <div style={styles.memberAvatar}>{m.name[0]?.toUpperCase() || '?'}</div>
                    <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                      <span style={styles.memberName}>{m.name}</span>
                      <div style={styles.progressTrack}>
                        <div
                          style={{
                            ...styles.progressFill,
                            width: `${progress}%`,
                            background: reached ? 'var(--success, #2E7D6B)' : 'var(--accent, #92405e)',
                          }}
                        />
                      </div>
                      <span style={styles.progressHint}>
                        {reached
                          ? `Earned their ${rewardLabel}`
                          : `${threshold - m.balance} pts to their ${rewardLabel}`}
                      </span>
                    </div>
                    <div style={styles.memberPoints}>
                      <span style={styles.memberPointsNum}>{m.balance}</span>
                      <span style={styles.memberPointsLabel}>pts</span>
                    </div>
                  </button>
                  {reached && (
                    <button
                      type="button"
                      onClick={() => markRewardUsed(m)}
                      disabled={redeemingId === m.clientId}
                      style={styles.redeemBtn}
                    >
                      {redeemingId === m.clientId ? 'Marking…' : 'Mark reward used'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {/* Recent activity */}
      {tab === 'activity' && (
        recent.length === 0 ? (
          <EmptyState
            icon="🗒️"
            title="Nothing yet"
            subtitle="Every point earned or reward used shows up here."
          />
        ) : (
          <div style={styles.activityCard}>
            {recent.map((row) => (
              <div key={row.id} style={styles.activityRow}>
                <span style={styles.activityText}>{describeRow(row)}</span>
                <span style={styles.activityDate}>{shortDate(row.created_at)}</span>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

const styles = {
  page: {
    padding: '16px 16px 32px',
    maxWidth: 720,
    margin: '0 auto',
    fontFamily: 'var(--font-body, "Plus Jakarta Sans", sans-serif)',
    color: 'var(--text-primary, #241B17)',
  },
  header: { marginBottom: 18 },
  title: {
    fontSize: 26,
    fontWeight: 600,
    margin: 0,
    fontFamily: 'var(--font-display, "Fraunces", Georgia, serif)',
  },
  subtitle: {
    fontSize: 13.5,
    lineHeight: 1.55,
    color: 'var(--text-secondary, #4D423D)',
    margin: '6px 0 0',
    maxWidth: 440,
  },

  card: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 16,
    border: '1px solid var(--border-light, #ede7e3)',
    padding: 16,
    boxShadow: 'var(--shadow-xs, 0 1px 2px rgba(146,64,94,.04))',
    marginBottom: 14,
  },

  settingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 0',
    borderBottom: '1px solid var(--border-light, #ede7e3)',
  },
  settingLabel: { display: 'block', fontSize: 14, fontWeight: 700 },
  settingHint: { display: 'block', fontSize: 12, color: 'var(--text-muted, #8A7A72)', marginTop: 2 },

  toggle: {
    width: 40,
    height: 24,
    borderRadius: 12,
    padding: 2,
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'background 0.2s ease',
  },
  toggleDot: {
    display: 'block',
    width: 20,
    height: 20,
    borderRadius: 10,
    background: '#fff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
    transition: 'transform 0.2s ease',
  },

  stepper: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    border: '1.5px solid var(--border, #ECD5DD)',
    background: 'var(--bg-input, #f8f2ef)',
    color: 'var(--text-primary, #241B17)',
    fontSize: 16,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    lineHeight: 1,
  },
  stepValue: {
    minWidth: 28,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: 700,
  },

  rewardFields: { display: 'flex', gap: 10, paddingTop: 14, flexWrap: 'wrap' },
  fieldLabel: {
    display: 'block',
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--text-secondary, #4D423D)',
    marginBottom: 6,
  },
  input: {
    width: '100%',
    padding: '11px 12px',
    borderRadius: 10,
    border: '1.5px solid var(--border, #ECD5DD)',
    fontSize: 14,
    fontFamily: 'inherit',
    color: 'var(--text-primary, #241B17)',
    background: 'var(--bg-input, #f8f2ef)',
    outline: 'none',
    boxSizing: 'border-box',
  },
  rewardPreview: {
    fontSize: 11.5,
    color: 'var(--text-muted, #8A7A72)',
    lineHeight: 1.5,
    margin: '8px 0 12px',
  },

  errorBox: {
    background: 'var(--danger-bg, #ffdad6)',
    border: '1px solid #F5C6C0',
    borderRadius: 10,
    padding: 10,
    fontSize: 13,
    color: '#8A2A1C',
    marginBottom: 10,
  },
  saveBtn: {
    width: '100%',
    padding: '12px 16px',
    borderRadius: 12,
    border: 'none',
    background: 'var(--accent, #92405e)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  retryBtn: {
    padding: '10px 16px',
    borderRadius: 10,
    border: '1px solid var(--border, #ECD5DD)',
    background: 'var(--bg-card, #fff)',
    color: 'var(--text-secondary, #4D423D)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    marginTop: 10,
  },

  howStrip: {
    background: 'var(--accent-light, #F6E7EC)',
    border: '1px solid var(--border, #ECD5DD)',
    borderRadius: 16,
    padding: '14px 16px',
    marginBottom: 18,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  howLine: {
    display: 'flex',
    gap: 10,
    alignItems: 'flex-start',
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--text-secondary, #4D423D)',
  },
  howNum: {
    width: 20,
    height: 20,
    borderRadius: 10,
    background: 'var(--accent, #92405e)',
    color: '#fff',
    fontSize: 11,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 1,
  },

  tabs: {
    display: 'flex',
    gap: 16,
    borderBottom: '1px solid var(--border-light, #ede7e3)',
    marginBottom: 12,
  },
  tab: {
    padding: '10px 0',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  },

  list: { display: 'flex', flexDirection: 'column', gap: 10 },

  memberCard: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 16,
    border: '1px solid var(--border-light, #ede7e3)',
    padding: 14,
    boxShadow: 'var(--shadow-xs, 0 1px 2px rgba(146,64,94,.04))',
  },
  memberMain: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: 'inherit',
  },
  memberAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    background: 'var(--accent-light, #F6E7EC)',
    color: 'var(--accent, #92405e)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 15,
    fontWeight: 700,
    flexShrink: 0,
  },
  memberName: { display: 'block', fontSize: 14.5, fontWeight: 700, marginBottom: 6 },
  memberPoints: { textAlign: 'right', flexShrink: 0 },
  memberPointsNum: {
    display: 'block',
    fontSize: 19,
    fontWeight: 700,
    color: 'var(--accent, #92405e)',
    fontFamily: 'var(--font-display, "Fraunces", Georgia, serif)',
  },
  memberPointsLabel: {
    display: 'block',
    fontSize: 9.5,
    color: 'var(--text-muted, #8A7A72)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },

  progressTrack: {
    height: 5,
    borderRadius: 3,
    background: 'var(--bg-input, #f8f2ef)',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 3, transition: 'width 0.3s ease' },
  progressHint: {
    display: 'block',
    fontSize: 11,
    color: 'var(--text-muted, #8A7A72)',
    marginTop: 5,
  },

  redeemBtn: {
    marginTop: 12,
    width: '100%',
    padding: '10px 14px',
    borderRadius: 10,
    border: '1.5px solid var(--success, #2E7D6B)',
    background: 'var(--success-bg, #EDF7F0)',
    color: 'var(--success, #2E7D6B)',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  activityCard: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 16,
    border: '1px solid var(--border-light, #ede7e3)',
    padding: '4px 14px',
  },
  activityRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
    padding: '11px 0',
    borderBottom: '1px solid var(--border-light, #ede7e3)',
  },
  activityText: { fontSize: 13.5, lineHeight: 1.45 },
  activityDate: { fontSize: 11.5, color: 'var(--text-muted, #8A7A72)', flexShrink: 0 },
};
