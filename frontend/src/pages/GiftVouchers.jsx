import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Gift Vouchers — Create, send & redeem digital gift vouchers.
 *
 * Tabs:
 *   Active   — vouchers in circulation (not yet redeemed/expired)
 *   Create   — make a new voucher (amount or treatment-specific)
 *   History  — redeemed + expired vouchers
 */


const fmt = (cents) => `£${(cents / 100).toFixed(2)}`;
const AMOUNTS = [2000, 2500, 3000, 4000, 5000, 7500, 10000];

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'GIFT-';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default function GiftVouchers() {
  const { beautician, loading: bLoading } = useBeautician();
  const [vouchers, setVouchers] = useState([]);
  const [tab, setTab] = useState('active');
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showRedeem, setShowRedeem] = useState(null);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeemSearch, setRedeemSearch] = useState(null);

  // Create form
  const [form, setForm] = useState({
    type: 'amount', amount_cents: 5000, treatment_id: '',
    buyer_name: '', recipient_name: '', recipient_email: '',
    message: '', expires_months: 6,
  });

  useEffect(() => { loadData(); }, [beautician, bLoading]);

  async function loadData() {
    setLoading(true);
    if (bLoading || !beautician) {
      setLoading(false);
      return;
    }
