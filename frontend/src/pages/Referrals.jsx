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
import { useBeautician, supabase, fetchRows, updateRow } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

function getToken() {
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try { const p = JSON.parse(raw); return p?.access_token || p?.session?.access_token || raw; }
  catch { return raw; }
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
  const [friendReward, setFriendReward] = useState(10);
  const [rewardType, setRewardType] = useState('discount');
  const [expiryDays, setExpiryDays] = useState(30);
  const [autoReward, setAutoReward] = useState(true);
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
      const token = getToken();
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
        // Backend stores cents — split between referrer/friend (same value for now)
        const pounds = Math.round(cfg.referral_reward_value_cents / 100);
        setReferrerReward(pounds);
        setFriendReward(pounds);
      }
    } catch (err) {
      logger.warn('Load referral config failed:', err);
    }
  }

  async function saveConfig() {
    setSaving(true);
    try {
      const token = getToken();
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
