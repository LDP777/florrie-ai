import { useState, useEffect } from 'react';
import { supabase, isDevMode, DEV_TREATMENTS } from '../lib/supabase.js';
import { useParams, useLocation } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';

/**
 * BookingPage — the public-facing branded booking link.
 * URL: florrie.ai/book/{slug}
 *
 * PUBLIC page — no auth required.
 * Uses Supabase anon client directly.
 * NOTE: Needs public READ policies on beauticians + treatments tables
 *       and public INSERT on appointments + clients for prod use.
 *
 * Flow: Select treatment → Pick date → Pick time slot → Enter details → Confirm
 * Target: Complete booking in under 90 seconds.
 */

const STEPS = ['Treatment', 'Date & Time', 'Your Details', 'Confirm'];

export default function BookingPage() {
  const { slug } = useParams();
  const location = useLocation();
  const isConfirmedReturn = location.pathname.endsWith('/confirmed');
  const isCancelled = new URLSearchParams(location.search).get('cancelled') === 'true';

  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(isCancelled ? 'Payment was cancelled. Your booking slot is held for 15 minutes — you can try again.' : null);
  const [success, setSuccess] = useState(isConfirmedReturn ? { depositPaid: true } : null);
  const [fieldErrors, setFieldErrors] = useState({});

  // Data
  const [beautician, setBeautician] = useState(null);
  const [treatments, setTreatments] = useState([]);
  const [slots, setSlots] = useState([]);

  // User selections
  const [selectedTreatment, setSelectedTreatment] = useState(null);
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [clientDetails, setClientDetails] = useState({
    name: '', email: '', phone: '', notes: ''
  });
  const [consultationAnswers, setConsultationAnswers] = useState({});

  // Default consultation questions for treatments that require them
  const CONSULTATION_QUESTIONS = [
    { key: 'allergies', label: 'Do you have any known allergies? (e.g. latex, adhesive, tint)', type: 'text' },
    { key: 'patch_test', label: 'Have you had a patch test in the last 6 months?', type: 'yesno' },
    { key: 'medical', label: 'Any medical conditions, medications, or recent treatments we should know about?', type: 'text' },
    { key: 'pregnant', label: 'Are you pregnant or breastfeeding?', type: 'yesno' },
    { key: 'previous_reactions', label: 'Have you had any adverse reactions to beauty treatments before?', type: 'text' },
  ];

  const needsConsultation = selectedTreatment?.requires_consultation;

  // Fetch beautician + treatments by slug
  useEffect(() => {
    async function load() {
      try {
        if (isDevMode) {
          setBeautician(DEV_BOOKING_BEAUTICIAN);
          setTreatments(DEV_TREATMENTS.filter(t => t.is_active));
          setLoading(false);
          return;
        }

        // Look up beautician by booking slug
        const { data: b, error: bErr } = await supabase
          .from('beauticians')
          .select('id, first_name, business_name, booking_slug, brand_color, working_hours')
          .eq('booking_slug', slug)
          .maybeSingle();

        if (bErr || !b) {
          setError("This booking page doesn't exist yet.");
          setLoading(false);
          return;
        }

        setBeautician(b);

        // Fetch active treatments
        const { data: tx } = await supabase
          .from('treatments')
          .select('id, name, description, duration_minutes, price_cents, deposit_cents, category')
          .eq('beautician_id', b.id)
          .eq('is_active', true)
          .order('sort_order', { ascending: true });

        setTreatments(tx || []);
      } catch (err) {
        setError("Something went wrong loading this page.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [slug]);

  // Generate available time slots when date changes
  useEffect(() => {
    if (!selectedTreatment || !selectedDate || !beautician) return;

    async function loadSlots() {
      const dayOfWeek = new Date(selectedDate).toLocaleDateString('en-GB', { weekday: 'short' }).toLowerCase();
      const dayKey = { mon: 'mon', tue: 'tue', wed: 'wed', thu: 'thu', fri: 'fri', sat: 'sat', sun: 'sun' }[dayOfWeek];
      const hours = beautician.working_hours?.[dayKey];

      if (!hours || !hours.start || !hours.end) {
        setSlots([]);
        setSelectedSlot(null);
        return;
      }

      // Generate slots from working hours (respects buffer time)
      const duration = selectedTreatment.duration_minutes || 60;
      const buffer = selectedTreatment.buffer_minutes || 0;
      const totalBlock = duration + buffer; // treatment + cleanup/prep
      const [startH, startM] = hours.start.split(':').map(Number);
      const [endH, endM] = hours.end.split(':').map(Number);
      const startMin = startH * 60 + startM;
      const endMin = endH * 60 + endM;

      // Fetch existing appointments for this date to exclude booked slots
      let bookedSlots = [];
      if (!isDevMode) {
        const fromISO = `${selectedDate}T00:00:00`;
        const toISO = `${selectedDate}T23:59:59`;
        const { data: appts } = await supabase
          .from('appointments')
          .select('starts_at, duration_minutes, buffer_minutes')
          .eq('beautician_id', beautician.id)
          .gte('starts_at', fromISO)
          .lte('starts_at', toISO)
          .neq('status', 'cancelled');
        bookedSlots = (appts || []).map(a => ({
          start: new Date(a.starts_at).getHours() * 60 + new Date(a.starts_at).getMinutes(),
          end: new Date(a.starts_at).getHours() * 60 + new Date(a.starts_at).getMinutes() + (a.duration_minutes || 60) + (a.buffer_minutes || 0),
        }));
      }

      const generated = [];
      for (let m = startMin; m + totalBlock <= endMin; m += 30) {
        const isBooked = bookedSlots.some(b => m < b.end && m + totalBlock > b.start);
        if (isBooked) continue;

        const h = Math.floor(m / 60);
        const min = m % 60;
        const display = `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
        const startsAt = `${selectedDate}T${display}:00`;
        generated.push({ starts_at: startsAt, display });
      }

      setSlots(generated);
      setSelectedSlot(null);
    }
    loadSlots();
  }, [selectedDate, selectedTreatment, beautician]);

  // Submit booking via backend API (handles client creation, conflict checks, deposits)
  async function handleBook() {
    setSubmitting(true);
    setError(null);

    try {
      if (isDevMode) {
        setSuccess({
          treatment: selectedTreatment.name,
          date: new Date(selectedSlot.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
          time: selectedSlot.display,
          price: `£${(selectedTreatment.price_cents / 100).toFixed(2)}`,
        });
        return;
      }

      // Call backend API — handles client lookup/creation, RLS, conflict check, deposit flow
      const res = await fetch(`${API_BASE}/api/booking/${slug}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          treatment_id: selectedTreatment.id,
          starts_at: selectedSlot.starts_at,
          client_name: clientDetails.name,
          client_email: clientDetails.email || null,
          client_phone: clientDetails.phone,
          notes: clientDetails.notes || null,
          consultation: needsConsultation ? consultationAnswers : null,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Booking failed');

      // If deposit required and checkout URL returned, redirect to Stripe
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
        return;
      }

      setSuccess({
        treatment: selectedTreatment.name,
        date: new Date(selectedSlot.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
        time: selectedSlot.display,
        price: `£${(selectedTreatment.price_cents / 100).toFixed(2)}`,
        deposit: data.booking?.deposit || null,
      });
    } catch (err) {
      setError(err.message || 'Booking failed');
    } finally {
      setSubmitting(false);
    }
  }

  // Validation helpers
  function isValidEmail(email) {
    if (!email) return true; // Optional field
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
  }

  function isValidPhone(phone) {
    const cleaned = phone.replace(/[^\d]/g, '');
    return cleaned.length >= 10; // At least 10 digits
  }

  function validateStep(currentStep) {
    const errors = {};

    if (currentStep === 0) {
      if (!selectedTreatment) {
        errors.treatment = 'Please select a treatment to continue';
      }
    } else if (currentStep === 1) {
      if (!selectedDate) {
        errors.date = 'Please select a date';
      }
      if (!selectedSlot) {
        errors.slot = 'Please select a time slot';
      }
    } else if (currentStep === 2) {
      if (!clientDetails.name || !clientDetails.name.trim()) {
        errors.name = 'Name is required';
      }
      if (!clientDetails.phone || !clientDetails.phone.trim()) {
        errors.phone = 'Phone number is required';
      } else if (!isValidPhone(clientDetails.phone)) {
        errors.phone = 'Please enter a valid phone number (at least 10 digits)';
      }
      if (clientDetails.email && !isValidEmail(clientDetails.email)) {
        errors.email = 'Please enter a valid email address';
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  // Generate next 14 days for date picker
  function getDateOptions() {
    const dates = [];
    const today = new Date();
    for (let i = 1; i <= 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);

      // Skip days the beautician doesn't work
      if (beautician?.working_hours) {
        const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getDay()];
        const hours = beautician.working_hours[dayKey];
        if (!hours || !hours.start) continue;
      }

      const iso = d.toISOString().split('T')[0];
      const label = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      dates.push({ value: iso, label });
    }
    return dates;
  }

  const brand = beautician?.brand_color || '#C76B8A';
  const brandLight = brand + '18';
  const brandMedium = brand + '40';

  if (loading) {
    return (
      <div style={styles.loadingContainer}>
        <div style={{ ...styles.spinner, borderTopColor: brand }} />
      </div>
    );
  }

  if (error && !beautician) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <p style={{ textAlign: 'center', color: '#8A8580', padding: 40 }}>{error}</p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={{ ...styles.successIcon, background: brandLight, color: brand }}>✓</div>
          <h2 style={styles.successTitle}>
            {success.depositPaid ? "You're booked — deposit paid" : "You're booked"}
          </h2>
          <div style={styles.successDetails}>
            {success.depositPaid ? (
              <p>Your deposit has been received and your appointment is confirmed. You'll get a confirmation message shortly.</p>
            ) : (
              <>
                <p><strong>{success.treatment}</strong></p>
                <p>{success.date} at {success.time}</p>
                <p style={{ color: brand, fontWeight: 600, marginTop: 12 }}>{success.price}</p>
              </>
            )}
          </div>
          <p style={styles.confirmText}>
            {success.depositPaid
              ? 'Your card has been saved for faster checkout next time.'
              : "You'll receive a confirmation message shortly."}
          </p>
        </div>
        <div style={styles.footer}>
          <span style={styles.footerText}>Powered by </span>
          <span style={{ ...styles.footerBrand, color: brand }}>florrie.ai</span>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.businessName}>{beautician?.business_name || beautician?.first_name}</h1>
        <p style={styles.subtitle}>Book your appointment</p>
      </div>

      {/* Progress */}
      <div style={styles.progressContainer}>
        {STEPS.map((label, i) => (
          <div key={label} style={styles.progressStep}>
            <div style={{
              ...styles.progressDot,
              background: i <= step ? brand : '#E5E5E5',
              transform: i === step ? 'scale(1.2)' : 'scale(1)'
            }} />
            <span style={{
              ...styles.progressLabel,
              color: i <= step ? brand : '#999',
              fontWeight: i === step ? 600 : 400
            }}>{label}</span>
          </div>
        ))}
      </div>

      {error && (
        <div style={styles.errorBanner}>
          {error}
          <button onClick={() => setError(null)} style={styles.errorClose}>×</button>
        </div>
      )}

      <div style={styles.card}>
        {/* Step 0: Select Treatment */}
        {step === 0 && (
          <div>
            <h2 style={styles.stepTitle}>Choose your treatment</h2>
            {fieldErrors.treatment && (
              <div style={styles.inlineError}>{fieldErrors.treatment}</div>
            )}
            <div style={styles.treatmentList}>
              {treatments.map(t => (
                <button
                  key={t.id}
                  onClick={() => { setSelectedTreatment(t); setFieldErrors({}); setStep(1); }}
                  style={{
                    ...styles.treatmentCard,
                    borderColor: selectedTreatment?.id === t.id ? brand : '#E8E4DF',
                    background: selectedTreatment?.id === t.id ? brandLight : '#fff'
                  }}
                >
                  <div style={styles.treatmentInfo}>
                    <span style={styles.treatmentName}>{t.name}</span>
                    {t.description && <span style={styles.treatmentDesc}>{t.description}</span>}
                    <span style={styles.treatmentDuration}>{t.duration_minutes} min</span>
                  </div>
                  <span style={{ ...styles.treatmentPrice, color: brand }}>
                    £{(t.price_cents / 100).toFixed(2)}
                  </span>
                </button>
              ))}
            </div>
            {treatments.length === 0 && (
              <p style={styles.noSlots}>No treatments available</p>
            )}
          </div>
        )}

        {/* Step 1: Pick Date & Time */}
        {step === 1 && (
          <div>
            <h2 style={styles.stepTitle}>Pick a date and time</h2>
            {fieldErrors.date && (
              <div style={styles.inlineError}>{fieldErrors.date}</div>
            )}
            <div style={styles.dateScroller}>
              {getDateOptions().map(d => (
                <button
                  key={d.value}
                  onClick={() => { setSelectedDate(d.value); setFieldErrors({}); }}
                  style={{
                    ...styles.dateChip,
                    borderColor: selectedDate === d.value ? brand : '#E8E4DF',
                    background: selectedDate === d.value ? brand : '#fff',
                    color: selectedDate === d.value ? '#fff' : '#333'
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>

            {selectedDate && (
              <div style={styles.slotGrid}>
                {slots.length === 0 ? (
                  <p style={styles.noSlots}>No available slots on this day</p>
                ) : (
                  slots.map(s => (
                    <button
                      key={s.starts_at}
                      onClick={() => { setSelectedSlot(s); setFieldErrors({}); setStep(2); }}
                      style={{
                        ...styles.slotChip,
                        borderColor: selectedSlot?.starts_at === s.starts_at ? brand : '#E8E4DF',
                        background: selectedSlot?.starts_at === s.starts_at ? brand : '#fff',
                        color: selectedSlot?.starts_at === s.starts_at ? '#fff' : '#333'
                      }}
                    >
                      {s.display}
                    </button>
                  ))
                )}
              </div>
            )}
            {fieldErrors.slot && (
              <div style={styles.inlineError}>{fieldErrors.slot}</div>
            )}

            <button onClick={() => setStep(0)} style={styles.backBtn}>← Back</button>
          </div>
        )}

        {/* Step 2: Client Details */}
        {step === 2 && (
          <div>
            <h2 style={styles.stepTitle}>Your details</h2>
            <div style={styles.form}>
              <div>
                <input
                  type="text" placeholder="Your name"
                  value={clientDetails.name}
                  onChange={e => setClientDetails({ ...clientDetails, name: e.target.value })}
                  style={{
                    ...styles.input,
                    borderColor: fieldErrors.name ? '#DC2626' : '#E8E4DF'
                  }} required
                />
                {fieldErrors.name && <span style={styles.fieldErrorText}>{fieldErrors.name}</span>}
              </div>
              <div>
                <input
                  type="tel" placeholder="Phone number"
                  value={clientDetails.phone}
                  onChange={e => setClientDetails({ ...clientDetails, phone: e.target.value })}
                  style={{
                    ...styles.input,
                    borderColor: fieldErrors.phone ? '#DC2626' : '#E8E4DF'
                  }} required
                />
                {fieldErrors.phone && <span style={styles.fieldErrorText}>{fieldErrors.phone}</span>}
              </div>
              <div>
                <input
                  type="email" placeholder="Email (optional)"
                  value={clientDetails.email}
                  onChange={e => setClientDetails({ ...clientDetails, email: e.target.value })}
                  style={{
                    ...styles.input,
                    borderColor: fieldErrors.email ? '#DC2626' : '#E8E4DF'
                  }}
                />
                {fieldErrors.email && <span style={styles.fieldErrorText}>{fieldErrors.email}</span>}
              </div>
              <textarea
                placeholder="Any notes for your appointment? (optional)"
                value={clientDetails.notes}
                onChange={e => setClientDetails({ ...clientDetails, notes: e.target.value })}
                style={{ ...styles.input, minHeight: 80, resize: 'vertical' }}
              />
            </div>

            <div style={styles.buttonRow}>
              <button onClick={() => setStep(1)} style={styles.backBtn}>← Back</button>
              <button
                onClick={() => {
                  if (validateStep(2)) {
                    setStep(needsConsultation ? 2.5 : 3);
                  }
                }}
                disabled={!clientDetails.name || !clientDetails.phone}
                style={{
                  ...styles.primaryBtn,
                  background: (!clientDetails.name || !clientDetails.phone) ? '#ccc' : brand,
                  cursor: (!clientDetails.name || !clientDetails.phone) ? 'not-allowed' : 'pointer'
                }}
              >
                {needsConsultation ? 'Next: Consultation form' : 'Review booking'}
              </button>
            </div>
          </div>
        )}

        {/* Step 2.5: Consultation Form (only for treatments that require it) */}
        {step === 2.5 && (
          <div>
            <h2 style={styles.stepTitle}>Consultation form</h2>
            <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
              Required for {selectedTreatment?.name}. This information helps your beautician prepare and is kept for insurance records.
            </p>
            <div style={styles.formFields}>
              {CONSULTATION_QUESTIONS.map(q => (
                <div key={q.key} style={{ marginBottom: 14 }}>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#444', marginBottom: 4 }}>{q.label}</label>
                  {q.type === 'yesno' ? (
                    <div style={{ display: 'flex', gap: 8 }}>
                      {['Yes', 'No'].map(opt => (
                        <button key={opt} onClick={() => setConsultationAnswers(p => ({ ...p, [q.key]: opt }))}
                          style={{
                            flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                            background: consultationAnswers[q.key] === opt ? brand : '#F0ECE8',
                            color: consultationAnswers[q.key] === opt ? '#fff' : '#666'
                          }}>
                          {opt}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={consultationAnswers[q.key] || ''}
                      onChange={e => setConsultationAnswers(p => ({ ...p, [q.key]: e.target.value }))}
                      placeholder="Type here..."
                      style={styles.input}
                    />
                  )}
                </div>
              ))}
            </div>
            <div style={styles.buttonRow}>
              <button onClick={() => setStep(2)} style={styles.backBtn}>← Back</button>
              <button onClick={() => setStep(3)} style={{ ...styles.primaryBtn, background: brand }}>
                Review booking
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Confirm */}
        {step === 3 && (
          <div>
            <h2 style={styles.stepTitle}>Confirm your booking</h2>

            <div style={styles.summaryCard}>
              <div style={styles.summaryRow}>
                <span style={styles.summaryLabel}>Treatment</span>
                <span style={styles.summaryValue}>{selectedTreatment.name}</span>
              </div>
              <div style={styles.summaryRow}>
                <span style={styles.summaryLabel}>Date</span>
                <span style={styles.summaryValue}>
                  {new Date(selectedSlot.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                </span>
              </div>
              <div style={styles.summaryRow}>
                <span style={styles.summaryLabel}>Time</span>
                <span style={styles.summaryValue}>{selectedSlot.display}</span>
              </div>
              <div style={styles.summaryRow}>
                <span style={styles.summaryLabel}>Duration</span>
                <span style={styles.summaryValue}>{selectedTreatment.duration_minutes} minutes</span>
              </div>
              <div style={{ ...styles.summaryRow, borderBottom: 'none' }}>
                <span style={styles.summaryLabel}>Price</span>
                <span style={{ ...styles.summaryValue, color: brand, fontWeight: 700, fontSize: 18 }}>
                  £{(selectedTreatment.price_cents / 100).toFixed(2)}
                </span>
              </div>
              {selectedTreatment.deposit_cents > 0 && (
                <div style={{ ...styles.depositBanner, background: brandLight, borderColor: brandMedium }}>
                  Deposit of £{(selectedTreatment.deposit_cents / 100).toFixed(2)} required to confirm
                </div>
              )}
            </div>

            <div style={styles.summaryClient}>
              <p><strong>{clientDetails.name}</strong></p>
              <p>{clientDetails.phone}</p>
              {clientDetails.email && <p>{clientDetails.email}</p>}
            </div>

            <div style={styles.buttonRow}>
              <button onClick={() => setStep(2)} style={styles.backBtn}>← Back</button>
              <button
                onClick={handleBook}
                disabled={submitting}
                style={{
                  ...styles.primaryBtn,
                  background: submitting ? '#ccc' : brand,
                  minWidth: 160
                }}
              >
                {submitting ? 'Booking...' : selectedTreatment.deposit_cents > 0 ? `Pay £${(selectedTreatment.deposit_cents / 100).toFixed(2)} deposit` : 'Confirm booking'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={styles.footer}>
        <span style={styles.footerText}>Powered by </span>
        <span style={{ ...styles.footerBrand, color: brand }}>florrie.ai</span>
      </div>
    </div>
  );
}

// ── Dev mode mock beautician for booking page ──
const DEV_BOOKING_BEAUTICIAN = {
  id: 'dev-beautician-id',
  first_name: 'Ellie',
  business_name: 'Ellindigo Brows & Beauty',
  booking_slug: 'ellindigo',
  brand_color: '#C76B8A',
  working_hours: {
    mon: { start: '11:00', end: '15:00' },
    tue: { start: '11:00', end: '19:00' },
    wed: { start: '11:00', end: '18:00' },
    thu: { start: '11:00', end: '19:00' },
    fri: { start: '10:00', end: '17:00' },
    sat: null, sun: null,
  },
};

const styles = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg)',
    fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)",
    padding: '0 16px 40px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
  },
  loadingContainer: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg)'
  },
  spinner: {
    width: 32, height: 32,
    border: '3px solid var(--border-light)',
    borderTopColor: 'var(--accent)',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite'
  },
  header: { textAlign: 'center', paddingTop: 48, paddingBottom: 24 },
  businessName: { fontSize: 24, fontWeight: 700, margin: '0 0 4px', letterSpacing: '-0.02em', fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  subtitle: { fontSize: 14, color: 'var(--text-secondary)', margin: 0 },
  progressContainer: { display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 24 },
  progressStep: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 },
  progressDot: { width: 10, height: 10, borderRadius: '50%', transition: 'all 0.3s ease' },
  progressLabel: { fontSize: 11, letterSpacing: '0.02em', transition: 'all 0.3s ease' },
  card: {
    background: 'var(--bg-card)',
    borderRadius: 16,
    padding: '28px 24px',
    boxShadow: 'var(--shadow-md)'
  },
  stepTitle: { fontSize: 18, fontWeight: 600, marginBottom: 20, marginTop: 0, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  treatmentList: { display: 'flex', flexDirection: 'column', gap: 10 },
  treatmentCard: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '16px 18px', borderRadius: 12, border: '1.5px solid var(--border)',
    cursor: 'pointer', transition: 'all 0.2s', textAlign: 'left',
    background: 'var(--bg-card)', width: '100%', fontFamily: 'inherit'
  },
  treatmentInfo: { display: 'flex', flexDirection: 'column', gap: 3 },
  treatmentName: { fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' },
  treatmentDesc: { fontSize: 13, color: 'var(--text-secondary)' },
  treatmentDuration: { fontSize: 12, color: 'var(--text-muted)' },
  treatmentPrice: { fontSize: 16, fontWeight: 700 },
  dateScroller: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  dateChip: {
    padding: '10px 14px', borderRadius: 10, border: '1.5px solid var(--border)',
    fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap'
  },
  slotGrid: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  slotChip: {
    padding: '10px 16px', borderRadius: 10, border: '1.5px solid var(--border)',
    fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit'
  },
  noSlots: { color: 'var(--text-muted)', fontSize: 14, padding: '20px 0' },
  form: { display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 },
  input: {
    padding: '14px 16px', borderRadius: 10, border: '1.5px solid var(--border)',
    fontSize: 15, fontFamily: 'inherit', outline: 'none', color: 'var(--text-primary)', background: 'var(--bg-subtle, #FDFCFB)'
  },
  summaryCard: {
    background: 'var(--bg-subtle, #FDFCFB)', borderRadius: 12, padding: '4px 18px',
    marginBottom: 16, border: '1px solid var(--border)'
  },
  summaryRow: {
    display: 'flex', justifyContent: 'space-between',
    padding: '14px 0', borderBottom: '1px solid var(--border-light)'
  },
  summaryLabel: { fontSize: 14, color: 'var(--text-secondary)' },
  summaryValue: { fontSize: 14, fontWeight: 500, textAlign: 'right' },
  summaryClient: { marginBottom: 20, fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6 },
  depositBanner: {
    padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500,
    marginTop: 8, marginBottom: 8, border: '1px solid', textAlign: 'center'
  },
  buttonRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  backBtn: {
    background: 'none', border: 'none', fontSize: 14, color: 'var(--text-secondary)',
    cursor: 'pointer', padding: '10px 0', fontFamily: 'inherit'
  },
  primaryBtn: {
    padding: '14px 28px', borderRadius: 12, border: 'none', color: '#fff',
    fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit'
  },
  successIcon: {
    width: 56, height: 56, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 28, fontWeight: 700, margin: '0 auto 16px'
  },
  successTitle: { fontSize: 22, fontWeight: 700, textAlign: 'center', margin: '0 0 16px', fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  successDetails: { textAlign: 'center', fontSize: 15, lineHeight: 1.6, marginBottom: 16 },
  confirmText: { textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' },
  depositNote: { fontSize: 13, color: 'var(--text-secondary)', marginTop: 8 },
  errorBanner: {
    background: 'var(--danger-bg)', border: '1px solid var(--danger)', borderRadius: 10,
    padding: '12px 16px', marginBottom: 16, fontSize: 14, color: 'var(--danger)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center'
  },
  errorClose: { background: 'none', border: 'none', fontSize: 18, color: 'var(--danger)', cursor: 'pointer' },
  inlineError: {
    background: 'var(--danger-bg)', border: '1px solid var(--danger)', borderRadius: 8,
    padding: '10px 12px', marginBottom: 12, fontSize: 13, color: 'var(--danger)'
  },
  fieldErrorText: { display: 'block', fontSize: 12, color: 'var(--danger)', marginTop: 4 },
  footer: { textAlign: 'center', paddingTop: 32, fontSize: 12 },
  footerText: { color: 'var(--text-muted)' },
  footerBrand: { fontWeight: 600 }
};
