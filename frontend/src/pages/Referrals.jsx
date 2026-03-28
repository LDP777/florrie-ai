/**
 * Referrals — Refer-a-friend programme.
 *
 * Features:
 *   - Referral code generation per client
 *   - Reward config (referrer gets X, friend gets Y)
 *   - Tracking: referrals made, converted, rewards issued
 *   - Shareable referral link/message
 *   - Leaderboard of top referrers
 *   - Settings: reward amounts, expiry, auto-reward
 */
import { useState, useEffect } from 'react';
import { useBeautician, supabase, isDevMode, fetchRows, updateRow } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import logger from '../lib/logger.js';

const DEV_REFERRALS = [
  { id: 'ref-1', referrer: 'Shauna', friend: 'Amy', code: 'SHAUNA10', status: 'converted', reward: 'both_claimed', date: '2026-03-12' },
  { id: 'ref-2', referrer: 'Shauna', friend: 'Megan', code: 'SHAUNA10', status: 'converted', reward: 'referrer_claimed', date: '2026-02-28' },
  { id: 'ref-3', referrer: 'Daisy S', friend: 'Laura', code: 'DAISY15', status: 'converted', reward: 'both_claimed', date: '2026-03-08' },
  { id: 'ref-4', referrer: 'Daisy S', friend: null, code: 'DAISY15', status: 'pending', reward: 'none', date: '2026-03-20' },
  { id: 'ref-5', referrer: 'Jasmin', friend: 'Sophie', code: 'JASMIN10', status: 'booked', reward: 'none', date: '2026-03-18' },
  { id: 'ref-6', referrer: 'Grace', friend: null, code: 'GRACE10', status: 'shared', reward: 'none', date: '2026-03-22' },
];

const DEV_LEADERBOARD = [
  { name: 'Shauna', referrals: 2, converted: 2 },
  { name: 'Daisy S', referrals: 2, converted: 1 },
  { name: 'Jasmin', referrals: 1, converted: 1 },
  { name: 'Grace', referrals: 1, converted: 0 },
];

const STATUS_CONFIG = {
  shared: { label: 'Shared', color: '#9E9E9E', bg: '#F5F5F5' },
  pending: { label: 'Pending', color: '#F5A623', bg: '#FFF8E1' },
  booked: { label: 'Booked', color: '#4A90D9', bg: '#E3F2FD' },
  converted: { label: 'Converted', color: '#4CAF50', bg: '#E8F5E9' },
};

