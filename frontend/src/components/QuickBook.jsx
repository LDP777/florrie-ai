/**
 * QuickBook — floating action button + slide-up booking modal.
 *
 * Appears on every authenticated page. Tap the "+" to open a fast
 * booking form: pick client → treatment → date/time → confirm.
 * In dev mode, uses mock data. Supabase wiring later.
 */
import { useState, useMemo } from 'react';
const HOURS = [];
for (let h = 9; h <= 19; h++) {
  HOURS.push(`${String(h).padStart(2, '0')}:00`);
  if (h < 19) HOURS.push(`${String(h).padStart(2, '0')}:30`);
}
function getNextDays(count) {
  const days = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    days.push(d);
  }
  return days;
}
const dayLabel = d => {
  const today = new Date();
  const diff = Math.floor((d - today) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};
export default function QuickBook() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0); // 0=client, 1=treatment, 2=datetime, 3=confirm
  const [clientSearch, setClientSearch] = useState('');
  const [selectedClient, setSelectedClient] = useState(null);
  const [selectedTreatment, setSelectedTreatment] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedTime, setSelectedTime] = useState(null);
  const [booked, setBooked] = useState(false);
  const clients = useMemo(() => {
    if (!clientSearch) return [];
    const s = clientSearch.toLowerCase();
    return clients.filter(c =>
      c.first_name.toLowerCase().includes(s) || (c.last_name || '').toLowerCase().includes(s)
    );
  }, [clientSearch]);
  const treatments = (loadedTreatments || []).filter(t => t.is_active);
  const days = useMemo(() => getNextDays(14), []);
  function reset() {
    setStep(0);
    setClientSearch('');
    setSelectedClient(null);
    setSelectedTreatment(null);
    setSelectedDate(null);
    setSelectedTime(null);
    setBooked(false);
  }
  function handleOpen() {
    reset();
    setOpen(true);
  }
  function handleClose() {
    setOpen(false);
  }
  function handleConfirm() {
    setBooked(true);
    setTimeout(() => {
      setOpen(false);
      reset();
    }, 1800);
  }
  const pence = v => `£${(v / 100).toFixed(2)}`;
  return (
    <>
      {/* Floating action button */}
      {!open && (
        <button onClick={handleOpen} style={s.fab} aria-label="Quick book">
          <span style={s.fabIcon}>+</span>
        </button>
      )}
      {/* Modal overlay */}
      {open && (
        <div style={s.overlay} onClick={handleClose}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={s.modalHeader}>
              <button
                onClick={() => step > 0 && !booked ? setStep(step - 1) : handleClose()}
                style={s.backBtn}
              >
                {step > 0 && !booked ? '‹ Back' : '× Close'}
              </button>
              <span style={s.modalTitle}>
                {booked ? 'Booked!' : ['Pick client', 'Pick treatment', 'Pick time', 'Confirm'][step]}
              </span>
              <span style={s.stepIndicator}>{!booked && `${step + 1}/4`}</span>
            </div>
            {/* Booked confirmation */}
            {booked && (
              <div style={s.bookedView}>
                <div style={s.bookedCheck}>✓</div>
                <p style={s.bookedText}>
                  {selectedClient?.first_name} booked for {selectedTreatment?.name}
                </p>
                <p style={s.bookedSub}>
                  {dayLabel(selectedDate)} at {selectedTime}
                </p>
              </div>
            )}
            {/* Step 0: Client */}
            {!booked && step === 0 && (
              <div style={s.stepContent}>
                <input
                  type="text"
                  placeholder="Search clients..."
                  value={clientSearch}
                  onChange={e => setClientSearch(e.target.value)}
                  style={s.searchInput}
                  autoFocus
                />
                <div style={s.scrollList}>
                  {/* Walk-in option */}
                  <button
                    onClick={() => {
                      setSelectedClient({ id: 'walk-in', first_name: 'Walk-in', last_name: '' });
                      setStep(1);
                    }}
                    style={s.listItem}
                  >
                    <div style={{ ...s.avatar, background: '#E8F5E9', color: '#4CAF50' }}>W</div>
                    <div style={s.itemInfo}>
                      <span style={s.itemName}>Walk-in client</span>
                      <span style={s.itemMeta}>No client record</span>
                    </div>
                  </button>
                  {clients.map(c => (
                    <button
                      key={c.id}
                      onClick={() => { setSelectedClient(c); setStep(1); }}
                      style={s.listItem}
                    >
                      <div style={s.avatar}>{c.first_name[0]}</div>
                      <div style={s.itemInfo}>
                        <span style={s.itemName}>{c.first_name} {c.last_name || ''}</span>
                        <span style={s.itemMeta}>{c.total_visits || 0} visits</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Step 1: Treatment */}
            {!booked && step === 1 && (
              <div style={s.stepContent}>
                <div style={s.scrollList}>
                  {treatments.map(t => (
                    <button
                      key={t.id}
                      onClick={() => { setSelectedTreatment(t); setStep(2); }}
                      style={s.listItem}
                    >
                      <div style={s.itemInfo}>
                        <span style={s.itemName}>{t.name}</span>
                        <span style={s.itemMeta}>{t.duration_minutes}min · {pence(t.price_cents)}</span>
                      </div>
                      <span style={s.itemPrice}>{pence(t.price_cents)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Step 2: Date & Time */}
            {!booked && step === 2 && (
              <div style={s.stepContent}>
                <span style={s.sectionLabel}>Date</span>
                <div style={s.dateRow}>
                  {days.map(d => {
                    const key = d.toISOString().split('T')[0];
                    const active = selectedDate && selectedDate.toISOString().split('T')[0] === key;
                    return (
                      <button
                        key={key}
                        onClick={() => setSelectedDate(d)}
                        style={{
                          ...s.dateChip,
                          background: active ? '#C76B8A' : '#fff',
                          color: active ? '#fff' : 'var(--text, #2D2A26)',
                          border: active ? '1px solid #C76B8A' : '1px solid #F0ECE8',
                        }}
                      >
                        <span style={{ fontSize: 11, fontWeight: 600 }}>
                          {d.toLocaleDateString('en-GB', { weekday: 'short' })}
                        </span>
                        <span style={{ fontSize: 16, fontWeight: 700 }}>{d.getDate()}</span>
                        <span style={{ fontSize: 10 }}>
                          {d.toLocaleDateString('en-GB', { month: 'short' })}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {selectedDate && (
                  <>
                    <span style={{ ...s.sectionLabel, marginTop: 14 }}>Time</span>
                    <div style={s.timeGrid}>
                      {HOURS.map(h => {
                        const active = selectedTime === h;
                        return (
                          <button
                            key={h}
                            onClick={() => setSelectedTime(h)}
                            style={{
                              ...s.timeChip,
                              background: active ? '#C76B8A' : '#fff',
                              color: active ? '#fff' : 'var(--text, #2D2A26)',
                              border: active ? '1px solid #C76B8A' : '1px solid #F0ECE8',
                            }}
                          >
                            {h}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
                {selectedDate && selectedTime && (
                  <button onClick={() => setStep(3)} style={s.nextBtn}>
                    Continue
                  </button>
                )}
              </div>
            )}
            {/* Step 3: Confirm */}
            {!booked && step === 3 && (
              <div style={s.stepContent}>
                <div style={s.confirmCard}>
                  <div style={s.confirmRow}>
                    <span style={s.confirmLabel}>Client</span>
                    <span style={s.confirmValue}>{selectedClient?.first_name} {selectedClient?.last_name || ''}</span>
                  </div>
                  <div style={s.confirmRow}>
                    <span style={s.confirmLabel}>Treatment</span>
                    <span style={s.confirmValue}>{selectedTreatment?.name}</span>
                  </div>
                  <div style={s.confirmRow}>
                    <span style={s.confirmLabel}>Duration</span>
                    <span style={s.confirmValue}>{selectedTreatment?.duration_minutes} min</span>
                  </div>
                  <div style={s.confirmRow}>
                    <span style={s.confirmLabel}>Date</span>
                    <span style={s.confirmValue}>{dayLabel(selectedDate)}</span>
                  </div>
                  <div style={s.confirmRow}>
                    <span style={s.confirmLabel}>Time</span>
                    <span style={s.confirmValue}>{selectedTime}</span>
                  </div>
                  <div style={{ ...s.confirmRow, borderBottom: 'none' }}>
                    <span style={s.confirmLabel}>Price</span>
                    <span style={{ ...s.confirmValue, color: '#C76B8A', fontWeight: 700 }}>
                      {pence(selectedTreatment?.price_cents)}
                    </span>
                  </div>
                </div>
                <button onClick={handleConfirm} style={s.confirmBtn}>
                  Confirm Booking
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
const s = {
  fab: {
    position: 'fixed',
    bottom: 80,
    right: 20,
    width: 52,
    height: 52,
    borderRadius: 26,
    background: 'linear-gradient(135deg, #C76B8A, #B55A79)',
    border: 'none',
    boxShadow: '0 4px 14px rgba(199,107,138,0.4)',
    cursor: 'pointer',
    zIndex: 90,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabIcon: {
    fontSize: 26,
    color: '#fff',
    fontWeight: 300,
    lineHeight: 1,
  },
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.3)',
    zIndex: 300,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  modal: {
    background: 'var(--bg, #FAF8F5)',
    borderRadius: '20px 20px 0 0',
    width: '100%',
    maxWidth: 480,
    maxHeight: '88vh',
    overflowY: 'auto',
    padding: '0 0 32px',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 16px 12px',
    borderBottom: '1px solid var(--border, #F0ECE8)',
    position: 'sticky',
    top: 0,
    background: 'var(--bg, #FAF8F5)',
    zIndex: 1,
  },
  backBtn: {
    background: 'none',
    border: 'none',
    fontSize: 14,
    color: '#C76B8A',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontWeight: 500,
    padding: 0,
    minWidth: 60,
    textAlign: 'left',
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text, #2D2A26)',
  },
  stepIndicator: {
    fontSize: 12,
    color: 'var(--text-muted, #AAA5A0)',
    minWidth: 60,
    textAlign: 'right',
  },
  stepContent: {
    padding: '12px 16px',
  },
  searchInput: {
    width: '100%',
    padding: '11px 14px',
    borderRadius: 10,
    border: '1.5px solid var(--border, #F0ECE8)',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
    background: 'var(--card-bg, #fff)',
    marginBottom: 10,
  },
  scrollList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    maxHeight: '55vh',
    overflowY: 'auto',
  },
  listItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '11px 12px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--card-bg, #fff)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    width: '100%',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    background: 'linear-gradient(135deg, #C76B8A22, #C76B8A44)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    fontWeight: 700,
    color: '#C76B8A',
    flexShrink: 0,
  },
  itemInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  },
  itemName: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text, #2D2A26)',
  },
  itemMeta: {
    fontSize: 12,
    color: 'var(--text-muted, #AAA5A0)',
  },
  itemPrice: {
    fontSize: 14,
    fontWeight: 700,
    color: '#C76B8A',
  },
  sectionLabel: {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-muted, #AAA5A0)',
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    marginBottom: 8,
  },
  dateRow: {
    display: 'flex',
    gap: 6,
    overflowX: 'auto',
    paddingBottom: 8,
  },
  dateChip: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 1,
    padding: '8px 10px',
    borderRadius: 10,
    cursor: 'pointer',
    fontFamily: 'inherit',
    minWidth: 50,
    flexShrink: 0,
  },
  timeGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 6,
  },
  timeChip: {
    padding: '10px 0',
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 500,
    textAlign: 'center',
  },
  nextBtn: {
    width: '100%',
    padding: '13px 0',
    marginTop: 16,
    borderRadius: 12,
    border: 'none',
    background: '#C76B8A',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  confirmCard: {
    background: 'var(--card-bg, #fff)',
    borderRadius: 14,
    padding: '4px 16px',
    marginBottom: 16,
  },
  confirmRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '13px 0',
    borderBottom: '1px solid var(--border, #F0ECE8)',
  },
  confirmLabel: {
    fontSize: 13,
    color: 'var(--text-muted, #AAA5A0)',
  },
  confirmValue: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text, #2D2A26)',
  },
  confirmBtn: {
    width: '100%',
    padding: '14px 0',
    borderRadius: 12,
    border: 'none',
    background: 'linear-gradient(135deg, #C76B8A, #B55A79)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: '0 4px 14px rgba(199,107,138,0.3)',
  },
  bookedView: {
    textAlign: 'center',
    padding: '40px 20px',
  },
  bookedCheck: {
    width: 56,
    height: 56,
    borderRadius: 28,
    background: '#E8F5E9',
    color: '#4CAF50',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 28,
    fontWeight: 700,
    margin: '0 auto 16px',
  },
  bookedText: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--text, #2D2A26)',
    margin: '0 0 4px',
  },
  bookedSub: {
    fontSize: 13,
    color: 'var(--text-muted, #AAA5A0)',
    margin: 0,
  },
};
