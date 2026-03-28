import { useState, useEffect } from 'react';
import { useBeautician, supabase, isDevMode, fetchRows, DEV_CLIENTS } from '../lib/supabase.js';
import logger from '../lib/logger.js';

/**
 * Loyalty & Rewards — keep clients coming back.
 *
 * Points system:
 *   1 point per £1 spent
 *   Bonus points for referrals, reviews, early rebooking
 *
 * Rewards:
 *   Free treatment, % off, add-on upgrade, gift voucher
 *
 * Tiers: Bronze → Silver → Gold → VIP
 */

const TIERS = [
  { name: 'Bronze', min: 0, color: '#C4A882', icon: '🥉', perks: 'Early access to new slots' },
  { name: 'Silver', min: 200, color: '#AAA5A0', icon: '🥈', perks: '5% off every 5th visit' },
  { name: 'Gold', min: 500, color: '#F5A623', icon: '🥇', perks: '10% off + free brow mask' },
  { name: 'VIP', min: 1000, color: '#C76B8A', icon: '💎', perks: 'Priority booking + birthday treat' },
];

const REWARDS = [
  { id: 'r1', name: 'Free Brow Jelly Mask', points: 50, icon: '🧖', type: 'addon' },
  { id: 'r2', name: '10% Off Next Visit', points: 100, icon: '🏷️', type: 'discount' },
  { id: 'r3', name: 'Free Lip Wax Add-on', points: 75, icon: '✨', type: 'addon' },
  { id: 'r4', name: 'Free Lamination Maintenance', points: 250, icon: '💅', type: 'treatment' },
  { id: 'r5', name: '£10 Gift Voucher', points: 150, icon: '🎁', type: 'voucher' },
];

const EARN_RULES = [
  { action: 'Per £1 spent', points: 1, icon: '💰' },
  { action: 'Leave a Google review', points: 25, icon: '⭐' },
  { action: 'Refer a friend', points: 50, icon: '👯' },
  { action: 'Rebook within 7 days', points: 15, icon: '📅' },
  { action: 'Birthday bonus', points: 20, icon: '🎂' },
];

function getTier(points) {
  return [...TIERS].reverse().find(t => points >= t.min) || TIERS[0];
}

function getNextTier(points) {
  return TIERS.find(t => t.min > points);
}

