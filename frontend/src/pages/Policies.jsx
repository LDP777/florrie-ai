/**
 * Policies — Deposits, cancellation rules, no-show fees.
 *
 * Sections:
 *   Deposits     — require deposit on booking, amount, which treatments
 *   Cancellation — cancellation window, fee structure
 *   No-shows     — fee, strike system, auto-block
 *   Client-facing — preview of the policy clients see at booking
 */
import { useState, useEffect } from 'react';
import { useBeautician, supabase, isDevMode, updateRow } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import logger from '../lib/logger.js';

const DEPOSIT_TYPES = [
  { key: 'fixed', label: 'Fixed amount' },
  { key: 'percent', label: 'Percentage' },
];

const CANCEL_WINDOWS = [
  { key: 24, label: '24 hours' },
  { key: 48, label: '48 hours' },
  { key: 72, label: '72 hours' },
];

const NOSHOW_ACTIONS = [
  { key: 'fee', label: 'Charge a fee', icon: '💷' },
  { key: 'strike', label: 'Strike system', icon: '⚠️' },
  { key: 'block', label: 'Auto-block after X', icon: '🚫' },
];

export default function Policies() {
  const { dark } = useTheme();
  const { beautician, loading: bLoading } = useBeautician();
  const [loading, setLoading] = useState(true);

  // Deposit settings
  const [depositEnabled, setDepositEnabled] = useState(true);
  const [depositType, setDepositType] = useState('fixed');
  const [depositAmount, setDepositAmount] = useState(10);
  const [depositPercent, setDepositPercent] = useState(50);
  const [depositMinPrice, setDepositMinPrice] = useState(25);
  const [depositRefundable, setDepositRefundable] = useState(true);

  // Cancellation settings
  const [cancelWindow, setCancelWindow] = useState(24);
  const [cancelFeeEnabled, setCancelFeeEnabled] = useState(true);
  const [cancelFeeType, setCancelFeeType] = useState('deposit'); // deposit | fixed | percent
  const [cancelFeeFixed, setCancelFeeFixed] = useState(10);
  const [cancelFeePercent, setCancelFeePercent] = useState(50);
  const [lateCancelMessage, setLateCancelMessage] = useState(
    "Hey lovely, just so you know we need at least 24 hours notice for cancellations — otherwise a fee may apply. No stress, just a heads up xx"
  );

  // No-show settings
  const [noshowAction, setNoshowAction] = useState('strike');
  const [noshowFee, setNoshowFee] = useState(20);
  const [noshowStrikesMax, setNoshowStrikesMax] = useState(2);
  const [noshowBlockEnabled, setNoshowBlockEnabled] = useState(true);
  const [noshowBlockAfter, setNoshowBlockAfter] = useState(3);

  // Preview
  const [showPreview, setShowPreview] = useState(false);

  const [tab, setTab] = useState('deposits');
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (beautician) loadPolicies(); }, [beautician]);

  async function loadPolicies() {
    setLoading(true);
    try {
      if (!isDevMode && beautician) {
        const { data } = await supabase
          .from('policies')
          .select('*')
          .eq('beautician_id', beautician.id)
          .single();
        if (data) {
          setDepositEnabled(data.deposit_enabled ?? true);
          setDepositType(data.deposit_type ?? 'fixed');
          setDepositAmount(data.deposit_amount ?? 10);
          setDepositPercent(data.deposit_percent ?? 50);
          setDepositMinPrice(data.deposit_min_price ?? 25);
          setDepositRefundable(data.deposit_refundable ?? true);
          setCancelWindow(data.cancel_window ?? 24);
          setCancelFeeEnabled(data.cancel_fee_enabled ?? true);
          setCancelFeeType(data.cancel_fee_type ?? 'deposit');
          setCancelFeeFixed(data.cancel_fee_fixed ?? 10);
          setCancelFeePercent(data.cancel_fee_percent ?? 50);
          setLateCancelMessage(data.late_cancel_message ?? "Hey lovely, just so you know we need at least 24 hours notice for cancellations — otherwise a fee may apply. No stress, just a heads up xx");
          setNoshowAction(data.noshow_action ?? 'strike');
          setNoshowFee(data.noshow_fee ?? 20);
          setNoshowStrikesMax(data.noshow_strikes_max ?? 2);
          setNoshowBlockEnabled(data.noshow_block_enabled ?? true);
          setNoshowBlockAfter(data.noshow_block_after ?? 3);
        }
      }
    } catch (err) {
      logger.error('Load policies error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!beautician || isDevMode) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return;
    }
    const payload = {
      deposit_enabled: depositEnabled,
      deposit_type: depositType,
      deposit_amount: depositAmount,
      deposit_percent: depositPercent,
      deposit_min_price: depositMinPrice,
      deposit_refundable: depositRefundable,
      cancel_window: cancelWindow,
      cancel_fee_enabled: cancelFeeEnabled,
      cancel_fee_type: cancelFeeType,
      cancel_fee_fixed: cancelFeeFixed,
      cancel_fee_percent: cancelFeePercent,
      late_cancel_message: lateCancelMessage,
      noshow_action: noshowAction,
      noshow_fee: noshowFee,
      noshow_strikes_max: noshowStrikesMax,
      noshow_block_enabled: noshowBlockEnabled,
      noshow_block_after: noshowBlockAfter,
    };
    try {
      await updateRow('policies', beautician.id, payload);
    } catch (err) {
      logger.error('Save policies error:', err);
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const tabs = [
    { key: 'deposits', label: 'Deposits' },
    { key: 'cancellation', label: 'Cancellation' },
    { key: 'noshow', label: 'No-shows' },
  ];

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Policies</h1>
        <p style={s.sub}>Deposits, cancellations & no-show rules</p>
      </div>

      {/* Tab bar */}
      <div style={s.tabBar}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              ...s.tab,
              color: tab === t.key ? 'var(--accent, #C76B8A)' : 'var(--text-muted, var(--text-muted, var(--text-muted, #B5AFA8)))',
              borderBottom: tab === t.key ? '2px solid var(--accent, #C76B8A)' : '2px solid transparent',
              fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Deposits tab */}
      {tab === 'deposits' && (
        <div style={s.section}>
          <div style={s.toggleRow}>
            <div>
              <span style={s.toggleLabel}>Require deposit</span>
              <span style={s.toggleDesc}>Clients pay upfront when booking</span>
            </div>
            <button
              onClick={() => setDepositEnabled(!depositEnabled)}
              style={{ ...s.toggle, background: depositEnabled ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, #EDE9E4))' }}
            >
              <div style={{ ...s.toggleThumb, transform: depositEnabled ? 'translateX(18px)' : 'translateX(2px)' }} />
            </button>
          </div>

          {depositEnabled && (
            <>
              <div style={s.card}>
                <span style={s.cardLabel}>Deposit type</span>
                <div style={s.chipRow}>
                  {DEPOSIT_TYPES.map(t => (
                    <button
                      key={t.key}
                      onClick={() => setDepositType(t.key)}
                      style={{
                        ...s.chip,
                        background: depositType === t.key ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                        color: depositType === t.key ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                        border: depositType === t.key ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {depositType === 'fixed' && (
                <div style={s.card}>
                  <span style={s.cardLabel}>Deposit amount</span>
                  <div style={s.amountRow}>
                    {[5, 10, 15, 20, 25].map(v => (
                      <button
                        key={v}
                        onClick={() => setDepositAmount(v)}
                        style={{
                          ...s.amountChip,
                          background: depositAmount === v ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                          color: depositAmount === v ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                          border: depositAmount === v ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                        }}
                      >
                        £{v}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {depositType === 'percent' && (
                <div style={s.card}>
                  <span style={s.cardLabel}>Deposit percentage</span>
                  <div style={s.amountRow}>
                    {[25, 50, 75, 100].map(v => (
                      <button
                        key={v}
                        onClick={() => setDepositPercent(v)}
                        style={{
                          ...s.amountChip,
                          background: depositPercent === v ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                          color: depositPercent === v ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                          border: depositPercent === v ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                        }}
                      >
                        {v}%
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div style={s.card}>
                <span style={s.cardLabel}>Only for bookings over</span>
                <div style={s.amountRow}>
                  {[0, 15, 25, 50].map(v => (
                    <button
                      key={v}
                      onClick={() => setDepositMinPrice(v)}
                      style={{
                        ...s.amountChip,
                        background: depositMinPrice === v ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                        color: depositMinPrice === v ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                        border: depositMinPrice === v ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                      }}
                    >
                      {v === 0 ? 'All' : `£${v}+`}
                    </button>
                  ))}
                </div>
              </div>

              <div style={s.toggleRow}>
                <div>
                  <span style={s.toggleLabel}>Refundable if cancelled in time</span>
                  <span style={s.toggleDesc}>Deposit returned if cancelled within your window</span>
                </div>
                <button
                  onClick={() => setDepositRefundable(!depositRefundable)}
                  style={{ ...s.toggle, background: depositRefundable ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, #EDE9E4))' }}
                >
                  <div style={{ ...s.toggleThumb, transform: depositRefundable ? 'translateX(18px)' : 'translateX(2px)' }} />
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Cancellation tab */}
      {tab === 'cancellation' && (
        <div style={s.section}>
          <div style={s.card}>
            <span style={s.cardLabel}>Cancellation window</span>
            <span style={s.cardDesc}>How much notice clients need to give</span>
            <div style={s.chipRow}>
              {CANCEL_WINDOWS.map(w => (
                <button
                  key={w.key}
                  onClick={() => setCancelWindow(w.key)}
                  style={{
                    ...s.chip,
                    background: cancelWindow === w.key ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                    color: cancelWindow === w.key ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                    border: cancelWindow === w.key ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                  }}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          <div style={s.toggleRow}>
            <div>
              <span style={s.toggleLabel}>Late cancellation fee</span>
              <span style={s.toggleDesc}>Charge when cancelled after the window</span>
            </div>
            <button
              onClick={() => setCancelFeeEnabled(!cancelFeeEnabled)}
              style={{ ...s.toggle, background: cancelFeeEnabled ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, #EDE9E4))' }}
            >
              <div style={{ ...s.toggleThumb, transform: cancelFeeEnabled ? 'translateX(18px)' : 'translateX(2px)' }} />
            </button>
          </div>

          {cancelFeeEnabled && (
            <div style={s.card}>
              <span style={s.cardLabel}>Fee amount</span>
              <div style={s.chipRow}>
                <button
                  onClick={() => setCancelFeeType('deposit')}
                  style={{
                    ...s.chip,
                    background: cancelFeeType === 'deposit' ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                    color: cancelFeeType === 'deposit' ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                    border: cancelFeeType === 'deposit' ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                  }}
                >
                  Keep deposit
                </button>
                <button
                  onClick={() => setCancelFeeType('fixed')}
                  style={{
                    ...s.chip,
                    background: cancelFeeType === 'fixed' ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                    color: cancelFeeType === 'fixed' ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                    border: cancelFeeType === 'fixed' ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                  }}
                >
                  Fixed fee
                </button>
                <button
                  onClick={() => setCancelFeeType('percent')}
                  style={{
                    ...s.chip,
                    background: cancelFeeType === 'percent' ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                    color: cancelFeeType === 'percent' ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                    border: cancelFeeType === 'percent' ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                  }}
                >
                  % of price
                </button>
              </div>
              {cancelFeeType === 'fixed' && (
                <div style={{ ...s.amountRow, marginTop: 10 }}>
                  {[5, 10, 15, 20].map(v => (
                    <button
                      key={v}
                      onClick={() => setCancelFeeFixed(v)}
                      style={{
                        ...s.amountChip,
                        background: cancelFeeFixed === v ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                        color: cancelFeeFixed === v ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                        border: cancelFeeFixed === v ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                      }}
                    >
                      £{v}
                    </button>
                  ))}
                </div>
              )}
              {cancelFeeType === 'percent' && (
                <div style={{ ...s.amountRow, marginTop: 10 }}>
                  {[25, 50, 75, 100].map(v => (
                    <button
                      key={v}
                      onClick={() => setCancelFeePercent(v)}
                      style={{
                        ...s.amountChip,
                        background: cancelFeePercent === v ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                        color: cancelFeePercent === v ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                        border: cancelFeePercent === v ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                      }}
                    >
                      {v}%
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={s.card}>
            <span style={s.cardLabel}>Late cancel message</span>
            <span style={s.cardDesc}>Sent automatically to the client</span>
            <textarea
              value={lateCancelMessage}
              onChange={e => setLateCancelMessage(e.target.value)}
              style={s.textarea}
              rows={3}
            />
          </div>
        </div>
      )}

      {/* No-show tab */}
      {tab === 'noshow' && (
        <div style={s.section}>
          <div style={s.card}>
            <span style={s.cardLabel}>No-show consequence</span>
            <div style={s.actionGrid}>
              {NOSHOW_ACTIONS.map(a => (
                <button
                  key={a.key}
                  onClick={() => setNoshowAction(a.key)}
                  style={{
                    ...s.actionCard,
                    border: noshowAction === a.key ? '2px solid var(--accent, #C76B8A)' : '2px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                    background: noshowAction === a.key ? 'var(--accent-light, #FFF0F3)' : 'var(--card-bg, #fff)',
                  }}
                >
                  <span style={{ fontSize: 22 }}>{a.icon}</span>
                  <span style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: noshowAction === a.key ? 'var(--accent, #C76B8A)' : 'var(--text, var(--text-primary, #2D2A26))',
                  }}>{a.label}</span>
                </button>
              ))}
            </div>
          </div>

          {noshowAction === 'fee' && (
            <div style={s.card}>
              <span style={s.cardLabel}>No-show fee</span>
              <div style={s.amountRow}>
                {[10, 15, 20, 25, 50].map(v => (
                  <button
                    key={v}
                    onClick={() => setNoshowFee(v)}
                    style={{
                      ...s.amountChip,
                      background: noshowFee === v ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                      color: noshowFee === v ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                      border: noshowFee === v ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                    }}
                  >
                    £{v}
                  </button>
                ))}
              </div>
            </div>
          )}

          {noshowAction === 'strike' && (
            <div style={s.card}>
              <span style={s.cardLabel}>Strikes before action</span>
              <div style={s.amountRow}>
                {[1, 2, 3].map(v => (
                  <button
                    key={v}
                    onClick={() => setNoshowStrikesMax(v)}
                    style={{
                      ...s.amountChip,
                      background: noshowStrikesMax === v ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                      color: noshowStrikesMax === v ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                      border: noshowStrikesMax === v ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                    }}
                  >
                    {v} strike{v !== 1 ? 's' : ''}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={s.toggleRow}>
            <div>
              <span style={s.toggleLabel}>Auto-block repeat offenders</span>
              <span style={s.toggleDesc}>Block from booking online after too many no-shows</span>
            </div>
            <button
              onClick={() => setNoshowBlockEnabled(!noshowBlockEnabled)}
              style={{ ...s.toggle, background: noshowBlockEnabled ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, #EDE9E4))' }}
            >
              <div style={{ ...s.toggleThumb, transform: noshowBlockEnabled ? 'translateX(18px)' : 'translateX(2px)' }} />
            </button>
          </div>

          {noshowBlockEnabled && (
            <div style={s.card}>
              <span style={s.cardLabel}>Block after</span>
              <div style={s.amountRow}>
                {[2, 3, 5].map(v => (
                  <button
                    key={v}
                    onClick={() => setNoshowBlockAfter(v)}
                    style={{
                      ...s.amountChip,
                      background: noshowBlockAfter === v ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                      color: noshowBlockAfter === v ? '#fff' : 'var(--text, var(--text-primary, #2D2A26))',
                      border: noshowBlockAfter === v ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
                    }}
                  >
                    {v} no-shows
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Preview button */}
      <button onClick={() => setShowPreview(!showPreview)} style={s.previewBtn}>
        {showPreview ? 'Hide' : 'Preview'} client-facing policy
      </button>

      {showPreview && (
        <div style={s.previewCard}>
          <div style={s.previewHeader}>
            <span style={s.previewBrand}>Ellindigo Brows & Beauty</span>
            <span style={s.previewTitle}>Booking Policy</span>
          </div>
          <div style={s.previewBody}>
            {depositEnabled && (
              <p style={s.previewText}>
                A {depositType === 'fixed' ? `£${depositAmount}` : `${depositPercent}%`} deposit is required
                {depositMinPrice > 0 ? ` for treatments over £${depositMinPrice}` : ''} to secure your booking.
                {depositRefundable ? ` This is fully refundable if you cancel with at least ${cancelWindow} hours notice.` : ''}
              </p>
            )}
            <p style={s.previewText}>
              Please give at least {cancelWindow} hours notice if you need to cancel or reschedule.
              {cancelFeeEnabled ? ` Late cancellations may be charged ${
                cancelFeeType === 'deposit' ? 'the deposit amount'
                : cancelFeeType === 'fixed' ? `a £${cancelFeeFixed} fee`
                : `${cancelFeePercent}% of the treatment price`
              }.` : ''}
            </p>
            <p style={s.previewText}>
              {noshowAction === 'fee' ? `No-shows will be charged £${noshowFee}.`
                : noshowAction === 'strike' ? `No-shows receive a strike. After ${noshowStrikesMax} strike${noshowStrikesMax !== 1 ? 's' : ''}, deposits will be required for future bookings.`
                : `Repeated no-shows may result in being unable to book online.`}
            </p>
          </div>
        </div>
      )}

      {/* Save */}
      <button onClick={handleSave} style={s.saveBtn}>
        {saved ? '✓ Saved' : 'Save policies'}
      </button>
    </div>
  );
}

const s = {
  page: {
    padding: '16px 16px 32px',
    maxWidth: 480,
    margin: '0 auto',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
  },
  header: { marginBottom: 16 },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: 'var(--text, var(--text-primary, #2D2A26))',
    margin: 0,
  },
  sub: {
    fontSize: 13,
    color: 'var(--text-muted, var(--text-muted, var(--text-muted, #B5AFA8)))',
    margin: '4px 0 0',
  },
  tabBar: {
    display: 'flex',
    borderBottom: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    padding: '10px 0',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontFamily: 'inherit',
    textAlign: 'center',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  card: {
    background: 'var(--card-bg, #fff)',
    borderRadius: 14,
    padding: 16,
    border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
  },
  cardLabel: {
    display: 'block',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text, var(--text-primary, #2D2A26))',
    marginBottom: 4,
  },
  cardDesc: {
    display: 'block',
    fontSize: 12,
    color: 'var(--text-muted, var(--text-muted, var(--text-muted, #B5AFA8)))',
    marginBottom: 10,
  },
  chipRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 6,
  },
  chip: {
    padding: '8px 14px',
    borderRadius: 20,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  amountRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  amountChip: {
    padding: '8px 16px',
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  toggleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '14px 16px',
    background: 'var(--card-bg, #fff)',
    borderRadius: 14,
    border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
  },
  toggleLabel: {
    display: 'block',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text, var(--text-primary, #2D2A26))',
  },
  toggleDesc: {
    display: 'block',
    fontSize: 12,
    color: 'var(--text-muted, var(--text-muted, var(--text-muted, #B5AFA8)))',
    marginTop: 2,
  },
  toggle: {
    width: 44,
    height: 26,
    borderRadius: 13,
    border: 'none',
    cursor: 'pointer',
    position: 'relative',
    flexShrink: 0,
    transition: 'background 0.2s',
  },
  toggleThumb: {
    width: 22,
    height: 22,
    borderRadius: 11,
    background: '#fff',
    position: 'absolute',
    top: 2,
    transition: 'transform 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
  },
  textarea: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1.5px solid var(--border, var(--border, var(--border, #EDE9E4)))',
    fontSize: 13,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
    resize: 'vertical',
    marginTop: 6,
    background: 'var(--bg, var(--bg, #FAF8F5))',
    color: 'var(--text, var(--text-primary, #2D2A26))',
    lineHeight: 1.5,
  },
  actionGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
    marginTop: 8,
  },
  actionCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    padding: '14px 8px',
    borderRadius: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    background: 'var(--card-bg, #fff)',
  },
  previewBtn: {
    width: '100%',
    padding: '12px 0',
    marginTop: 20,
    borderRadius: 10,
    border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
    background: 'var(--card-bg, #fff)',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--accent, #C76B8A)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  previewCard: {
    marginTop: 12,
    borderRadius: 14,
    overflow: 'hidden',
    border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))',
  },
  previewHeader: {
    background: 'linear-gradient(135deg, var(--accent, #C76B8A), #B55A79)',
    padding: '16px 16px 12px',
  },
  previewBrand: {
    display: 'block',
    fontSize: 11,
    color: '#ffffff99',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
  previewTitle: {
    display: 'block',
    fontSize: 18,
    fontWeight: 700,
    color: '#fff',
    marginTop: 2,
  },
  previewBody: {
    background: 'var(--card-bg, #fff)',
    padding: 16,
  },
  previewText: {
    fontSize: 13,
    lineHeight: 1.6,
    color: 'var(--text, #5A5550)',
    margin: '0 0 10px',
  },
  saveBtn: {
    width: '100%',
    padding: '14px 0',
    marginTop: 16,
    borderRadius: 12,
    border: 'none',
    background: 'linear-gradient(135deg, var(--accent, #C76B8A), #B55A79)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: '0 4px 14px rgba(199,107,138,0.3)',
  },
};