export default function Referrals({ token }) {
  const { dark } = useTheme();
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);

  // Data
  const [referrals, setReferrals] = useState(isDevMode ? DEV_REFERRALS : []);
  const [leaderboard, setLeaderboard] = useState(isDevMode ? DEV_LEADERBOARD : []);

  // Settings
  const [referrerReward, setReferrerReward] = useState(10);
  const [friendReward, setFriendReward] = useState(10);
  const [rewardType, setRewardType] = useState('discount');
  const [expiryDays, setExpiryDays] = useState(30);
  const [autoReward, setAutoReward] = useState(true);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    if (beautician && !bLoading) loadReferrals();
  }, [beautician, bLoading]);

  async function loadReferrals() {
    setLoading(true);
    try {
      if (isDevMode) {
        setReferrals(DEV_REFERRALS);
        setLeaderboard(DEV_LEADERBOARD);
      } else {
        const data = await fetchRows('referrals', beautician.id, { order: 'created_at', ascending: false });
        setReferrals(data || []);
        // Compute leaderboard from data
        if (data && data.length > 0) {
          const grouped = {};
          data.forEach(r => {
            if (!grouped[r.referrer_id]) {
              grouped[r.referrer_id] = { name: r.referrer_name || 'Unknown', referrals: 0, converted: 0 };
            }
            grouped[r.referrer_id].referrals++;
            if (r.status === 'converted') grouped[r.referrer_id].converted++;
          });
          setLeaderboard(Object.values(grouped).sort((a, b) => b.converted - a.converted));
        }
      }
    } catch (err) {
      logger.error('Load referrals error:', err);
      setReferrals(DEV_REFERRALS);
      setLeaderboard(DEV_LEADERBOARD);
    } finally {
      setLoading(false);
    }
  }

  const totalReferrals = referrals.length;
  const converted = referrals.filter(r => r.status === 'converted').length;
  const conversionRate = totalReferrals ? Math.round((converted / totalReferrals) * 100) : 0;

  const referralLink = 'florrie.ai/ref/ellindigo';
  const shareMessage = `Hey! I love my brow girl Ellie at Ellindigo — you should book in! Use my code for £${friendReward} off your first appointment: https://${referralLink}`;

  function handleCopyLink() {
    navigator.clipboard?.writeText(`https://${referralLink}`);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
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

      {/* Share card */}
      <div style={s.shareCard}>
        <span style={s.shareTitle}>Share your referral programme</span>
        <div style={s.urlRow}>
          <span style={s.urlText}>{referralLink}</span>
          <button onClick={handleCopyLink} style={s.copyBtn}>
            {linkCopied ? '✓' : 'Copy'}
          </button>
        </div>
        <div style={s.shareActions}>
          <button style={s.shareBtn}>📱 WhatsApp</button>
          <button style={s.shareBtn}>📷 Instagram</button>
          <button style={s.shareBtn}>🔗 Link</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={s.tabBar}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              ...s.tab,
              color: tab === t.key ? '#C76B8A' : 'var(--text-muted, #AAA5A0)',
              borderBottom: tab === t.key ? '2px solid #C76B8A' : '2px solid transparent',
              fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview — leaderboard + reward summary */}
      {tab === 'overview' && (
        <div style={s.section}>
          <div style={s.rewardSummary}>
            <div style={s.rewardBox}>
              <span style={s.rewardIcon}>🎁</span>
              <span style={s.rewardLabel}>Referrer gets</span>
              <span style={s.rewardValue}>£{referrerReward} off</span>
            </div>
            <div style={s.rewardArrow}>→</div>
            <div style={s.rewardBox}>
              <span style={s.rewardIcon}>🌟</span>
              <span style={s.rewardLabel}>Friend gets</span>
              <span style={s.rewardValue}>£{friendReward} off</span>
            </div>
          </div>

          <span style={s.sectionTitle}>Top referrers</span>
          {DEV_LEADERBOARD.map((l, i) => (
            <div key={l.name} style={s.leaderRow}>
              <span style={{
                ...s.rank,
                color: i === 0 ? '#F5A623' : i === 1 ? '#9E9E9E' : i === 2 ? '#C4A882' : 'var(--text-muted, #AAA5A0)',
              }}>#{i + 1}</span>
              <div style={s.leaderAvatar}>{l.name[0]}</div>
              <div style={s.leaderInfo}>
                <span style={s.leaderName}>{l.name}</span>
                <span style={s.leaderMeta}>{l.referrals} shared · {l.converted} converted</span>
              </div>
              <div style={s.leaderBar}>
                <div style={{
                  ...s.leaderFill,
                  width: `${(l.converted / (DEV_LEADERBOARD[0]?.converted || 1)) * 100}%`,
                }} />
              </div>
            </div>
          ))}

          <div style={s.tipCard}>
            <span style={s.tipIcon}>💡</span>
            <span style={s.tipText}>Clients who come through referrals have 37% higher lifetime value. Encourage your regulars to share their code!</span>
          </div>
        </div>
      )}

      {/* Referrals list */}
      {tab === 'referrals' && (
        <div style={s.section}>
          {DEV_REFERRALS.map(r => {
            const st = STATUS_CONFIG[r.status];
            return (
              <div key={r.id} style={s.refCard}>
                <div style={s.refTop}>
                  <div style={s.refInfo}>
                    <span style={s.refFrom}>{r.referrer}</span>
                    <span style={s.refArrow}>→</span>
                    <span style={s.refTo}>{r.friend || 'Awaiting...'}</span>
                  </div>
                  <span style={{ ...s.statusBadge, background: st.bg, color: st.color }}>{st.label}</span>
                </div>
                <div style={s.refBottom}>
                  <span style={s.refCode}>{r.code}</span>
                  <span style={s.refDate}>{new Date(r.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
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
                  style={{
                    ...s.chip,
                    background: rewardType === t.key ? '#C76B8A' : 'var(--card-bg, #fff)',
                    color: rewardType === t.key ? '#fff' : 'var(--text, #2D2A26)',
                    border: rewardType === t.key ? '1px solid #C76B8A' : '1px solid var(--border, #E8E4E0)',
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
                  style={{
                    ...s.chip,
                    background: referrerReward === v ? '#C76B8A' : 'var(--card-bg, #fff)',
                    color: referrerReward === v ? '#fff' : 'var(--text, #2D2A26)',
                    border: referrerReward === v ? '1px solid #C76B8A' : '1px solid var(--border, #E8E4E0)',
                  }}
                >
                  £{v}
                </button>
              ))}
            </div>
          </div>

          <div style={s.settingCard}>
            <span style={s.settingLabel}>Friend reward</span>
            <div style={s.chipRow}>
              {[5, 10, 15, 20].map(v => (
                <button
                  key={v}
                  onClick={() => setFriendReward(v)}
                  style={{
                    ...s.chip,
                    background: friendReward === v ? '#C76B8A' : 'var(--card-bg, #fff)',
                    color: friendReward === v ? '#fff' : 'var(--text, #2D2A26)',
                    border: friendReward === v ? '1px solid #C76B8A' : '1px solid var(--border, #E8E4E0)',
                  }}
                >
                  £{v}
                </button>
              ))}
            </div>
          </div>

          <div style={s.settingCard}>
            <span style={s.settingLabel}>Reward expires after</span>
            <div style={s.chipRow}>
              {[14, 30, 60, 90].map(v => (
                <button
                  key={v}
                  onClick={() => setExpiryDays(v)}
                  style={{
                    ...s.chip,
                    background: expiryDays === v ? '#C76B8A' : 'var(--card-bg, #fff)',
                    color: expiryDays === v ? '#fff' : 'var(--text, #2D2A26)',
                    border: expiryDays === v ? '1px solid #C76B8A' : '1px solid var(--border, #E8E4E0)',
                  }}
                >
                  {v} days
                </button>
              ))}
            </div>
          </div>

          <div style={s.toggleSettingRow}>
            <div>
              <span style={s.settingLabel}>Auto-apply rewards</span>
              <span style={s.settingDesc}>Automatically apply discount when referral converts</span>
            </div>
            <button
              onClick={() => setAutoReward(!autoReward)}
              style={{ ...s.toggle, background: autoReward ? '#C76B8A' : '#E8E4E0' }}
            >
              <div style={{ ...s.toggleThumb, transform: autoReward ? 'translateX(18px)' : 'translateX(2px)' }} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const s = {
  page: { padding: '16px 16px 32px', maxWidth: 480, margin: '0 auto', fontFamily: '"DM Sans", -apple-system, sans-serif' },
  header: { marginBottom: 16 },
  title: { fontSize: 24, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  sub: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)', margin: '4px 0 0' },
  statsRow: { display: 'flex', gap: 8, marginBottom: 14 },
  statCard: { flex: 1, background: 'var(--card-bg, #fff)', borderRadius: 12, padding: '12px 10px', textAlign: 'center', border: '1px solid var(--border, #F0ECE8)' },
  statValue: { display: 'block', fontSize: 20, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  statLabel: { display: 'block', fontSize: 10, color: 'var(--text-muted, #AAA5A0)', textTransform: 'uppercase', letterSpacing: '0.03em' },
  shareCard: { background: 'linear-gradient(135deg, #C76B8A, #B55A79)', borderRadius: 14, padding: 16, marginBottom: 16, color: '#fff' },
  shareTitle: { display: 'block', fontSize: 14, fontWeight: 700, marginBottom: 8 },
  urlRow: { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.2)', borderRadius: 10, padding: '8px 12px', marginBottom: 10 },
  urlText: { flex: 1, fontSize: 13, fontWeight: 500 },
  copyBtn: { padding: '4px 12px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.4)', background: 'transparent', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  shareActions: { display: 'flex', gap: 8 },
  shareBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.15)', color: '#fff', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center' },
  tabBar: { display: 'flex', borderBottom: '1px solid var(--border, #F0ECE8)', marginBottom: 14 },
  tab: { flex: 1, padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', textAlign: 'center' },
  section: { display: 'flex', flexDirection: 'column', gap: 10 },
  sectionTitle: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #AAA5A0)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 4 },
  rewardSummary: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', padding: '16px 0' },
  rewardBox: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, background: 'var(--card-bg, #fff)', borderRadius: 12, padding: '14px 18px', border: '1px solid var(--border, #F0ECE8)' },
  rewardIcon: { fontSize: 22 },
  rewardLabel: { fontSize: 10, color: 'var(--text-muted, #AAA5A0)', textTransform: 'uppercase' },
  rewardValue: { fontSize: 16, fontWeight: 700, color: '#C76B8A' },
  rewardArrow: { fontSize: 18, color: 'var(--text-muted, #AAA5A0)' },
  leaderRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border, #F0ECE8)' },
  rank: { fontSize: 14, fontWeight: 700, minWidth: 24 },
  leaderAvatar: { width: 32, height: 32, borderRadius: 16, background: 'linear-gradient(135deg, #C76B8A22, #C76B8A44)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#C76B8A', flexShrink: 0 },
  leaderInfo: { flex: 1 },
  leaderName: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  leaderMeta: { display: 'block', fontSize: 11, color: 'var(--text-muted, #AAA5A0)' },
  leaderBar: { width: 40, height: 6, borderRadius: 3, background: 'var(--border, #F0ECE8)', overflow: 'hidden', flexShrink: 0 },
  leaderFill: { height: '100%', borderRadius: 3, background: '#C76B8A' },
  tipCard: { display: 'flex', gap: 10, padding: 12, borderRadius: 10, background: 'linear-gradient(135deg, #FBF0F3, #F5EFFC)' },
  tipIcon: { fontSize: 18, flexShrink: 0 },
  tipText: { fontSize: 12, lineHeight: 1.5, color: 'var(--text, #5A5550)' },
  refCard: { background: 'var(--card-bg, #fff)', borderRadius: 12, padding: 12, border: '1px solid var(--border, #F0ECE8)' },
  refTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  refInfo: { display: 'flex', alignItems: 'center', gap: 6 },
  refFrom: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  refArrow: { fontSize: 12, color: 'var(--text-muted, #AAA5A0)' },
  refTo: { fontSize: 14, fontWeight: 500, color: 'var(--text, #5A5550)' },
  statusBadge: { fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6, textTransform: 'uppercase', letterSpacing: '0.03em' },
  refBottom: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  refCode: { fontSize: 12, fontFamily: 'monospace', color: '#C76B8A', fontWeight: 600 },
  refDate: { fontSize: 11, color: 'var(--text-muted, #AAA5A0)' },
  settingCard: { background: 'var(--card-bg, #fff)', borderRadius: 14, padding: 16, border: '1px solid var(--border, #F0ECE8)' },
  settingLabel: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)', marginBottom: 4 },
  settingDesc: { display: 'block', fontSize: 12, color: 'var(--text-muted, #AAA5A0)', marginTop: 2 },
  chipRow: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 },
  chip: { padding: '8px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  toggleSettingRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', background: 'var(--card-bg, #fff)', borderRadius: 14, border: '1px solid var(--border, #F0ECE8)' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleThumb: { width: 22, height: 22, borderRadius: 11, background: '#fff', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
};
