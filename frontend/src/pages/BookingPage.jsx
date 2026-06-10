import { useState, useEffect, useRef, Fragment } from 'react';
import { supabase } from '../lib/supabase.js'
import { useParams, useLocation } from 'react-router-dom';
import PhoneField from '../components/PhoneField.jsx';
import { API_BASE } from '../lib/config.js';

// Cloudflare Turnstile (bot protection). Renders ONLY when VITE_TURNSTILE_SITE_KEY
// is set, so environments without keys behave exactly as before.
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

function TurnstileWidget({ onToken }) {
  const holder = useRef(null);
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !holder.current) return undefined;
    let widgetId = null;
    let cancelled = false;
    function render() {
      if (cancelled || widgetId !== null || !window.turnstile || !holder.current) return;
      widgetId = window.turnstile.render(holder.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token) => onToken(token),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
        'refresh-expired': 'auto',
        theme: 'light',
      });
    }
    if (window.turnstile) {
      render();
    } else {
      let script = document.getElementById('cf-turnstile-script');
      if (!script) {
        script = document.createElement('script');
        script.id = 'cf-turnstile-script';
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__florrieTurnstileReady';
        script.async = true;
        document.head.appendChild(script);
      }
      const prev = window.__florrieTurnstileReady;
      window.__florrieTurnstileReady = () => { if (prev) prev(); render(); };
    }
    return () => {
      cancelled = true;
      if (widgetId !== null && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [onToken]);
  return <div ref={holder} style={{ marginBottom: 12, minHeight: TURNSTILE_SITE_KEY ? 65 : 0 }} />;
}
/**
 * BookingPage, the public-facing branded booking link.
 * URL: florrie.ai/book/{slug}
 *
 * PUBLIC page, no auth required.
 * Uses Supabase anon client directly.
 * NOTE: Needs public READ policies on beauticians + treatments tables
 *       and public INSERT on appointments + clients for prod use.
 *
 * Flow: Select treatment → Pick date → Pick time slot → Enter details → Confirm
 * Target: Complete booking in under 90 seconds.
 */
const STEPS = ['Treatment', 'Date & Time', 'Your Details', 'Confirm'];
/**
 * PaymentCountdown, shows a live countdown to the payment deadline.
 * If the slot will be released in <10min, client sees how long they have.
 */