export default function Loyalty() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('overview');
  const [showRewardDetail, setShowRewardDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loyaltyConfig, setLoyaltyConfig] = useState(null);
  const [pointsHistory, setPointsHistory] = useState([]);

  useEffect(() => {
    if (beautician && !bLoading) loadLoyalty();
  }, [beautician, bLoading]);

  async function loadLoyalty() {
    setLoading(true);
    try {
      if (isDevMode) {
        setLoyaltyConfig({ enabled: true, points_per_dollar: 1, reset_interval_days: 365 });
        const pts = DEV_CLIENTS.map(c => ({
          id: c.id,
          client_name: c.first_name,
          points: Math.round((c.total_spend_cents || 0) / 100),
        }));
        setPointsHistory(pts);
      } else {
        // Fetch config
        const { data: config } = await supabase
          .from('loyalty_config')
          .select('*')
          .eq('beautician_id', beautician.id)
          .single();
        setLoyaltyConfig(config || { enabled: true, points_per_dollar: 1 });

        // Fetch points history
        const { data: history } = await supabase
          .from('loyalty_points')
          .select('*, clients(first_name)')
          .eq('beautician_id', beautician.id)
          .order('created_at', { ascending: false });
        setPointsHistory(history || []);
      }
    } catch (err) {
      logger.error('Load loyalty error:', err);
    } finally {
      setLoading(false);
    }
  }

  // Compute stats from points history
  const clients = pointsHistory;
  const totalPointsIssued = clients.reduce((s, c) => s + (c.points || 0), 0);
  const activeMembers = clients.filter(c => (c.points || 0) > 0).length;

  if (bLoading || loading) {
    return <div style={styles.page}><div style={{ textAlign: 'center', padding: 60, color: '#AAA5A0' }}>Loading...</div></div>;
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Loyalty</h1>
        <p style={styles.subtitle}>Rewards that bring them back</p>
      </div>

      {/* Hero stats */}
      <div style={styles.heroRow}>
        <div style={styles.heroStat}>
          <span style={styles.heroNum}>{activeMembers}</span>
          <span style={styles.heroLabel}>Members</span>
        </div>
        <div style={styles.heroStat}>
          <span style={styles.heroNum}>{totalPointsIssued}</span>
          <span style={styles.heroLabel}>Points issued</span>
        </div>
        <div style={styles.heroStat}>
          <span style={styles.heroNum}>{REWARDS.length}</span>
          <span style={styles.heroLabel}>Rewards</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        {[
          { key: 'overview', label: 'Overview' },
          { key: 'members', label: 'Members' },
          { key: 'rewards', label: 'Rewards' },
          { key: 'settings', label: 'Settings' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              ...styles.tab,
              borderBottomColor: tab === t.key ? '#C76B8A' : 'transparent',
              color: tab === t.key ? '#C76B8A' : '#AAA5A0',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === 'overview' && (
        <div style={styles.body}>
          {/* Tiers */}
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Loyalty tiers</h3>
            {TIERS.map((tier, i) => (
              <div key={tier.name} style={styles.tierRow}>
                <span style={{ fontSize: 18 }}>{tier.icon}</span>
                <div style={{ flex: 1 }}>
                  <span style={{ ...styles.tierName, color: tier.color }}>{tier.name}</span>
                  <span style={styles.tierPerks}>{tier.perks}</span>
                </div>
                <span style={styles.tierMin}>{tier.min}+ pts</span>
              </div>
            ))}
          </div>

          {/* How to earn */}
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>How clients earn points</h3>
            {EARN_RULES.map((rule, i) => (
              <div key={i} style={styles.earnRow}>
                <span style={{ fontSize: 16 }}>{rule.icon}</span>
                <span style={styles.earnAction}>{rule.action}</span>
                <span style={styles.earnPoints}>+{rule.points} pts</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Members */}
      {tab === 'members' && (
        <div style={styles.body}>
          {clients.length === 0 ? (
            <div style={styles.emptyState}>
              <span style={{ fontSize: 36, display: 'block', marginBottom: 12 }}>🏆</span>
              <p style={styles.emptyTitle}>No members yet</p>
              <p style={styles.emptyDesc}>Clients earn points automatically when they visit. Turn on loyalty in Settings.</p>
            </div>
          ) : (
            clients
              .sort((a, b) => b.loyalty_points - a.loyalty_points)
              .map(client => {
                const tier = getTier(client.loyalty_points);
                const next = getNextTier(client.loyalty_points);
                const progress = next
                  ? ((client.loyalty_points - tier.min) / (next.min - tier.min)) * 100
                  : 100;

                return (
                  <div key={client.id} style={styles.memberCard}>
                    <div style={styles.memberTop}>
                      <div style={styles.memberAvatar}>{client.first_name[0]}</div>
                      <div style={{ flex: 1 }}>
                        <span style={styles.memberName}>{client.first_name} {client.last_name}</span>
                        <span style={{ ...styles.memberTier, color: tier.color }}>
                          {tier.icon} {tier.name}
                        </span>
                      </div>
                      <div style={styles.memberPoints}>
                        <span style={styles.memberPointsNum}>{client.loyalty_points}</span>
                        <span style={styles.memberPointsLabel}>points</span>
                      </div>
                    </div>

                    {next && (
                      <div style={styles.progressSection}>
                        <div style={styles.progressTrack}>
                          <div style={{ ...styles.progressFill, width: `${Math.min(progress, 100)}%`, background: tier.color }} />
                        </div>
                        <span style={styles.progressHint}>
                          {next.min - client.loyalty_points} pts to {next.name}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })
          )}
        </div>
      )}

      {/* Rewards */}
      {tab === 'rewards' && (
        <div style={styles.body}>
          <p style={styles.rewardsIntro}>
            Clients can redeem points for these rewards. Tap to edit.
          </p>

          {REWARDS.map(reward => (
            <div
              key={reward.id}
              style={styles.rewardCard}
              onClick={() => setShowRewardDetail(reward)}
            >
              <span style={{ fontSize: 24 }}>{reward.icon}</span>
              <div style={{ flex: 1 }}>
                <span style={styles.rewardName}>{reward.name}</span>
                <span style={styles.rewardType}>{reward.type}</span>
              </div>
              <span style={styles.rewardCost}>{reward.points} pts</span>
            </div>
          ))}

          <button style={styles.addRewardBtn}>+ Add reward</button>
        </div>
      )}

      {/* Settings */}
      {tab === 'settings' && (
        <div style={styles.body}>
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Loyalty programme</h3>

            <div style={styles.settingRow}>
              <div style={{ flex: 1 }}>
                <span style={styles.settingLabel}>Enable loyalty points</span>
                <span style={styles.settingHint}>Clients earn points automatically on every visit</span>
              </div>
              <div style={{ ...styles.toggle, background: '#C76B8A' }}>
                <div style={{ ...styles.toggleDot, transform: 'translateX(16px)' }} />
              </div>
            </div>

            <div style={styles.settingRow}>
              <div style={{ flex: 1 }}>
                <span style={styles.settingLabel}>Show points on booking page</span>
                <span style={styles.settingHint}>Clients see their balance when booking</span>
              </div>
              <div style={{ ...styles.toggle, background: '#C76B8A' }}>
                <div style={{ ...styles.toggleDot, transform: 'translateX(16px)' }} />
              </div>
            </div>

            <div style={styles.settingRow}>
              <div style={{ flex: 1 }}>
                <span style={styles.settingLabel}>Auto-notify on new tier</span>
                <span style={styles.settingHint}>Message clients when they level up</span>
              </div>
              <div style={{ ...styles.toggle, background: '#C76B8A' }}>
                <div style={{ ...styles.toggleDot, transform: 'translateX(16px)' }} />
              </div>
            </div>

            <div style={styles.settingRow}>
              <div style={{ flex: 1 }}>
                <span style={styles.settingLabel}>Points expiry</span>
                <span style={styles.settingHint}>Points expire if unused</span>
              </div>
              <span style={styles.settingValue}>12 months</span>
            </div>
          </div>
        </div>
      )}

      {/* Reward detail modal */}
      {showRewardDetail && (
        <div style={styles.overlay} onClick={() => setShowRewardDetail(null)}>
          <div style={styles.detailPanel} onClick={e => e.stopPropagation()}>
            <button onClick={() => setShowRewardDetail(null)} style={styles.closeBtn}>×</button>
            <div style={{ textAlign: 'center', paddingTop: 8 }}>
              <span style={{ fontSize: 40, display: 'block', marginBottom: 8 }}>{showRewardDetail.icon}</span>
              <h2 style={styles.detailTitle}>{showRewardDetail.name}</h2>
              <span style={styles.detailCost}>{showRewardDetail.points} points to redeem</span>
            </div>

            <div style={styles.detailInfo}>
              <div style={styles.detailInfoRow}>
                <span style={styles.detailInfoLabel}>Type</span>
                <span style={styles.detailInfoValue}>{showRewardDetail.type}</span>
              </div>
              <div style={styles.detailInfoRow}>
                <span style={styles.detailInfoLabel}>Redeemed</span>
                <span style={styles.detailInfoValue}>0 times</span>
              </div>
              <div style={styles.detailInfoRow}>
                <span style={styles.detailInfoLabel}>Status</span>
                <span style={{ ...styles.detailInfoValue, color: '#4CAF50' }}>Active</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#FAF8F5', fontFamily: '"DM Sans", -apple-system, sans-serif', padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: '#2D2A26' },
  header: { paddingTop: 28, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: '#C76B8A', margin: 0, fontWeight: 500 },

  heroRow: { display: 'flex', gap: 8, marginBottom: 12 },
  heroStat: { flex: 1, background: '#fff', borderRadius: 12, padding: '12px 8px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  heroNum: { display: 'block', fontSize: 20, fontWeight: 700, color: '#C76B8A' },
  heroLabel: { display: 'block', fontSize: 10, color: '#AAA5A0', textTransform: 'uppercase', marginTop: 2 },

  tabs: { display: 'flex', gap: 16, borderBottom: '1px solid #F0ECE8', marginBottom: 14, overflowX: 'auto' },
  tab: { padding: '10px 0', background: 'none', border: 'none', borderBottom: '2px solid transparent', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },

  body: { display: 'flex', flexDirection: 'column', gap: 10 },

  card: { background: '#fff', borderRadius: 14, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  cardTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: '#2D2A26' },

  tierRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid #F5F2EF' },
  tierName: { display: 'block', fontSize: 13, fontWeight: 700 },
  tierPerks: { display: 'block', fontSize: 11, color: '#8A8580', marginTop: 1 },
  tierMin: { fontSize: 11, color: '#AAA5A0', fontWeight: 600 },

  earnRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #F5F2EF' },
  earnAction: { flex: 1, fontSize: 13, color: '#2D2A26' },
  earnPoints: { fontSize: 13, fontWeight: 700, color: '#4CAF50' },

  memberCard: { background: '#fff', borderRadius: 14, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  memberTop: { display: 'flex', alignItems: 'center', gap: 10 },
  memberAvatar: { width: 36, height: 36, borderRadius: 18, background: '#FBF0F3', color: '#C76B8A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700 },
  memberName: { display: 'block', fontSize: 14, fontWeight: 600 },
  memberTier: { display: 'block', fontSize: 11, fontWeight: 600, marginTop: 1 },
  memberPoints: { textAlign: 'right' },
  memberPointsNum: { display: 'block', fontSize: 18, fontWeight: 700, color: '#C76B8A' },
  memberPointsLabel: { display: 'block', fontSize: 9, color: '#AAA5A0', textTransform: 'uppercase' },

  progressSection: { marginTop: 10 },
  progressTrack: { height: 4, borderRadius: 2, background: '#F5F2EF', overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2, transition: 'width 0.3s ease' },
  progressHint: { display: 'block', fontSize: 10, color: '#C4BDB6', marginTop: 4 },

  rewardsIntro: { fontSize: 13, color: '#8A8580', margin: '0 0 4px', lineHeight: 1.5 },
  rewardCard: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: 14, background: '#fff', borderRadius: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', cursor: 'pointer',
  },
  rewardName: { display: 'block', fontSize: 13, fontWeight: 600, color: '#2D2A26' },
  rewardType: { display: 'block', fontSize: 10, color: '#AAA5A0', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2 },
  rewardCost: { fontSize: 13, fontWeight: 700, color: '#C76B8A', flexShrink: 0 },
  addRewardBtn: {
    padding: '12px 0', borderRadius: 12, border: '1.5px dashed #E0DBD5',
    background: 'transparent', color: '#C76B8A', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center',
  },

  settingRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #F5F2EF' },
  settingLabel: { display: 'block', fontSize: 13, fontWeight: 600, color: '#2D2A26' },
  settingHint: { display: 'block', fontSize: 11, color: '#AAA5A0', marginTop: 2 },
  settingValue: { fontSize: 12, fontWeight: 600, color: '#C76B8A', flexShrink: 0 },
  toggle: { width: 40, height: 24, borderRadius: 12, padding: 2, cursor: 'pointer', flexShrink: 0 },
  toggleDot: { width: 20, height: 20, borderRadius: 10, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.15)', transition: 'transform 0.2s ease' },

  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', justifyContent: 'center', alignItems: 'flex-end' },
  detailPanel: { background: '#FAF8F5', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 480, padding: '20px 16px 40px', position: 'relative' },
  closeBtn: { position: 'absolute', top: 12, right: 16, background: 'none', border: 'none', fontSize: 24, color: '#AAA5A0', cursor: 'pointer' },
  detailTitle: { fontSize: 18, fontWeight: 700, margin: '0 0 4px' },
  detailCost: { fontSize: 14, color: '#C76B8A', fontWeight: 600 },
  detailInfo: { marginTop: 20 },
  detailInfoRow: { display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #F0ECE8' },
  detailInfoLabel: { fontSize: 12, color: '#AAA5A0' },
  detailInfoValue: { fontSize: 12, fontWeight: 600, color: '#2D2A26' },

  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 6px' },
  emptyDesc: { fontSize: 13, color: '#AAA5A0', margin: 0, lineHeight: 1.5 },
};
