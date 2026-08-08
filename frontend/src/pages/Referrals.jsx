/**
 * Referrals - Refer-a-friend programme.
 *
 * Features:
 *   - Referral code generation per client
 *   - Reward config (referrer gets X, friend gets Y)
 *   - Tracking: referrals made, converted, rewards issued
 *   - Shareable referral link/message
 *   - Leaderboard of top referrers
 *   - Settings: reward type and amount (the only fields the backend persists)
 *
 * Note: the backend referral config stores referral_enabled,
 * referral_reward_type and referral_reward_value_cents only. Friend
 * reward, expiry and auto-reward have no backing column, so those
 * controls were removed rather than implying they save.
 */
import { useState, useEffect } from 'react';
import { useBeautician, supabase, fetchRows, updateRow } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon from '../components/ui/Icon';

async function getToken() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

const STATUS_CONFIG = {
  shared: { label: 'Shared', color: 'var(--text-muted)', bg: 'var(--bg-subtle)' },
  pending: { label: 'Pending', color: 'var(--warning)', bg: 'var(--warning-bg)' },
  booked: { label: 'Booked', color: 'var(--info)', bg: 'var(--info-bg)' },
  converted: { label: 'Converted', color: 'var(--success)', bg: 'var(--success-bg)' },
};

export default function Referrals() {
  const { dark } = useTheme();
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Data
  const [referrals, setReferrals] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);

  // Config from backend
  const [referralLink, setReferralLink] = useState('florrie.ai/ref/...');
  const [programEnabled, setProgramEnabled] = useState(true);
  const [referrerReward, setReferrerReward] = useState(10);
  const [rewardType, setRewardType] = useState('discount');
  const [linkCopied, setLinkCopied] = useState(false);
  const [msgCopied, setMsgCopied] = useState(false);

  useEffect(() => {
    if (beautician && !bLoading) {
      loadReferrals();
      loadConfig();
    }
  }, [beautician, bLoading]);

  async function loadConfig() {
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/referrals/config`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const data = await res.json();
      const cfg = data.config || {};
      if (data.shareLink) setReferralLink(data.shareLink.replace('https://', ''));
      if (cfg.referral_enabled !== undefined) setProgramEnabled(cfg.referral_enabled);
      if (cfg.referral_reward_type) setRewardType(cfg.referral_reward_type);
      if (cfg.referral_reward_value_cents) {
        const pounds = Math.round(cfg.referral_reward_value_cents / 100);
        setReferrerReward(pounds);
      }
    } catch (err) {
      logger.warn('Load referral config failed:', err);
    }
  }

  async function saveConfig() {
    setSaving(true);
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/api/referrals/config`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          referral_enabled: programEnabled,
          referral_reward_type: rewardType,
          referral_reward_value_cents: referrerReward * 100,
        }),
      });
    } catch (err) {
      logger.error('Save referral config failed:', err);
    } finally {
      setSaving(false);
    }
  }

  async function loadReferrals() {
    setLoading(true);
    try {

        const token = await getToken();
        const res = await fetch(`${API_BASE}/api/referrals`, {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error('Failed to load');
        const data = await res.json();
        const rows = data.referrals || [];
        setReferrals(rows);
        // Compute leaderboard client-side
        const grouped = {};
        rows.forEach(r => {
          const key = r.referrer_id || r.referred_name || 'Unknown';
          if (!grouped[key]) grouped[key] = { name: r.referrer_name || 'Client', referrals: 0, converted: 0 };
          grouped[key].referrals++;
          if (['rewarded', 'completed', 'converted'].includes(r.status)) grouped[key].converted++;
        });
        setLeaderboard(Object.values(grouped).sort((a, b) => b.converted - a.converted).slice(0, 5));
    } catch (err) {
      logger.error('Load referrals error:', err);
      setReferrals([]);
      setLeaderboard([]);
    } finally {
      setLoading(false);
    }
  }

  const totalReferrals = referrals.length;
  const converted = referrals.filter(r => ['converted', 'rewarded', 'completed'].includes(r.status)).length;
  const conversionRate = totalReferrals ? Math.round((converted / totalReferrals) * 100) : 0;

  if (loading) {
    return <PageLoader />;
  }

  const fullLink = `https://${referralLink}`;
  const shareMessage = `Hey! I wanted to share my beautician with you - she's brilliant. Use this link for £${referrerReward} off your first appointment: ${fullLink}`;

  function handleCopyLink() {
    navigator.clipboard?.writeText(fullLink);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  function handleWhatsAppShare() {
    window.open(`https://wa.me/?text=${encodeURIComponent(shareMessage)}`, '_blank');
  }

  function handleCopyMessage() {
    navigator.clipboard?.writeText(shareMessage);
    setMsgCopied(true);
    setTimeout(() => setMsgCopied(false), 2000);
  }

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'referrals', label: 'Referrals' },
    { key: 'settings', label: 'Settings' },
  ];

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Refer a Friend</h1>
        <p style={s.sub}>Grow your client base through word of mouth</p>
      </div>

      {/* Stats */}
      <div style={s.statsRow}>
        <div style={s.statCard}>
          <span style={s.statValue}>{totalReferrals}</span>
          <span style={s.statLabel}>Referrals</span>
        </div>
        <div style={s.statCard}>
          <span style={s.statValue}>{converted}</span>
          <span style={s.statLabel}>Converted</span>
        </div>
        <div style={s.statCard}>
          <span style={s.statValue}>{conversionRate}%</span>
          <span style={s.statLabel}>Rate</span>
        </div>
      </div>

      {/* Enable/disable row */}
      <div style={s.enableRow}>
        <div>
          <span style={s.enableLabel}>Referral programme</span>
          <span style={s.enableDesc}>{programEnabled ? 'Active - clients can share and earn' : 'Paused - link won\'t work'}</span>
        </div>
        <button
          onClick={() => setProgramEnabled(v => !v)}
          style={{ ...s.toggle, background: programEnabled ? 'var(--accent, #92405e)' : 'var(--border, #E8DDD4)' }}
        >
          <div style={{ ...s.toggleThumb, transform: programEnabled ? 'translateX(18px)' : 'translateX(2px)' }} />
        </button>
      </div>

      {/* Share card */}
      <div style={{ ...s.shareCard, opacity: programEnabled ? 1 : 0.55 }}>
        <span style={s.shareTitle}>Your referral link</span>
        <div style={s.urlRow}>
          <span style={s.urlText}>{referralLink}</span>
          <button onClick={handleCopyLink} style={s.copyBtn}>
            {linkCopied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div style={s.shareActions}>
          <button onClick={handleWhatsAppShare} style={s.shareBtn} disabled={!programEnabled}><Icon name="phone" size={14} inline /> WhatsApp</button>
          <button onClick={handleCopyMessage} style={s.shareBtn} disabled={!programEnabled}>
            {msgCopied ? 'Copied' : 'Copy message'}
          </button>
          <button onClick={handleCopyLink} style={s.shareBtn} disabled={!programEnabled}><Icon name="link" size={14} inline /> Link</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={s.tabBar}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{ ...s.tab,
              color: tab === t.key ? 'var(--accent, #92405e)' : 'var(--text-muted, #6B5D54)',
              borderBottom: tab === t.key ? '2px solid var(--accent, #92405e)' : '2px solid transparent',
              fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview - leaderboard + reward summary */}
      {tab === 'overview' && (
        <div style={s.section}>
          <div style={s.rewardSummary}>
            <div style={s.rewardBox}>
              <span style={s.rewardIcon}><Icon name="gift" size={15} /></span>
              <span style={s.rewardLabel}>Referrer gets</span>
              <span style={s.rewardValue}>£{referrerReward} off</span>
            </div>
            <div style={s.rewardArrow}>→</div>
            <div style={s.rewardBox}>
              <span style={s.rewardIcon}><Icon name="star" size={15} /></span>
              <span style={s.rewardLabel}>Friend gets</span>
              <span style={s.rewardValue}>£{referrerReward} off</span>
            </div>
          </div>

          <span style={s.sectionTitle}>Top referrers</span>
          {leaderboard.length === 0 && (
            <div style={s.tipCard}>
              <span style={s.tipIcon}><Icon name="flower" size={15} /></span>
              <span style={s.tipText}>No referrals yet. Share your link and get your regulars to spread the word.</span>
            </div>
          )}
          {leaderboard.map((l, i) => (
            <div key={l.name} style={s.leaderRow}>
              <span style={{ ...s.rank,
                color: i === 0 ? '#F5A623' : i === 1 ? '#9E9E9E' : i === 2 ? '#C4A882' : 'var(--text-muted, #6B5D54)',
              }}>#{i + 1}</span>
              <div style={s.leaderAvatar}>{l.name[0]}</div>
              <div style={s.leaderInfo}>
                <span style={s.leaderName}>{l.name}</span>
                <span style={s.leaderMeta}>{l.referrals} shared · {l.converted} converted</span>
              </div>
              <div style={s.leaderBar}>
                <div style={{ ...s.leaderFill,
                  width: `${(l.converted / (leaderboard[0]?.converted || 1)) * 100}%`,
                }} />
              </div>
            </div>
          ))}

          <div style={s.tipCard}>
            <span style={s.tipIcon}><Icon name="info" size={15} /></span>
            <span style={s.tipText}>Word-of-mouth clients tend to stick around and trust you faster. Encourage your regulars to share their code!</span>
          </div>
        </div>
      )}

      {/* Referrals list */}
      {tab === 'referrals' && (
        <div style={s.section}>
          {referrals.length === 0 && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted, #6B5D54)', fontSize: 13 }}>
              No referrals yet - share your link to get started.
            </div>
          )}
          {referrals.map(r => {
            const statusKey = r.status === 'rewarded' ? 'converted' : (r.status || 'shared');
            const st = STATUS_CONFIG[statusKey] || STATUS_CONFIG.shared;
            const referrerName = r.referrer_name || r.referrer || 'Client';
            const friendName = r.referred_name || r.friend || 'Awaiting...';
            return (
              <div key={r.id} style={s.refCard}>
                <div style={s.refTop}>
                  <div style={s.refInfo}>
                    <span style={s.refFrom}>{referrerName}</span>
                    <span style={s.refArrow}>→</span>
                    <span style={s.refTo}>{friendName}</span>
                  </div>
                  <span style={{ ...s.statusBadge, background: st.bg, color: st.color }}>{st.label}</span>
                </div>
                <div style={s.refBottom}>
                  <span style={s.refCode}>{r.referral_code || r.code || '-'}</span>
                  <span style={s.refDate}>{new Date(r.created_at || r.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Settings */}
      {tab === 'settings' && (
        <div style={s.section}>
          <div style={s.settingCard}>
            <span style={s.settingLabel}>Reward type</span>
            <div style={s.chipRow}>
              {[
                { key: 'discount', label: '% off next visit' },
                { key: 'credit', label: 'Account credit' },
                { key: 'free_addon', label: 'Free add-on' },
              ].map(t => (
                <button
                  key={t.key}
                  onClick={() => setRewardType(t.key)}
                  style={{ ...s.chip,
                    background: rewardType === t.key ? 'var(--accent, #92405e)' : 'var(--card-bg, #FFFCF9)',
                    color: rewardType === t.key ? '#fff' : 'var(--text, #241B17)',
                    border: rewardType === t.key ? '1px solid var(--accent, #92405e)' : '1px solid var(--border, #E8DDD4)',
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div style={s.settingCard}>
            <span style={s.settingLabel}>Referrer reward</span>
            <div style={s.chipRow}>
              {[5, 10, 15, 20].map(v => (
                <button
                  key={v}
                  onClick={() => setReferrerReward(v)}
                  style={{ ...s.chip,
                    background: referrerReward === v ? 'var(--accent, #92405e)' : 'var(--card-bg, #FFFCF9)',
                    color: referrerReward === v ? '#fff' : 'var(--text, #241B17)',
                    border: referrerReward === v ? '1px solid var(--accent, #92405e)' : '1px solid var(--border, #E8DDD4)',
                  }}
                >
                  £{v}
                </button>
              ))}
            </div>
          </div>

          <button onClick={saveConfig} disabled={saving} style={s.saveBtn}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}
    </div>
  );
}

const s = {
  page: { padding: '16px 16px 32px', maxWidth: 480, margin: '0 auto', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif" },
  header: { marginBottom: 16 },
  title: { fontSize: 24, fontWeight: 700, color: 'var(--text, #241B17)', margin: 0 },
  sub: { fontSize: 13, color: 'var(--text-muted, #6B5D54)', margin: '4px 0 0' },
  statsRow: { display: 'flex', gap: 8, marginBottom: 14 },
  statCard: { flex: 1, background: 'var(--card-bg, #FFFCF9)', borderRadius: 12, padding: '12px 10px', textAlign: 'center', border: '1px solid var(--border, #E8DDD4)' },
  statValue: { display: 'block', fontSize: 20, fontWeight: 700, color: 'var(--text, #241B17)' },
  statLabel: { display: 'block', fontSize: 10, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase', letterSpacing: '0.03em' },
  shareCard: { background: 'linear-gradient(135deg, var(--accent, #92405e), #B55A79)', borderRadius: 14, padding: 16, marginBottom: 16, color: '#fff' },
  shareTitle: { display: 'block', fontSize: 14, fontWeight: 700, marginBottom: 8 },
  urlRow: { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.2)', borderRadius: 10, padding: '8px 12px', marginBottom: 10 },
  urlText: { flex: 1, fontSize: 13, fontWeight: 500 },
  copyBtn: { padding: '4px 12px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.4)', background: 'transparent', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  shareActions: { display: 'flex', gap: 8 },
  shareBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.15)', color: '#fff', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center' },
  tabBar: { display: 'flex', borderBottom: '1px solid var(--border, #E8DDD4)', marginBottom: 14 },
  tab: { flex: 1, padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', textAlign: 'center' },
  section: { display: 'flex', flexDirection: 'column', gap: 10 },
  sectionTitle: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 4 },
  rewardSummary: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', padding: '16px 0' },
  rewardBox: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, background: 'var(--card-bg, #FFFCF9)', borderRadius: 12, padding: '14px 18px', border: '1px solid var(--border, #E8DDD4)' },
  rewardIcon: { fontSize: 22 },
  rewardLabel: { fontSize: 10, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase' },
  rewardValue: { fontSize: 16, fontWeight: 700, color: 'var(--accent, #92405e)' },
  rewardArrow: { fontSize: 18, color: 'var(--text-muted, #6B5D54)' },
  leaderRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border, #E8DDD4)' },
  rank: { fontSize: 14, fontWeight: 700, minWidth: 24 },
  leaderAvatar: { width: 32, height: 32, borderRadius: 16, background: 'linear-gradient(135deg, var(--accent, #92405e)22, var(--accent, #92405e)44)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--accent, #92405e)', flexShrink: 0 },
  leaderInfo: { flex: 1 },
  leaderName: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)' },
  leaderMeta: { display: 'block', fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  leaderBar: { width: 40, height: 6, borderRadius: 3, background: 'var(--border, #E8DDD4)', overflow: 'hidden', flexShrink: 0 },
  leaderFill: { height: '100%', borderRadius: 3, background: 'var(--accent, #92405e)' },
  tipCard: { display: 'flex', gap: 10, padding: 12, borderRadius: 10, background: 'linear-gradient(135deg, var(--accent-light, #F6E7EC), #F5EFFC)' },
  tipIcon: { fontSize: 18, flexShrink: 0 },
  tipText: { fontSize: 12, lineHeight: 1.5, color: 'var(--text, #241B17)' },
  refCard: { background: 'var(--card-bg, #FFFCF9)', borderRadius: 12, padding: 12, border: '1px solid var(--border, #E8DDD4)' },
  refTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  refInfo: { display: 'flex', alignItems: 'center', gap: 6 },
  refFrom: { fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)' },
  refArrow: { fontSize: 12, color: 'var(--text-muted, #6B5D54)' },
  refTo: { fontSize: 14, fontWeight: 500, color: 'var(--text, #241B17)' },
  statusBadge: { fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6, textTransform: 'uppercase', letterSpacing: '0.03em' },
  refBottom: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  refCode: { fontSize: 12, fontFamily: 'monospace', color: 'var(--accent, #92405e)', fontWeight: 600 },
  refDate: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  settingCard: { background: 'var(--card-bg, #FFFCF9)', borderRadius: 14, padding: 16, border: '1px solid var(--border, #E8DDD4)' },
  settingLabel: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)', marginBottom: 4 },
  settingDesc: { display: 'block', fontSize: 12, color: 'var(--text-muted, #6B5D54)', marginTop: 2 },
  chipRow: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 },
  chip: { padding: '8px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  toggleSettingRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', background: 'var(--card-bg, #FFFCF9)', borderRadius: 14, border: '1px solid var(--border, #E8DDD4)' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleThumb: { width: 22, height: 22, borderRadius: 11, background: '#fff', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
  enableRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: 'var(--card-bg, #FFFCF9)', borderRadius: 14, border: '1px solid var(--border, #E8DDD4)', marginBottom: 14 },
  enableLabel: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)' },
  enableDesc: { display: 'block', fontSize: 12, color: 'var(--text-muted, #6B5D54)', marginTop: 2 },
  saveBtn: { width: '100%', padding: '13px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #92405e)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 4 },
};