function PaymentCountdown({ expiresAt, brand, brandLight }) {
  const [secondsLeft, setSecondsLeft] = useState(Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / 1000)));
  const ref = useRef(null);
  useEffect(() => {
    if (secondsLeft <= 0) return;
    ref.current = setInterval(() => {
      const s = Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / 1000));
      setSecondsLeft(s);
      if (s === 0) clearInterval(ref.current);
    }, 1000);
    return () => clearInterval(ref.current);
  }, [expiresAt]);
  if (secondsLeft <= 0) return (
    <div style={{ marginTop: 16, padding: '10px 14px', borderRadius: 10, background: '#FFF0F0', border: '1px solid #FECACA', textAlign: 'center', fontSize: 13, color: '#DC2626' }}>
      Your slot has been released. Please book again if you still want this appointment.
    </div>
  );
  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  return (
    <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 10, background: brandLight, border: `1px solid ${brand}33`, textAlign: 'center' }}>
      <p style={{ margin: 0, fontSize: 13, color: brand, fontWeight: 600 }}>
        Your slot is held for {mins}:{secs.toString().padStart(2, '0')}
      </p>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: '#666' }}>
        Complete payment to confirm, if the timer runs out your slot will be released so you can grab a card if needed.
      </p>
    </div>
  );
}
export default function BookingPage() {
  const { slug } = useParams();
  const location = useLocation();
  const isConfirmedReturn = location.pathname.endsWith('/confirmed');
  const isCancelled = new URLSearchParams(location.search).get('cancelled') === 'true';
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState(null);
  const [error, setError] = useState(isCancelled ? 'Payment was cancelled. Your booking slot is held for 15 minutes, you can try again.' : null);
  const confirmedManageToken = new URLSearchParams(location.search).get('mt');
  const [success, setSuccess] = useState(isConfirmedReturn ? { depositPaid: true, manageUrl: confirmedManageToken ? `/book/${slug}/manage/${confirmedManageToken}` : null } : null);
  const [fieldErrors, setFieldErrors] = useState({});
  // Data
  const [beautician, setBeautician] = useState(null);
  const [treatments, setTreatments] = useState([]);
  const [slots, setSlots] = useState([]);
  // User selections, multi-treatment support
  const [selectedTreatments, setSelectedTreatments] = useState([]);
  const selectedTreatment = selectedTreatments[0] || null; // primary treatment for backwards compat
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [clientDetails, setClientDetails] = useState({
    name: '', email: '', phone: '', notes: ''
  });
  const [consultationAnswers, setConsultationAnswers] = useState({});
  // Add-ons
  const [addOns, setAddOns] = useState([]);
  const [selectedAddOns, setSelectedAddOns] = useState([]);
  // Retail products (booking page shop)
  const [retailProducts, setRetailProducts] = useState([]);
  const [cart, setCart] = useState({}); // { productId: quantity }
  // Payment type: 'deposit' or 'full'
  const [paymentType, setPaymentType] = useState('deposit');
  // Payment method: 'card', 'cash', 'bank_transfer'
  const [paymentMethod, setPaymentMethod] = useState('card');
  // Client recognition, returning client lookup
  const [recognisedClient, setRecognisedClient] = useState(null); // { name, email, phone, hasPendingPatchTest, hasPendingForm }
  const [lookingUpClient, setLookingUpClient] = useState(false);
  // Membership detection
  const [memberInfo, setMemberInfo] = useState(null); // { is_member, plan_name, client_name }
  // Package redemption
  const [availablePackages, setAvailablePackages] = useState([]); // { client_package_id, package_name, sessions_remaining, sessions_total }
  const [selectedPackage, setSelectedPackage] = useState(null);
  // Photo consent
  const [photoConsent, setPhotoConsent] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  // Discount code
  const [discountOpen, setDiscountOpen] = useState(false);
  const [discountInput, setDiscountInput] = useState('');
  const [discountLoading, setDiscountLoading] = useState(false);
  const [discountError, setDiscountError] = useState(null);
  const [appliedDiscount, setAppliedDiscount] = useState(null); // { code, type, discount_type, discount_value, promo_id?, voucher_id? }
  // Dynamic consultation form (loaded from form builder, falls back to defaults)
  const [consultationForm, setConsultationForm] = useState(null);
  const DEFAULT_CONSULTATION_QUESTIONS = [
    { key: 'allergies', label: 'Do you have any known allergies? (e.g. latex, adhesive, tint)', type: 'text' },
    { key: 'patch_test', label: 'Have you had a patch test in the last 6 months?', type: 'yes_no' },
    { key: 'medical', label: 'Any medical conditions, medications, or recent treatments we should know about?', type: 'text' },
    { key: 'pregnant', label: 'Are you pregnant or breastfeeding?', type: 'yes_no' },
    { key: 'previous_reactions', label: 'Have you had any adverse reactions to beauty treatments before?', type: 'text' },
  ];
  const needsConsultation = selectedTreatments.some(t => t.requires_consultation);
  const needsPatchTest = selectedTreatments.some(t => t.requires_patch_test);
  // The questions to render, dynamic form fields if available, else defaults
  // Filter out the patch_test question for treatments that don't require it (wax, microblading, etc.)
  const consultationQuestions = consultationForm?.consultation_form_fields?.length
    ? consultationForm.consultation_form_fields.map(f => ({
        key: f.id,
        label: f.label,
        type: f.type,   // text, yes_no, multi_select, single_select, checkbox, text_block, signature
        options: f.options || [],
        required: f.required,
      }))
    : DEFAULT_CONSULTATION_QUESTIONS.filter(q => q.key !== 'patch_test' || needsPatchTest);
  // Compute deposit amount (percentage overrides flat)
  function getDepositCents(treatment) {
    if (!treatment) return 0;
    if (treatment.deposit_percent > 0 && treatment.price_cents > 0) {
      return Math.round(treatment.price_cents * treatment.deposit_percent / 100);
    }
    return treatment.deposit_cents || 0;
  }
  // Multi-treatment totals
  const combinedTreatmentCents = selectedTreatments.reduce((sum, t) => sum + (t.price_cents || 0), 0);
  const combinedDuration = selectedTreatments.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);
  const depositCents = selectedTreatments.reduce((sum, t) => sum + getDepositCents(t), 0);
  const hasDeposit = depositCents > 0;
  // Add-on totals
  const addOnTotal = selectedAddOns.reduce((sum, ao) => sum + (ao.price_cents || 0), 0);
  const addOnDuration = selectedAddOns.reduce((sum, ao) => sum + (ao.duration_minutes || 0), 0);
  // Calculate discount
  const discountCents = appliedDiscount
    ? appliedDiscount.discount_type === 'percentage'
      ? Math.round((combinedTreatmentCents + addOnTotal) * appliedDiscount.discount_value / 100)
      : Math.min(appliedDiscount.discount_value, combinedTreatmentCents + addOnTotal)
    : 0;
  const grandTotalCents = Math.max(0, combinedTreatmentCents + addOnTotal - discountCents);
  // Smart add-on suggestions: show add-ons compatible with the selected treatment.
  // compatible_treatment_ids empty/missing = compatible with every treatment.
  const suggestedAddOns = selectedTreatment
    ? addOns.filter(ao => {
        const compat = ao.compatible_treatment_ids;
        if (!Array.isArray(compat) || compat.length === 0) return true;
        return compat.includes(selectedTreatment.id);
      })
    : addOns;
  function toggleAddOn(addOn) {
    setSelectedAddOns(prev => {
      const exists = prev.find(a => a.id === addOn.id);
      if (exists) return prev.filter(a => a.id !== addOn.id);
      return [...prev, addOn];
    });
  }
  // Cart helpers for retail products
  const cartItems = Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => {
      const product = retailProducts.find(p => p.id === id);
      return product ? { ...product, qty, lineTotal: product.price_cents * qty } : null;
    })
    .filter(Boolean);
  const cartTotalCents = cartItems.reduce((sum, item) => sum + item.lineTotal, 0);
  function updateCart(productId, delta) {
    setCart(prev => {
      const product = retailProducts.find(p => p.id === productId);
      const max = product?.max_per_order || 5;
      const current = prev[productId] || 0;
      const next = Math.max(0, Math.min(max, current + delta));
      return { ...prev, [productId]: next };
    });
  }
  // Load consultation form when treatment with a form is selected
  useEffect(() => {
    if (!selectedTreatment?.consultation_form_id) {
      setConsultationForm(null);
      return;
    }
    async function loadForm() {
      try {
        const res = await fetch(`${API_BASE}/api/booking/${slug}/consultation-form/${selectedTreatment.consultation_form_id}`);
        const data = await res.json();
        if (res.ok && data.form) setConsultationForm(data.form);
      } catch {
        // Fall back to default questions, non-blocking
      }
    }
    loadForm();
  }, [selectedTreatment?.consultation_form_id, slug]);
  // Check membership + packages when phone number looks complete
  useEffect(() => {
    const cleaned = clientDetails.phone.replace(/[^\d]/g, '');
    if (cleaned.length < 10) {
      setMemberInfo(null);
      setAvailablePackages([]);
      setSelectedPackage(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        // Check membership and packages in parallel
        const [memberRes, pkgRes] = await Promise.all([
          fetch(`${API_BASE}/api/booking/${slug}/check-member`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: clientDetails.phone }),
          }),
          fetch(`${API_BASE}/api/booking/${slug}/check-packages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: clientDetails.phone, treatment_id: selectedTreatment?.id }),
          }),
        ]);
        const memberData = await memberRes.json();
        const pkgData = await pkgRes.json();
        setMemberInfo(memberData.is_member ? memberData : null);
        setAvailablePackages(pkgData.packages || []);
      } catch {
        // Silent fail
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [clientDetails.phone, slug, selectedTreatment?.id]);
  // Client recognition, trigger when email field loses focus
  async function handleEmailBlur() {
    const email = clientDetails.email?.trim();
    setLookingUpClient(true);
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/lookup-client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.found && data.client) {
        setRecognisedClient(data);
        // Pre-fill name and phone if not already entered
        setClientDetails(prev => ({
          ...prev,
          name: prev.name || data.client.name,
          phone: prev.phone || data.client.phone || '',
        }));
      } else {
        setRecognisedClient(null);
      }
    } catch {
      // silent, never block the booking flow
    } finally {
      setLookingUpClient(false);
    }
  }
  // Validate and apply a discount code
  async function validateDiscountCode() {
    if (!discountInput.trim()) return;
    setDiscountLoading(true);
    setDiscountError(null);
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/validate-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: discountInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.valid) {
        setDiscountError(data.error || 'Invalid code');
        return;
      }
      setAppliedDiscount(data);
      setDiscountError(null);
    } catch {
      setDiscountError('Could not validate code');
    } finally {
      setDiscountLoading(false);
    }
  }
  function removeDiscount() {
    setAppliedDiscount(null);
    setDiscountInput('');
    setDiscountError(null);
    setDiscountOpen(false);
  }
  // Fetch beautician + treatments by slug
  useEffect(() => {
    async function load() {
      try {
        // Load everything via the public backend endpoint (runs server-side so it
        // works for LOGGED-OUT visitors; a direct browser query is blocked by RLS).
        const pageRes = await fetch(`${API_BASE}/api/booking/${slug}/page`);
        if (!pageRes.ok) {
          setError("This booking page doesn't exist yet.");
          setLoading(false);
          return;
        }
        const { salon: b, treatments: tx, addOns: ao } = await pageRes.json();
        setBeautician(b);
        setTreatments(tx || []);
        setAddOns(ao || []);
        // Unblock the page now, products are optional retail items, never block booking
        setLoading(false);
        // Fetch retail products in the background with a hard timeout
        try {
          const res = await fetch(`${API_BASE}/api/products/public/${b.id}`, {
            signal: AbortSignal.timeout(4000),
          });
          if (res.ok) {
            const products = await res.json();
            setRetailProducts(products);
          }
        } catch { /* products are optional, fail silently */ }
      } catch (err) {
        setError("Something went wrong loading this page.");
        setLoading(false);
      }
    }
    load();
  }, [slug]);
  // Generate available time slots when date changes
  useEffect(() => {
    if (selectedTreatments.length === 0 || !selectedDate || !beautician) return;
    async function loadSlots() {
      const dayOfWeek = new Date(selectedDate).toLocaleDateString('en-GB', { weekday: 'short' }).toLowerCase();
      const dayKey = { mon: 'mon', tue: 'tue', wed: 'wed', thu: 'thu', fri: 'fri', sat: 'sat', sun: 'sun' }[dayOfWeek];
      const hours = beautician.working_hours?.[dayKey];
      if (!hours || !hours.start || !hours.end) {
        setSlots([]);
        setSelectedSlot(null);
        return;
      }
      // Generate slots from working hours (uses combined duration for multi-treatment)
      const duration = combinedDuration || 60;
      const buffer = Math.max(...selectedTreatments.map(t => t.buffer_minutes || 0), 0);
      const totalBlock = duration + buffer; // all treatments + longest buffer
      const [startH, startM] = hours.start.split(':').map(Number);
      const [endH, endM] = hours.end.split(':').map(Number);
      const startMin = startH * 60 + startM;
      const endMin = endH * 60 + endM;
      // Booked blocks via the public backend endpoint (works logged-out).
      let bookedSlots = [];
      let appts = [];
      try {
        const avRes = await fetch(`${API_BASE}/api/booking/${slug}/availability?date=${selectedDate}`);
        if (avRes.ok) appts = (await avRes.json()).appointments || [];
      } catch { appts = []; }
      bookedSlots = (appts || []).map(a => ({
        start: new Date(a.starts_at).getHours() * 60 + new Date(a.starts_at).getMinutes(),
        end: new Date(a.starts_at).getHours() * 60 + new Date(a.starts_at).getMinutes() + (a.duration_minutes || 60) + (a.buffer_minutes || 0),
      }));
      const generated = [];
      for (let m = startMin; m + totalBlock <= endMin; m += 30) {
        const isBooked = bookedSlots.some(b => m < b.end && m + totalBlock > b.start);
        if (isBooked) continue;
        const h = Math.floor(m / 60);
        const min = m % 60;
        const display = `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
        // No Z suffix, times are in the beautician's local timezone, not UTC.
        // Backend stores as-is and the beautician's timezone field handles conversion.
        const startsAt = `${selectedDate}T${display}:00`;
        generated.push({ starts_at: startsAt, display });
      }
      setSlots(generated);
      setSelectedSlot(null);
    }
    loadSlots();
  }, [selectedDate, selectedTreatments, beautician, combinedDuration]);
  // Submit booking via backend API (handles client creation, conflict checks, deposits)
  async function handleBook() {
    setSubmitting(true);
    setError(null);
    try {
      // Call backend API, handles client lookup/creation, RLS, conflict check, deposit flow
      const res = await fetch(`${API_BASE}/api/booking/${slug}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          treatment_id: selectedTreatment.id,
          extra_treatment_ids: selectedTreatments.slice(1).map(t => t.id),
          starts_at: selectedSlot.starts_at,
          client_name: clientDetails.name,
          client_email: clientDetails.email || null,
          client_phone: clientDetails.phone,
          notes: clientDetails.notes || null,
          consultation: needsConsultation ? consultationAnswers : null,
          add_ons: selectedAddOns.map(ao => ({ id: ao.id, price_cents: ao.price_cents })),
          products: cartItems.map(item => ({ id: item.id, quantity: item.qty, price_cents: item.price_cents })),
          payment_type: paymentType,
          payment_method: paymentMethod,
          discount_code: appliedDiscount?.code || null,
          is_member: memberInfo?.is_member || false,
          photo_consent: photoConsent,
          marketing_opt_in: marketingOptIn,
          client_package_id: selectedPackage?.client_package_id || null,
          'cf-turnstile-response': turnstileToken || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = data.details?.length ? ` (${data.details.join(', ')})` : '';
        throw new Error((data.error || 'Booking failed') + detail);
      }
      // If deposit required and checkout URL returned, redirect to Stripe
      if (data.checkout_url) {
        try {
          const redirectUrl = new URL(data.checkout_url);
          if (redirectUrl.hostname.endsWith('stripe.com')) {
            window.location.href = data.checkout_url;
          } else {
            setError('Invalid payment redirect');
          }
        } catch {
          setError('Invalid payment URL');
        }
        return;
      }
      setSuccess({
        treatment: selectedTreatments.map(t => t.name).join(' + '),
        date: new Date(selectedSlot.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
        time: selectedSlot.display,
        price: `£${(combinedTreatmentCents / 100).toFixed(2)}`,
        deposit: data.booking?.deposit || null,
        depositPending: data.booking?.deposit_pending || false,
        depositNote: data.deposit_note || null,
        manageUrl: data.booking?.manageUrl || null,
        paymentExpiresAt: data.booking?.paymentExpiresAt || null,
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
      if (selectedTreatments.length === 0) {
        errors.treatment = 'Please select at least one treatment to continue';
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
  const bizName = beautician?.business_name || beautician?.first_name || 'Book';
  const logoUrl = beautician?.logo_url || beautician?.avatar_url || null;
  const monogram = bizName.trim().charAt(0).toUpperCase();
  const headerTagline = beautician?.tagline || 'Book your appointment';
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
            {success.depositPaid ? "You're booked, deposit paid" : success.depositPending ? "Almost there, deposit needed" : "You're booked"}
          </h2>
          <div style={styles.successDetails}>
            {success.depositPaid ? (
              <p>Your deposit has been received and your appointment is confirmed. You'll get a confirmation message shortly.</p>
            ) : success.depositPending ? (
              <>
                <p><strong>{success.treatment}</strong></p>
                <p>{success.date} at {success.time}</p>
                <p style={{ color: brand, fontWeight: 600, marginTop: 12 }}>{success.price}</p>
                {success.deposit && (
                  <div style={{ ...styles.depositBanner, background: brandLight, borderColor: brandMedium, marginTop: 12 }}>
                    Deposit of {success.deposit} required to confirm
                  </div>
                )}
                <p style={{ fontSize: 13, color: '#666', marginTop: 12 }}>
                  {success.depositNote || 'Your beautician will send you a payment link to confirm your booking.'}
                </p>
              </>
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
              : success.depositPending
              ? "Your slot is held, we'll confirm once the deposit is received."
              : "You'll receive a confirmation message shortly."}
          </p>
          {/* Payment buffer countdown */}
          {success.paymentExpiresAt && (
            <PaymentCountdown expiresAt={success.paymentExpiresAt} brand={brand} brandLight={brandLight} />
          )}
          {/* Manage booking portal link */}
          {success.manageUrl && (
            <div style={{ marginTop: 20 }}>
              <a
                href={success.manageUrl}
                style={{
                  display: 'block', width: '100%', boxSizing: 'border-box',
                  padding: '13px 0', borderRadius: 12, textAlign: 'center',
                  background: brandLight, color: brand,
                  fontWeight: 600, fontSize: 15, textDecoration: 'none',
                  border: `1.5px solid ${brand}22`,
                }}
              >
                Manage my booking
              </a>
              <p style={{ fontSize: 12, color: '#999', textAlign: 'center', marginTop: 8 }}>
                View, cancel or check patch test status
              </p>
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
  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={{ ...styles.brandBand, background: `linear-gradient(160deg, ${brand}16 0%, ${brand}07 55%, transparent 100%)` }}>
        {logoUrl
          ? <img src={logoUrl} alt={bizName} style={styles.brandLogo} />
          : <div style={{ ...styles.brandMonogram, background: brand }}>{monogram}</div>}
        <h1 style={styles.businessName}>{bizName}</h1>
        <p style={styles.subtitle}>{headerTagline}</p>
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
            <h2 style={styles.stepTitle}>Choose your treatment{selectedTreatments.length > 1 ? 's' : ''}</h2>
            {selectedTreatments.length === 0 && (
              <p style={{ fontSize: 13, color: '#888', margin: '-12px 0 14px' }}>Tap multiple to book them together</p>
            )}
            {fieldErrors.treatment && (
              <div style={styles.inlineError}>{fieldErrors.treatment}</div>
            )}
            <div style={styles.treatmentList}>
              {[...treatments].sort((a, b) => (a.category || '').localeCompare(b.category || '')).map((t, _i, _arr) => {
                const isSelected = selectedTreatments.some(st => st.id === t.id);
                const _distinctCats = new Set(_arr.map(x => x.category).filter(Boolean));
                const _showCat = _distinctCats.size > 1 && t.category && t.category !== _arr[_i - 1]?.category;
                return (
                  <Fragment key={t.id}>
                    {_showCat && <div style={styles.categoryLabel}>{t.category}</div>}
                  <button
                    onClick={() => {
                      setSelectedTreatments(prev => {
                        const exists = prev.find(st => st.id === t.id);
                        const next = exists ? prev.filter(st => st.id !== t.id) : [...prev, t];
                        if (next.length === 0) setSelectedAddOns([]);
                        return next;
                      });
                      setFieldErrors({});
                    }}
                    style={{
                      ...styles.treatmentCard,
                      borderColor: isSelected ? brand : '#E8E4DF',
                      background: isSelected ? brandLight : '#fff'
                    }}
                  >
                    <div style={styles.treatmentInfo}>
                      <span style={styles.treatmentName}>
                        {isSelected ? '✓ ' : ''}{t.name}
                      </span>
                      {t.description && <span style={styles.treatmentDesc}>{t.description}</span>}
                      <span style={styles.treatmentDuration}>{t.duration_minutes} min</span>
                    </div>
                    <span style={{ ...styles.treatmentPrice, color: brand }}>
                      £{(t.price_cents / 100).toFixed(2)}
                    </span>
                  </button>
                  </Fragment>
                );
              })}
            </div>
            {/* Multi-treatment summary bar */}
            {selectedTreatments.length > 1 && (
              <div style={{ marginTop: 10, padding: '10px 14px', borderRadius: 10, background: brandLight, border: `1px solid ${brand}30`, textAlign: 'center' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: brand }}>
                  {selectedTreatments.length} treatments · {combinedDuration} min · £{(combinedTreatmentCents / 100).toFixed(2)}
                </span>
              </div>
            )}
            {treatments.length === 0 && (
              <p style={styles.noSlots}>No treatments available</p>
            )}
            {/* Add-ons shown after treatment is selected */}
            {selectedTreatment && suggestedAddOns.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)', fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" }}>
                  Enhance your treatment
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {suggestedAddOns.map(ao => {
                    const isSelected = selectedAddOns.some(a => a.id === ao.id);
                    return (
                      <button
                        key={ao.id}
                        onClick={() => toggleAddOn(ao)}
                        style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '12px 14px', borderRadius: 10,
                          border: `1.5px solid ${isSelected ? brand : '#E8E4DF'}`,
                          background: isSelected ? brandLight : '#fff',
                          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', width: '100%',
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                            {isSelected ? '✓ ' : '+ '}{ao.name}
                          </span>
                          {ao.description && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{ao.description}</span>}
                          {ao.duration_minutes > 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>+{ao.duration_minutes} min</span>}
                        </div>
                        <span style={{ fontSize: 14, fontWeight: 600, color: brand }}>
                          +£{(ao.price_cents / 100).toFixed(2)}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {selectedAddOns.length > 0 && (
                  <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: brandLight, fontSize: 13, fontWeight: 500, color: brand, textAlign: 'center' }}>
                    Total: £{(grandTotalCents / 100).toFixed(2)} · {(selectedTreatment.duration_minutes || 0) + addOnDuration} min
                  </div>
                )}
              </div>
            )}
            {/* Retail Products, shown after treatment selected */}
            {selectedTreatment && retailProducts.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)', fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" }}>
                  Take-home products
                </h3>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
                  Add to your booking and collect at your appointment
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {retailProducts.map(product => {
                    const qty = cart[product.id] || 0;
                    return (
                      <div
                        key={product.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12,
                          padding: '12px 14px', borderRadius: 10,
                          border: `1.5px solid ${qty > 0 ? brand : '#E8E4DF'}`,
                          background: qty > 0 ? brandLight : '#fff',
                        }}
                      >
                        {product.image_url && (
                          <img
                            src={product.image_url}
                            alt={product.name}
                            style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover' }}
                          />
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>{product.name}</div>
                          {product.description && (
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {product.description}
                            </div>
                          )}
                          <div style={{ fontSize: 13, fontWeight: 600, color: brand, marginTop: 2 }}>
                            £{(product.price_cents / 100).toFixed(2)}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {qty > 0 && (
                            <button
                              onClick={() => updateCart(product.id, -1)}
                              style={{
                                width: 28, height: 28, borderRadius: '50%', border: `1px solid ${brand}`,
                                background: '#fff', color: brand, fontSize: 16, fontWeight: 700,
                                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontFamily: 'inherit', padding: 0,
                              }}
                            >−</button>
                          )}
                          {qty > 0 && (
                            <span style={{ fontSize: 14, fontWeight: 600, minWidth: 16, textAlign: 'center' }}>{qty}</span>
                          )}
                          <button
                            onClick={() => updateCart(product.id, 1)}
                            style={{
                              width: 28, height: 28, borderRadius: '50%', border: 'none',
                              background: qty > 0 ? brand : '#E8E4DF', color: qty > 0 ? '#fff' : '#666',
                              fontSize: 16, fontWeight: 700, cursor: 'pointer',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontFamily: 'inherit', padding: 0,
                            }}
                          >+</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {cartTotalCents > 0 && (
                  <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: brandLight, fontSize: 13, fontWeight: 500, color: brand, textAlign: 'center' }}>
                    Products: £{(cartTotalCents / 100).toFixed(2)} · {cartItems.length} item{cartItems.length !== 1 ? 's' : ''}
                  </div>
                )}
              </div>
            )}
            {selectedTreatments.length > 0 && (
              <button
                onClick={() => setStep(1)}
                style={{ ...styles.primaryBtn, background: brand, width: '100%', marginTop: 16 }}
              >
                Continue to date & time
              </button>
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
                  <p style={styles.noSlots}>No available slots on this day, try another date</p>
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
                  type="text" placeholder="Your name *"
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
                <PhoneField
                  value={clientDetails.phone}
                  onChange={phone => setClientDetails({ ...clientDetails, phone })}
                  style={styles.input}
                  error={!!fieldErrors.phone}
                />
                {fieldErrors.phone && <span style={styles.fieldErrorText}>{fieldErrors.phone}</span>}
                {memberInfo && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6, marginTop: 6,
                    padding: '6px 10px', borderRadius: 8, background: 'var(--gold-bg, #FFF8E1)',
                    border: '1px solid var(--gold, #C9A96E)', fontSize: 12, fontWeight: 500,
                    color: 'var(--gold, #C9A96E)',
                  }}>
                    ★ Member, {memberInfo.plan_name}
                  </div>
                )}
                <p style={{
                  fontSize: 11, color: '#9C9690', marginTop: 6, marginBottom: 0, lineHeight: 1.4,
                }}>
                  By providing your phone number, you agree to receive SMS booking confirmations and reminders from your beautician. Reply <strong>STOP</strong> to opt out at any time. Standard message and data rates may apply. See our <a href="/privacy" style={{ color: '#9C9690', textDecoration: 'underline' }}>Privacy Policy</a>.
                </p>
              </div>
              <div>
                <input
                  type="email" placeholder="Email (optional)"
                  value={clientDetails.email}
                  onChange={e => { setClientDetails({ ...clientDetails, email: e.target.value }); setRecognisedClient(null); }}
                  onBlur={handleEmailBlur}
                  style={{
                    ...styles.input,
                    borderColor: fieldErrors.email ? '#DC2626' : '#E8E4DF'
                  }}
                />
                {fieldErrors.email && <span style={styles.fieldErrorText}>{fieldErrors.email}</span>}
                {lookingUpClient && (
                  <p style={{ fontSize: 12, color: '#999', marginTop: 4 }}>Checking…</p>
                )}
                {recognisedClient?.found && (
                  <div style={{
                    marginTop: 8, padding: '10px 12px', borderRadius: 10,
                    background: `${brand}10`, border: `1px solid ${brand}30`,
                    fontSize: 13,
                  }}>
                    <span style={{ fontWeight: 600, color: brand }}>
                      Welcome back, {recognisedClient.client.name.split(' ')[0]}!
                    </span>
                    <span style={{ color: '#666' }}> We've filled in your details.</span>
                    {recognisedClient.hasPendingPatchTest && needsPatchTest && (
                      <p style={{ margin: '6px 0 0', fontSize: 12, color: '#D4943A', fontWeight: 500 }}>
                        ⚠️ You have a patch test pending, your beautician will be in touch.
                      </p>
                    )}
                    {recognisedClient.hasPendingForm && (
                      <p style={{ margin: '4px 0 0', fontSize: 12, color: '#7B6BA8', fontWeight: 500 }}>
                        📋 You have a consultation form to complete.
                      </p>
                    )}
                  </div>
                )}
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
                    setStep(needsConsultation && !recognisedClient?.found ? 2.5 : 3);
                  }
                }}
                disabled={!clientDetails.name || !clientDetails.phone}
                style={{
                  ...styles.primaryBtn,
                  background: (!clientDetails.name || !clientDetails.phone) ? '#ccc' : brand,
                  cursor: (!clientDetails.name || !clientDetails.phone) ? 'not-allowed' : 'pointer'
                }}
              >
                {needsConsultation && !recognisedClient?.found ? 'Next: Consultation form' : 'Review booking'}
              </button>
            </div>
          </div>
        )}
        {/* Step 2.5: Consultation Form (only for treatments that require it) */}
        {step === 2.5 && (
          <div>
            <h2 style={styles.stepTitle}>
              {consultationForm?.name || 'Consultation form'}
            </h2>
            <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
              Required for {selectedTreatment?.name}. This information helps your beautician prepare and is kept for insurance records.
            </p>
            {consultationForm?.consent_text && (
              <p style={{ fontSize: 12, color: '#666', marginBottom: 16, lineHeight: 1.5, padding: '10px 12px', background: 'var(--bg-subtle, #FDFCFB)', borderRadius: 8, border: '1px solid var(--border-light)' }}>
                {consultationForm.consent_text}
              </p>
            )}
            <div style={styles.formFields}>
              {consultationQuestions.map(q => (
                <div key={q.key} style={{ marginBottom: 14 }}>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#444', marginBottom: 4 }}>
                    {q.label}{q.required && <span style={{ color: 'var(--danger, #DC2626)' }}> *</span>}
                  </label>
                  {/* Yes/No toggle */}
                  {q.type === 'yes_no' && (
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
                  )}
                  {/* Single select (radio-like buttons) */}
                  {q.type === 'single_select' && q.options?.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {q.options.map(opt => (
                        <button key={opt} onClick={() => setConsultationAnswers(p => ({ ...p, [q.key]: opt }))}
                          style={{
                            padding: '8px 14px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500,
                            cursor: 'pointer', fontFamily: 'inherit',
                            background: consultationAnswers[q.key] === opt ? brand : '#F0ECE8',
                            color: consultationAnswers[q.key] === opt ? '#fff' : '#666'
                          }}>
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* Multi select (toggle chips) */}
                  {q.type === 'multi_select' && q.options?.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {q.options.map(opt => {
                        const selected = (consultationAnswers[q.key] || []).includes(opt);
                        return (
                          <button key={opt} onClick={() => {
                            setConsultationAnswers(p => {
                              const current = p[q.key] || [];
                              return { ...p, [q.key]: selected ? current.filter(v => v !== opt) : [...current, opt] };
                            });
                          }}
                            style={{
                              padding: '8px 14px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500,
                              cursor: 'pointer', fontFamily: 'inherit',
                              background: selected ? brand : '#F0ECE8',
                              color: selected ? '#fff' : '#666'
                            }}>
                            {selected ? '✓ ' : ''}{opt}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {/* Checkbox */}
                  {q.type === 'checkbox' && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={consultationAnswers[q.key] === true}
                        onChange={e => setConsultationAnswers(p => ({ ...p, [q.key]: e.target.checked }))}
                        style={{ width: 18, height: 18, accentColor: brand }}
                      />
                      I confirm
                    </label>
                  )}
                  {/* Text block (multi-line) */}
                  {q.type === 'text_block' && (
                    <textarea
                      value={consultationAnswers[q.key] || ''}
                      onChange={e => setConsultationAnswers(p => ({ ...p, [q.key]: e.target.value }))}
                      placeholder="Type here..."
                      style={{ ...styles.input, minHeight: 80, resize: 'vertical' }}
                    />
                  )}
                  {/* Default: text input */}
                  {(q.type === 'text' || (!['yes_no', 'single_select', 'multi_select', 'checkbox', 'text_block', 'signature'].includes(q.type))) && (
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
              {/* Show each treatment row when multiple selected */}
              {selectedTreatments.length > 1 ? (
                <>
                  <div style={{ ...styles.summaryRow, borderBottom: 'none', paddingBottom: 0 }}>
                    <span style={{ ...styles.summaryLabel, fontWeight: 600 }}>Treatments</span>
                  </div>
                  {selectedTreatments.map(t => (
                    <div key={t.id} style={styles.summaryRow}>
                      <span style={styles.summaryLabel}>{t.name} ({t.duration_minutes} min)</span>
                      <span style={styles.summaryValue}>£{(t.price_cents / 100).toFixed(2)}</span>
                    </div>
                  ))}
                </>
              ) : (
                <div style={styles.summaryRow}>
                  <span style={styles.summaryLabel}>Treatment</span>
                  <span style={styles.summaryValue}>{selectedTreatment?.name}</span>
                </div>
              )}
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
                <span style={styles.summaryValue}>{combinedDuration + addOnDuration} minutes</span>
              </div>
              {selectedAddOns.length > 0 && (
                <>
                  {selectedTreatments.length <= 1 && (
                    <div style={styles.summaryRow}>
                      <span style={styles.summaryLabel}>Treatment price</span>
                      <span style={styles.summaryValue}>£{(combinedTreatmentCents / 100).toFixed(2)}</span>
                    </div>
                  )}
                  {selectedAddOns.map(ao => (
                    <div key={ao.id} style={styles.summaryRow}>
                      <span style={styles.summaryLabel}>+ {ao.name}</span>
                      <span style={styles.summaryValue}>£{(ao.price_cents / 100).toFixed(2)}</span>
                    </div>
                  ))}
                </>
              )}
              {cartItems.length > 0 && (
                <>
                  {cartItems.map(item => (
                    <div key={item.id} style={styles.summaryRow}>
                      <span style={styles.summaryLabel}>
                        🛍 {item.name} × {item.qty}
                      </span>
                      <span style={styles.summaryValue}>£{(item.lineTotal / 100).toFixed(2)}</span>
                    </div>
                  ))}
                </>
              )}
              {discountCents > 0 && (
                <div style={styles.summaryRow}>
                  <span style={{ ...styles.summaryLabel, color: 'var(--success, #38A169)' }}>
                    Discount ({appliedDiscount.code})
                  </span>
                  <span style={{ ...styles.summaryValue, color: 'var(--success, #38A169)' }}>
                    −£{(discountCents / 100).toFixed(2)}
                  </span>
                </div>
              )}
              <div style={{ ...styles.summaryRow, borderBottom: 'none' }}>
                <span style={styles.summaryLabel}>Total</span>
                <span style={{ ...styles.summaryValue, color: brand, fontWeight: 700, fontSize: 18 }}>
                  £{((grandTotalCents + cartTotalCents) / 100).toFixed(2)}
                </span>
              </div>
              {hasDeposit && !selectedPackage && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ ...styles.depositBanner, background: brandLight, borderColor: brandMedium, marginBottom: 10 }}>
                    {paymentType === 'full'
                      ? `Paying £${(grandTotalCents / 100).toFixed(2)} in full`
                      : `Deposit of £${(depositCents / 100).toFixed(2)} to confirm${selectedTreatments.length > 1 ? ` (${selectedTreatments.length} treatments)` : ''}`}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => setPaymentType('deposit')}
                      style={{
                        flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 13, fontWeight: 500,
                        cursor: 'pointer', fontFamily: 'inherit', border: 'none',
                        background: paymentType === 'deposit' ? brand : '#F0ECE8',
                        color: paymentType === 'deposit' ? '#fff' : '#666',
                      }}
                    >
                      Pay deposit (£{(depositCents / 100).toFixed(2)})
                    </button>
                    <button
                      onClick={() => setPaymentType('full')}
                      style={{
                        flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 13, fontWeight: 500,
                        cursor: 'pointer', fontFamily: 'inherit', border: 'none',
                        background: paymentType === 'full' ? brand : '#F0ECE8',
                        color: paymentType === 'full' ? '#fff' : '#666',
                      }}
                    >
                      Pay in full (£{(grandTotalCents / 100).toFixed(2)})
                    </button>
                  </div>
                </div>
              )}
            </div>
            {/* Payment method picker, shown when multiple methods are accepted */}
            {(() => {
              const paySettings = beautician?.payment_settings || {};
              const accepted = paySettings.accepted_methods || ['cash'];
              const stripeActive = beautician?.stripe_onboarding_complete === true;
              const available = [
                stripeActive && accepted.includes('card_online') && { key: 'card', label: 'Card online', icon: '💳' },
                accepted.includes('cash') && { key: 'cash', label: 'Cash on the day', icon: '💵' },
                accepted.includes('bank_transfer') && { key: 'bank_transfer', label: 'Bank transfer', icon: '🏦' },
              ].filter(Boolean);
              if (available.length <= 1) return null;
              return (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #1a0a0f)', marginBottom: 8 }}>
                    How would you like to pay?
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {available.map(m => (
                      <button
                        key={m.key}
                        onClick={() => setPaymentMethod(m.key)}
                        style={{
                          flex: 1, minWidth: 100, padding: '10px 12px', borderRadius: 8,
                          fontSize: 13, fontWeight: 500, cursor: 'pointer',
                          fontFamily: 'inherit', border: 'none',
                          background: paymentMethod === m.key ? brand : '#F0ECE8',
                          color: paymentMethod === m.key ? '#fff' : '#666',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        }}
                      >
                        <span>{m.icon}</span> {m.label}
                      </button>
                    ))}
                  </div>
                  {(paymentMethod === 'cash' || paymentMethod === 'bank_transfer') && (
                    <p style={{ fontSize: 12, color: 'var(--text-muted, #999)', margin: '8px 0 0' }}>
                      {paymentMethod === 'bank_transfer'
                        ? 'Your beautician will send bank details after booking.'
                        : 'Payment collected at your appointment.'}
                    </p>
                  )}
                </div>
              );
            })()}
            {/* Membership badge */}
            {memberInfo && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12,
                padding: '8px 12px', borderRadius: 8, background: 'var(--gold-bg, #FFF8E1)',
                border: '1px solid var(--gold, #C9A96E)', fontSize: 13, fontWeight: 500,
                color: 'var(--gold, #C9A96E)',
              }}>
                ★ {memberInfo.plan_name} member, any benefits will be applied by your beautician
              </div>
            )}
            {/* Package redemption */}
            {availablePackages.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                {availablePackages.map(pkg => {
                  const isSelected = selectedPackage?.client_package_id === pkg.client_package_id;
                  return (
                    <button
                      key={pkg.client_package_id}
                      onClick={() => setSelectedPackage(isSelected ? null : pkg)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        width: '100%', padding: '12px 14px', borderRadius: 10, marginBottom: 6,
                        border: `1.5px solid ${isSelected ? 'var(--success, #38A169)' : 'var(--border, #E8E4DF)'}`,
                        background: isSelected ? 'var(--success-bg, #F0FFF4)' : 'var(--bg-card)',
                        cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: isSelected ? 'var(--success, #38A169)' : 'var(--text-primary)' }}>
                          {isSelected ? '✓ ' : ''}{pkg.package_name}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {pkg.sessions_remaining} of {pkg.sessions_total} sessions remaining
                        </span>
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--success, #38A169)' }}>
                        Use session
                      </span>
                    </button>
                  );
                })}
                {selectedPackage && (
                  <p style={{ fontSize: 12, color: 'var(--success, #38A169)', marginTop: 4 }}>
                    No payment needed, using a session from your {selectedPackage.package_name} package
                  </p>
                )}
              </div>
            )}
            {/* Discount code section (hidden when using a package session) */}
            {!selectedPackage && <div style={{ marginBottom: 16 }}>
              {appliedDiscount ? (
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', borderRadius: 8, background: 'var(--success-bg, #F0FFF4)',
                  border: '1px solid var(--success, #38A169)', fontSize: 13,
                }}>
                  <span style={{ color: 'var(--success, #38A169)', fontWeight: 600 }}>
                    ✓ {appliedDiscount.code}, saving £{(discountCents / 100).toFixed(2)}
                  </span>
                  <button onClick={removeDiscount} style={{
                    background: 'none', border: 'none', fontSize: 16, color: 'var(--text-muted)',
                    cursor: 'pointer', padding: '0 4px', fontFamily: 'inherit',
                  }}>×</button>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => setDiscountOpen(!discountOpen)}
                    style={{
                      background: 'none', border: 'none', fontSize: 13, color: brand,
                      cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontWeight: 500,
                    }}
                  >
                    {discountOpen ? 'Hide' : '+ Got a code?'}
                  </button>
                  {discountOpen && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <input
                        type="text"
                        placeholder="Promo or gift voucher code"
                        value={discountInput}
                        onChange={e => { setDiscountInput(e.target.value); setDiscountError(null); }}
                        onKeyDown={e => e.key === 'Enter' && validateDiscountCode()}
                        style={{
                          ...styles.input, flex: 1, padding: '10px 12px', fontSize: 14,
                          borderColor: discountError ? 'var(--danger, #DC2626)' : 'var(--border, #E8E4DF)',
                        }}
                      />
                      <button
                        onClick={validateDiscountCode}
                        disabled={discountLoading || !discountInput.trim()}
                        style={{
                          ...styles.primaryBtn, background: brand, padding: '10px 16px',
                          fontSize: 13, opacity: discountLoading || !discountInput.trim() ? 0.6 : 1,
                        }}
                      >
                        {discountLoading ? '...' : 'Apply'}
                      </button>
                    </div>
                  )}
                  {discountError && (
                    <p style={{ fontSize: 12, color: 'var(--danger, #DC2626)', marginTop: 4 }}>{discountError}</p>
                  )}
                </>
              )}
            </div>}
            <div style={styles.summaryClient}>
              <p><strong>{clientDetails.name}</strong></p>
              <p>{clientDetails.phone}</p>
              {clientDetails.email && <p>{clientDetails.email}</p>}
            </div>
            {/* Photo consent */}
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 20,
              padding: '12px 14px', borderRadius: 10, background: 'var(--bg-subtle, #FDFCFB)',
              border: '1px solid var(--border-light)', cursor: 'pointer', fontSize: 13,
              color: 'var(--text-secondary)', lineHeight: 1.5,
            }}>
              <input
                type="checkbox"
                checked={photoConsent}
                onChange={e => setPhotoConsent(e.target.checked)}
                style={{ width: 18, height: 18, marginTop: 2, accentColor: brand, flexShrink: 0 }}
              />
              <span>
                I'm happy for before & after photos to be taken and used on social media (optional)
              </span>
            </label>
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 20,
              padding: '12px 14px', borderRadius: 10, background: 'var(--bg-subtle, #FDFCFB)',
              border: '1px solid var(--border-light)', cursor: 'pointer', fontSize: 13,
              color: 'var(--text-secondary)', lineHeight: 1.5,
            }}>
              <input
                type="checkbox"
                checked={marketingOptIn}
                onChange={e => setMarketingOptIn(e.target.checked)}
                style={{ width: 18, height: 18, marginTop: 2, accentColor: brand, flexShrink: 0 }}
              />
              <span>
                Keep me posted about offers and last-minute openings (optional, reply STOP anytime)
              </span>
            </label>
            {TURNSTILE_SITE_KEY ? <TurnstileWidget onToken={setTurnstileToken} /> : null}
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
                {submitting
                  ? 'Booking...'
                  : selectedPackage
                    ? 'Use session & book'
                    : hasDeposit
                      ? paymentType === 'full'
                        ? `Pay £${(grandTotalCents / 100).toFixed(2)}`
                        : `Pay £${(depositCents / 100).toFixed(2)} deposit`
                      : selectedTreatments.length > 1
                        ? `Book ${selectedTreatments.length} treatments`
                        : 'Confirm booking'}
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
  brandBand: { textAlign: 'center', padding: '36px 20px 28px', marginTop: 24, marginBottom: 20, borderRadius: 18 },
  brandLogo: { maxHeight: 64, maxWidth: 180, objectFit: 'contain', margin: '0 auto 12px', display: 'block' },
  brandMonogram: { width: 60, height: 60, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: '#fff', fontSize: 26, fontWeight: 700, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  categoryLabel: { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', margin: '4px 0 10px' },
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
