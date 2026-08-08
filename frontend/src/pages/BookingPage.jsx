import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { supabase } from '../lib/supabase.js'
import { useParams, useLocation } from 'react-router-dom';
import PhoneField from '../components/PhoneField.jsx';
import { API_BASE } from '../lib/config.js';
import Icon, { iconName } from '../components/ui/Icon';
import Money from '../components/ui/Money';
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
    <div style={{ marginTop: 16, padding: '10px 14px', borderRadius: 10, background: '#FFF0F0', border: '1px solid var(--danger-bg)', textAlign: 'center', fontSize: 13, color: 'var(--danger)' }}>
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
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
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
  // Only paint the missing questions red once she has actually tried to book.
  // A form that is angry before you have touched it reads as broken.
  const [showConsultationErrors, setShowConsultationErrors] = useState(false);
  const [error, setError] = useState(isCancelled ? 'Payment was cancelled. Your booking slot is held for 15 minutes, you can try again.' : null);
  const confirmedManageToken = new URLSearchParams(location.search).get('mt');
  const [success, setSuccess] = useState(isConfirmedReturn ? { depositPaid: true, manageUrl: confirmedManageToken ? `/book/${slug}/manage/${confirmedManageToken}` : null } : null);
  // Receipt for the Stripe-return success screen. The figures come from the
  // manage endpoint, which reads the logged charge, so what we show matches
  // the card statement instead of being recomputed from the treatment price.
  const [receipt, setReceipt] = useState(null);
  useEffect(() => {
    if (!isConfirmedReturn || !confirmedManageToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${confirmedManageToken}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.payment) setReceipt(data.payment);
      } catch {
        // The receipt is a bonus; the confirmation stands without it.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfirmedReturn, confirmedManageToken, slug]);
  const [fieldErrors, setFieldErrors] = useState({});
  // Data
  const [beautician, setBeautician] = useState(null);
  const [treatments, setTreatments] = useState([]);
  const [slots, setSlots] = useState([]);
  // Availability fetch failed (rate limit / network): fail CLOSED. Showing
  // every slot as free when we could not load the booked ones is how times
  // "move around" between refreshes and how double-bookings happen.
  const [availError, setAvailError] = useState(false);
  const [availRetryNonce, setAvailRetryNonce] = useState(0);
  // Calendar (Step 1) state. calMonth = first-of-month Date for the visible month.
  // monthAppointments/monthClosures hold the availability-range payload for that month.
  const [calMonth, setCalMonth] = useState(null);
  const [monthAppointments, setMonthAppointments] = useState([]);
  const [monthClosures, setMonthClosures] = useState([]);
  const [monthBlocks, setMonthBlocks] = useState([]);
  const [reviewsData, setReviewsData] = useState(null);
  // "Booked before?" one-tap rebook path on step 0
  const [rebookPhone, setRebookPhone] = useState('');
  const [rebookState, setRebookState] = useState('idle'); // idle | looking | matched | nomatch
  const [rebookMatch, setRebookMatch] = useState(null);   // lookup payload when matched
  const [calLoading, setCalLoading] = useState(false);
  // Which month the data in monthAppointments/Closures/Blocks is FOR, and
  // whether the last attempt to fetch it failed. Without these the grid cannot
  // tell "she has space" from "we never found out", and it drew them the same.
  const [monthDataFor, setMonthDataFor] = useState(null);
  const [monthError, setMonthError] = useState(false);
  const [monthRetryNonce, setMonthRetryNonce] = useState(0);
  // User selections, multi-treatment support
  const [selectedTreatments, setSelectedTreatments] = useState([]);
  // Which treatment's description is expanded (via the little info button).
  // Descriptions used to render inline on every card, which made the list
  // huge and uneven; now they sit behind an "i" tap.
  const [descOpenId, setDescOpenId] = useState(null);
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
  // Dynamic consultation forms (loaded from form builder, falls back to defaults).
  // An ARRAY: booking brows + lashes together must ask BOTH forms, not just the first.
  const [consultationForms, setConsultationForms] = useState([]);
  const consultationForm = consultationForms[0] || null;
  const DEFAULT_CONSULTATION_QUESTIONS = [
    { key: 'allergies', label: 'Do you have any known allergies? (e.g. latex, adhesive, tint)', type: 'text' },
    { key: 'patch_test', label: 'Have you had a patch test in the last 6 months?', type: 'yes_no' },
    { key: 'medical', label: 'Any medical conditions, medications, or recent treatments we should know about?', type: 'text' },
    { key: 'pregnant', label: 'Are you pregnant or breastfeeding?', type: 'yes_no' },
    { key: 'previous_reactions', label: 'Have you had any adverse reactions to beauty treatments before?', type: 'text' },
  ];
  /**
   * Has this question actually been answered?
   *
   * One shape per field type, because "answered" is different for each and a
   * single truthiness test gets three of them wrong: an unticked checkbox is
   * `false`, an untouched multi select is `[]`, and both are falsy while
   * meaning opposite things.
   */
  function isAnswered(q, raw) {
    if (raw === null || raw === undefined) return false;
    if (q.type === 'checkbox') return raw === true;          // an "I confirm" tick must be ticked
    if (q.type === 'multi_select') return Array.isArray(raw) && raw.some(v => String(v).trim() !== '');
    return String(raw).trim() !== '';
  }

  const needsConsultation = selectedTreatments.some(t => t.requires_consultation);
  const needsPatchTest = selectedTreatments.some(t => t.requires_patch_test);
  // The questions to render, dynamic form fields if available, else defaults
  // Filter out the patch_test question for treatments that don't require it (wax, microblading, etc.)
  const consultationQuestionsRaw = consultationForms.some(f => f.consultation_form_fields?.length)
    ? consultationForms.flatMap(cf => (cf.consultation_form_fields || []).map(f => ({
        key: f.id,
        label: f.label,
        type: f.type,   // text, yes_no, multi_select, single_select, checkbox, text_block, signature
        options: f.options || [],
        required: f.required,
        section: consultationForms.length > 1 ? cf.name : null,
      })))
    : DEFAULT_CONSULTATION_QUESTIONS.filter(q => q.key !== 'patch_test' || needsPatchTest);
  // Guard: a form saved before the builder switched to replace-on-save can hold
  // two copies of every field. Collapse exact-duplicate questions so a client
  // never sees "Full name" (or any field) twice.
  const consultationQuestions = (() => {
    const seen = new Set();
    return consultationQuestionsRaw.filter(q => {
      const k = `${q.section || ''}|${q.type}|${q.label}|${JSON.stringify(q.options || [])}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  })();
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
  const rawDepositCents = selectedTreatments.reduce((sum, t) => sum + getDepositCents(t), 0);
  // Every booking secures a card deposit. If no treatment sets one, fall back to
  // the salon's configured deposit amount (mirrors the backend). Capped at price.
  const depositCents = (() => {
    if (rawDepositCents > 0) return Math.min(rawDepositCents, combinedTreatmentCents || rawDepositCents);
    if (!combinedTreatmentCents) return 0;
    const dAmt = beautician?.payment_settings?.deposit_amount || '£10';
    const floor = String(dAmt).endsWith('%')
      ? Math.round(combinedTreatmentCents * parseInt(dAmt, 10) / 100)
      : Math.round(parseFloat(String(dAmt).replace('£', '')) * 100);
    return Math.min(floor, combinedTreatmentCents);
  })();
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
  // Load consultation forms for EVERY selected treatment that has one linked.
  // Distinct ids, selection order kept, so brows + lashes asks both forms.
  const consultationFormIds = [...new Set(selectedTreatments.map(t => t.consultation_form_id).filter(Boolean))];
  useEffect(() => {
    if (!consultationFormIds.length) { setConsultationForms([]); return; }
    let alive = true;
    (async () => {
      const loaded = [];
      for (const formId of consultationFormIds) {
        try {
          const res = await fetch(`${API_BASE}/api/booking/${slug}/consultation-form/${formId}`);
          const data = await res.json();
          if (res.ok && data.form) loaded.push(data.form);
        } catch { /* fall back to default questions, non-blocking */ }
      }
      if (alive) setConsultationForms(loaded);
    })();
    return () => { alive = false; };
  }, [consultationFormIds.join(','), slug]);
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
  // Client recognition, trigger when the email OR phone field loses focus.
  // A match on EITHER field means a returning client — skips consultation/patch test.
  async function lookupClient() {
    const email = clientDetails.email?.trim();
    const phone = clientDetails.phone?.trim();
    if (!email && !phone) return;
    setLookingUpClient(true);
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/lookup-client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, phone }),
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
  // "Booked before?" quick path: phone-only lookup on step 0. On a match we
  // greet by name, prefill details, and offer their last treatment one-tap.
  async function quickRebookLookup() {
    const phone = rebookPhone.trim();
    if (phone.length < 7) return;
    setRebookState('looking');
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/lookup-client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = res.ok ? await res.json() : { found: false };
      if (data.found && data.client) {
        setRecognisedClient(data);
        setRebookMatch(data);
        setRebookState('matched');
        setClientDetails(prev => ({
          ...prev,
          name: prev.name || data.client.name,
          phone: prev.phone || data.client.phone || phone,
          email: prev.email || data.client.email || '',
        }));
      } else {
        setRebookState('nomatch');
      }
    } catch {
      setRebookState('nomatch');
    }
  }

  /**
   * Every question still waiting on an answer.
   *
   * REQUIRED IS THE DEFAULT. The builder has a `required` flag and it has
   * never been enforced anywhere: the page rendered it and the submit ignored
   * it, so a client could book a lash lift having answered nothing about
   * allergies or medication and Ellie only found out with them in the chair.
   * Ellie has marked 36 of her 40 fields required, so this is her intent being
   * honoured rather than a new rule. `required === false` is the only way out,
   * which keeps the four multi selects she deliberately left optional optional.
   * The built in questions carry no flag at all, so they are required too.
   *
   * A text_block is a paragraph to read, not a question, so it is never
   * "unanswered". A signature is: it is the thing that makes the rest consent.
   */
  const missingConsultation = !needsConsultation || recognisedClient?.found
    ? []
    : consultationQuestions.filter(q =>
        q.type !== 'text_block'
        && q.required !== false
        && !isAnswered(q, consultationAnswers[q.key]));


  function rebookSameAgain() {
    const lastId = rebookMatch?.lastTreatment?.id;
    const t = treatments.find(x => x.id === lastId);
    if (!t) return;
    setSelectedTreatments([t]);
    setFieldErrors({});
    setStep(1);
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
      let dayBlocks = [];
      let dayClosed = false;
      setAvailError(false);
      // On failure (rate limit, flaky mobile signal) retry once, then fail
      // CLOSED: show a "try again" note instead of pretending every time is
      // free. The old catch fell through with appts=[] so a failed fetch
      // offered slots that were actually booked, and the list visibly jumped
      // between "everything free" and reality on each refresh.
      let av = null;
      for (let attempt = 0; attempt < 2 && !av; attempt++) {
        try {
          const avRes = await fetch(`${API_BASE}/api/booking/${slug}/availability?date=${selectedDate}`);
          if (avRes.ok) av = await avRes.json();
          else if (attempt === 0) await new Promise(r => setTimeout(r, 1200));
        } catch {
          if (attempt === 0) await new Promise(r => setTimeout(r, 1200));
        }
      }
      if (!av) {
        setSlots([]);
        setSelectedSlot(null);
        setAvailError(true);
        return;
      }
      appts = av.appointments || [];
      dayBlocks = av.blocks || [];
      dayClosed = av.closed === true;
      if (dayClosed) {
        setSlots([]);
        setSelectedSlot(null);
        return;
      }
      // starts_at stores salon WALL time in the string (11:00 salon = 11:00Z),
      // so read it straight off the string. new Date().getHours() shifted it
      // +1h in BST and the picker offered slots that were actually booked.
      bookedSlots = (appts || []).map(a => {
        const str = String(a.starts_at || '');
        const start = parseInt(str.slice(11, 13), 10) * 60 + parseInt(str.slice(14, 16), 10);
        return { start, end: start + (a.duration_minutes || 60) + (a.buffer_minutes || 0) };
      }).filter(b => !Number.isNaN(b.start));
      // Blocked-out time ranges count as taken, same as appointments.
      const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
      for (const b of dayBlocks) {
        if (b.start_time && b.end_time) bookedSlots.push({ start: toMin(b.start_time), end: toMin(b.end_time) });
      }
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
  }, [selectedDate, selectedTreatments, beautician, combinedDuration, availRetryNonce]);
  // --- Calendar helpers (Step 1 month grid) ---------------------------------
  // Build a YYYY-MM-DD from LOCAL date parts (never toISOString, which can shift
  // the day under BST).
  function isoLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
  function sameMonth(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }
  const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
  const earliestBookable = new Date(todayMid); earliestBookable.setDate(earliestBookable.getDate() + 1); // tomorrow
  // max_advance_days: a positive value (30/60/90) caps the window; 0 or unset
  // means "No limit" (the Settings default), so open a generous year-long window
  // rather than the old 14-day cap that made "No limit" wrongly stop in 2 weeks.
  const maxAdvance = beautician?.booking_policy?.max_advance_days;
  const horizonDays = maxAdvance && maxAdvance > 0 ? maxAdvance : 365;
  const horizonDate = new Date(todayMid); horizonDate.setDate(horizonDate.getDate() + horizonDays);
  // Default the visible month to the month containing the earliest bookable day.
  useEffect(() => {
    if (!beautician || calMonth) return;
    setCalMonth(startOfMonth(earliestBookable));
  }, [beautician]); // eslint-disable-line react-hooks/exhaustive-deps
  // Fetch the month's booked blocks + closures in ONE request whenever the
  // visible month or chosen treatments change (only while on Step 1).
  useEffect(() => {
    if (step !== 1 || !calMonth || !beautician) return;
    const monthStart = startOfMonth(calMonth);
    const monthEnd = endOfMonth(calMonth);
    // from = max(tomorrow, month start); to = month end
    const from = isoLocal(earliestBookable > monthStart ? earliestBookable : monthStart);
    const to = isoLocal(monthEnd);
    let cancelled = false;
    setCalLoading(true);
    (async () => {
      const monthKey = `${calMonth.getFullYear()}-${calMonth.getMonth()}`;
      try {
        const res = await fetch(`${API_BASE}/api/booking/${slug}/availability-range?from=${from}&to=${to}`);
        // On failure KEEP whatever we already have rather than clearing to
        // "everything free". Clearing made day states flicker between free
        // and booked while someone was picking (rate limits, weak signal),
        // which read as "the dates keep moving around".
        //
        // But keeping stale data is only honest when the data is FOR THIS
        // MONTH. On a first load there is nothing to keep, and an empty diary
        // renders as a month with space on every single day. Somebody picks a
        // date that is not free, the server refuses, and from where they are
        // standing the booking page is simply broken. So the grid now knows
        // which month it actually has, and says so when it has nothing.
        if (!res.ok) throw new Error(`availability-range ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setMonthAppointments(data.appointments || []);
        setMonthClosures(data.closures || []);
        setMonthBlocks(data.blocks || []);
        setMonthDataFor(monthKey);
        setMonthError(false);
      } catch (err) {
        if (cancelled) return;
        logger.debug('Month availability failed:', err);
        // Only an error if we have nothing trustworthy to show for this month.
        setMonthError(monthDataFor !== monthKey);
      } finally {
        if (!cancelled) setCalLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [step, calMonth, selectedTreatments, beautician, slug, monthRetryNonce]); // eslint-disable-line react-hooks/exhaustive-deps
  // Group the month's booked blocks by their LOCAL date so per-day status is cheap.
  const apptsByDay = useMemo(() => {
    const map = {};
    for (const a of monthAppointments) {
      // Wall-time read off the stored string (see loadSlots): no browser
      // timezone may shift the date or the minutes.
      const str = String(a.starts_at || '');
      const key = str.slice(0, 10);
      const startMin = parseInt(str.slice(11, 13), 10) * 60 + parseInt(str.slice(14, 16), 10);
      if (!key || Number.isNaN(startMin)) continue;
      const endMin = startMin + (a.duration_minutes || 60) + (a.buffer_minutes || 0);
      (map[key] = map[key] || []).push({ start: startMin, end: endMin });
    }
    return map;
  }, [monthAppointments]);
  // Public review summary for the info section below the flow. Fails soft:
  // on any error the section simply stays hidden.
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/booking/${slug}/reviews`);
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled) setReviewsData(d);
      } catch { /* hidden */ }
    })();
    return () => { cancelled = true; };
  }, [slug]);
  const closureSet = useMemo(() => new Set(monthClosures || []), [monthClosures]);
  // Partial-day blocks keyed by date, as taken minute-ranges (mirrors apptsByDay).
  const blocksByDay = useMemo(() => {
    const map = {};
    for (const b of monthBlocks || []) {
      if (!b.date || !b.start_time || !b.end_time) continue;
      const [sh, sm] = String(b.start_time).split(':').map(Number);
      const [eh, em] = String(b.end_time).split(':').map(Number);
      (map[b.date] = map[b.date] || []).push({ start: sh * 60 + sm, end: eh * 60 + em });
    }
    return map;
  }, [monthBlocks]);
  // Compute a status for a given Date cell: 'past' | 'beyond' | 'off' | 'closed'
  // | 'open' (has space) | 'full' (working but no fitting slot).
  function dayStatus(d) {
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    if (day < earliestBookable) return 'past';
    if (day > horizonDate) return 'beyond';
    // No diary for this month means no opinion about it. Saying 'open' here is
    // saying she is free on a day we have not looked at.
    if (calMonth && monthDataFor !== `${calMonth.getFullYear()}-${calMonth.getMonth()}`) return 'unknown';
    const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day.getDay()];
    const hours = beautician?.working_hours?.[dayKey];
    if (!hours || !hours.start || !hours.end) return 'off';
    const iso = isoLocal(day);
    if (closureSet.has(iso)) return 'closed';
    // Replicate the slot math: a free slot must fit combinedDuration + max buffer.
    const duration = combinedDuration || 60;
    const buffer = Math.max(...selectedTreatments.map(t => t.buffer_minutes || 0), 0);
    const totalBlock = duration + buffer;
    const [startH, startM] = hours.start.split(':').map(Number);
    const [endH, endM] = hours.end.split(':').map(Number);
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;
    const booked = [...(apptsByDay[iso] || []), ...(blocksByDay[iso] || [])];
    for (let m = startMin; m + totalBlock <= endMin; m += 30) {
      const clashes = booked.some(b => m < b.end && m + totalBlock > b.start);
      if (!clashes) return 'open';
    }
    return 'full';
  }
  // Build the visible month grid: leading blanks so the 1st lands on the right
  // weekday (Mon-first), then every day of the month.
  const monthCells = useMemo(() => {
    if (!calMonth) return [];
    const first = startOfMonth(calMonth);
    const last = endOfMonth(calMonth);
    // JS getDay(): 0=Sun..6=Sat. We want Mon-first, so blanks = (getDay()+6)%7.
    const lead = (first.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= last.getDate(); d++) {
      cells.push(new Date(calMonth.getFullYear(), calMonth.getMonth(), d));
    }
    return cells;
  }, [calMonth]);
  const canGoPrev = calMonth ? !sameMonth(calMonth, todayMid) : false;
  const canGoNext = calMonth ? !sameMonth(calMonth, horizonDate) && calMonth < startOfMonth(horizonDate) : false;
  // Submit booking via backend API (handles client creation, conflict checks, deposits)
  async function handleBook() {
    // Refuse before anything is created. A booking that skips the medical
    // questions is exactly the booking Ellie needs the answers for, and the
    // required flag on her own form fields was being rendered and then ignored.
    if (missingConsultation.length > 0) {
      setShowConsultationErrors(true);
      const n = missingConsultation.length;
      setError(n === 1
        ? 'One question on the consultation form still needs an answer.'
        : `${n} questions on the consultation form still need an answer.`);
      // Take them to the first one rather than making them hunt for it.
      const first = document.getElementById(`consultation-q-${missingConsultation[0].key}`);
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

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
          // Only new clients submit consultation/patch-test answers; returning
          // clients skip the form entirely so we never send (or require) it.
          consultation: !recognisedClient?.found ? consultationAnswers : null,
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
        // Rate limited mid-booking: nothing is wrong with their booking, they
        // just need a moment. Never surface a scary technical error here.
        if (res.status === 429) {
          throw new Error('Lots of people are booking right now. Wait a minute and tap confirm again, your details are saved.');
        }
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
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>{error}</p>
        </div>
      </div>
    );
  }
  if (success) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={{ ...styles.successIcon, background: brandLight, color: brand }}><Icon name="check" size={15} /></div>
          <h2 style={styles.successTitle}>
            {success.depositPaid ? (receipt?.paidInFull ? "You're booked, paid in full" : "You're booked, deposit paid") : success.depositPending ? "Almost there, deposit needed" : "You're booked"}
          </h2>
          <div style={styles.successDetails}>
            {success.depositPaid ? (
              <>
                <p>{receipt?.paidInFull ? 'Your payment has been received and your appointment is confirmed.' : 'Your deposit has been received and your appointment is confirmed.'} You'll get a confirmation message shortly.</p>
                {receipt && receipt.depositPaidCents > 0 && (
                  /* Same three-line sum as the manage page: total, minus what
                     was just paid, equals what is left on the day. Spelled out
                     because a single sentence kept reading as either "that was
                     the whole price" or "I still owe the whole price". */
                  <div style={{ marginTop: 12, textAlign: 'left', background: brandLight, borderRadius: 10, padding: '10px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 14 }}>
                      <span>Total</span>
                      <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}><Money pence={(receipt.priceCents || 0)} /></span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 14, color: 'var(--text-secondary)' }}>
                      <span>{receipt.paidInFull ? 'Paid now' : 'Deposit paid now'}</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{'\u2212'}<Money pence={receipt.depositPaidCents} /></span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', marginTop: 4, borderTop: '1px solid rgba(0,0,0,0.08)', fontSize: 15 }}>
                      {receipt.paidInFull || receipt.remainingCents === 0 ? (
                        <span style={{ fontWeight: 700, color: brand }}>Paid in full, nothing due on the day</span>
                      ) : (
                        <>
                          <span style={{ fontWeight: 700, color: brand }}>To pay on the day</span>
                          <span style={{ fontWeight: 700, color: brand, fontVariantNumeric: 'tabular-nums' }}><Money pence={receipt.remainingCents} /></span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </>
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
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 12 }}>
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
          {/* Patch test prompt, the moment they book a treatment that needs one */}
          {needsPatchTest && success.manageUrl && (
            <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: 10, background: brandLight, border: `1.5px solid ${brandMedium}`, textAlign: 'left' }}>
              <p style={{ fontSize: 14, fontWeight: 700, color: brand, margin: '0 0 4px' }}>One more step: your patch test 🩹</p>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>
                This treatment needs a quick patch test at least 24 hours before your appointment. It only takes a few minutes, tap below to pick a time.
              </p>
              <a className="fl-tap" href={`${success.manageUrl}?book=patch`} style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '12px 0', borderRadius: 10, textAlign: 'center', background: brand, color: '#fff', fontWeight: 600, fontSize: 14, textDecoration: 'none' }}>
                Book my patch test →
              </a>
            </div>
          )}
          {/* Pay the remaining balance by bank transfer, when there's a balance
              left after the deposit and the beautician has shared bank details. */}
          {(() => {
            const bankDetails = beautician?.payment_settings?.bank_details;
            if (!bankDetails?.account_number) return null;
            const priceVal = parseFloat((success.price || '£0').replace(/[£,]/g, ''));
            const depositVal = parseFloat((success.deposit || '£0').replace(/[£,]/g, ''));
            const remaining = priceVal - depositVal;
            if (!(remaining > 0)) return null;
            const firstName = (clientDetails.name || '').trim().split(' ')[0];
            return (
              <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: 10, background: brandLight, border: `1.5px solid ${brandMedium}`, textAlign: 'left' }}>
                <p style={{ fontSize: 14, fontWeight: 700, color: brand, margin: '0 0 4px' }}>Pay the rest by bank transfer 🏦</p>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>
                  <strong style={{ color: brand }}><Money amount={remaining} /></strong> remaining after your deposit. Transfer it to:
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {bankDetails.account_name && (
                    <div style={styles.bankRow}>
                      <span style={styles.bankLabel}>Account name</span>
                      <span style={styles.bankValue}>{bankDetails.account_name}</span>
                    </div>
                  )}
                  {bankDetails.sort_code && (
                    <div style={styles.bankRow}>
                      <span style={styles.bankLabel}>Sort code</span>
                      <span style={styles.bankValueMono}>{bankDetails.sort_code}</span>
                    </div>
                  )}
                  <div style={styles.bankRow}>
                    <span style={styles.bankLabel}>Account number</span>
                    <span style={styles.bankValueMono}>{bankDetails.account_number}</span>
                  </div>
                  <div style={styles.bankRow}>
                    <span style={styles.bankLabel}>Reference</span>
                    <span style={styles.bankValue}>
                      {bankDetails.reference_note || firstName || 'use your name as the reference'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })()}
          {/* Loyalty mention, only when the salon runs a programme */}
          {beautician?.loyalty_enabled && (
            <p style={{ fontSize: 13, color: brand, fontWeight: 600, textAlign: 'center', marginTop: 4 }}>
              This visit earns you points with {bizName}
            </p>
          )}
          {/* Payment buffer countdown */}
          {success.paymentExpiresAt && (
            <PaymentCountdown expiresAt={success.paymentExpiresAt} brand={brand} brandLight={brandLight} />
          )}
          {/* Manage booking portal link */}
          {success.manageUrl && (
            <div style={{ marginTop: 20 }}>
              <a
                href={success.manageUrl}
                style={{ display: 'block', width: '100%', boxSizing: 'border-box',
                  padding: '13px 0', borderRadius: 10, textAlign: 'center',
                  background: brandLight, color: brand,
                  fontWeight: 600, fontSize: 15, textDecoration: 'none',
                  border: `1.5px solid ${brand}22`,
                }}
              >
                Manage my booking
              </a>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 8 }}>
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
            <div style={{ ...styles.progressDot,
              background: i <= step ? brand : 'var(--border-light)',
              transform: i === step ? 'scale(1.2)' : 'scale(1)'
            }} />
            <span style={{ ...styles.progressLabel,
              color: i <= step ? brand : 'var(--text-muted)',
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
            {/* Returning clients: recognise + one-tap "same again" */}
            {rebookState !== 'matched' && (
              <div style={{ background: 'var(--tone-2, #f6e7dd)', borderRadius: 16, padding: '12px 14px', marginBottom: 18 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 8px' }}>
                  Been here before? Pop your mobile in and skip the form.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="tel"
                    inputMode="tel"
                    placeholder="07..."
                    value={rebookPhone}
                    onChange={e => { setRebookPhone(e.target.value); if (rebookState === 'nomatch') setRebookState('idle'); }}
                    onKeyDown={e => { if (e.key === 'Enter') quickRebookLookup(); }}
                    style={{ flex: 1, minWidth: 0, minHeight: 44, padding: '0 12px', borderRadius: 10, border: 'none', background: 'var(--bg-card)', fontSize: 14, fontFamily: 'inherit', outline: 'none' }}
                  />
                  <button
                    onClick={quickRebookLookup}
                    disabled={rebookState === 'looking' || rebookPhone.trim().length < 7}
                    style={{ minHeight: 44, padding: '0 16px', borderRadius: 10, border: 'none', background: brand, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: rebookState === 'looking' || rebookPhone.trim().length < 7 ? 0.55 : 1 }}
                  >
                    {rebookState === 'looking' ? 'Looking…' : 'Find me'}
                  </button>
                </div>
                {rebookState === 'nomatch' && (
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0 0' }}>
                    No booking under that number yet. Pick a treatment below and we will set you up.
                  </p>
                )}
              </div>
            )}
            {rebookState === 'matched' && rebookMatch && (
              <div style={{ background: brandLight, borderRadius: 16, padding: '14px 16px', marginBottom: 18 }}>
                <p style={{ fontSize: 15, fontWeight: 700, color: brand, margin: 0, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" }}>
                  Welcome back, {rebookMatch.client.name.split(' ')[0]}
                </p>
                {rebookMatch.lastTreatment && treatments.some(x => x.id === rebookMatch.lastTreatment.id) ? (
                  <>
                    <p style={{ fontSize: 13.5, color: 'var(--text-primary)', margin: '6px 0 12px', lineHeight: 1.5 }}>
                      Same {rebookMatch.lastTreatment.name} as last time?
                    </p>
                    <button
                      onClick={rebookSameAgain}
                      style={{ width: '100%', minHeight: 46, borderRadius: 10, border: 'none', background: brand, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      Yes, pick a time
                    </button>
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0 0', textAlign: 'center' }}>
                      Or choose something different below. Your details are already filled in.
                    </p>
                  </>
                ) : (
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '6px 0 0', lineHeight: 1.5 }}>
                    Lovely to see you again. Pick a treatment below, your details are already filled in.
                  </p>
                )}
              </div>
            )}
            <h2 style={styles.stepTitle}>Choose your treatment{selectedTreatments.length > 1 ? 's' : ''}</h2>
            {selectedTreatments.length === 0 && (
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '-12px 0 14px' }}>Tap multiple to book them together</p>
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
                    style={{ ...styles.treatmentCard,
                      borderColor: isSelected ? brand : '#E8E4DF',
                      background: isSelected ? brandLight : 'var(--bg-card)'
                    }}
                  >
                    <div style={styles.treatmentInfo}>
                      <span style={styles.treatmentName}>
                        {isSelected ? '✓ ' : ''}{t.name}
                        {t.description && (
                          <span className="fl-tap"
                            role="button"
                            aria-label={descOpenId === t.id ? 'Hide description' : 'Show description'}
                            aria-expanded={descOpenId === t.id}
                            onClick={e => {
                              e.stopPropagation();
                              setDescOpenId(prev => (prev === t.id ? null : t.id));
                            }}
                            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              width: 20, height: 20, marginLeft: 6, borderRadius: 10, verticalAlign: 'middle',
                              border: `1.2px solid ${descOpenId === t.id ? brand : '#CFC8C1'}`,
                              color: descOpenId === t.id ? brand : 'var(--text-muted)',
                              fontSize: 11, fontWeight: 700, fontStyle: 'italic', fontFamily: 'Georgia, serif',
                              lineHeight: 1, cursor: 'pointer', userSelect: 'none',
                            }}
                          >
                            i
                          </span>
                        )}
                      </span>
                      {t.description && descOpenId === t.id && (
                        <span style={styles.treatmentDesc}>{t.description}</span>
                      )}
                      <span style={styles.treatmentDuration}>{t.duration_minutes} min</span>
                    </div>
                    <span style={styles.treatmentPrice}>
                      <Money pence={t.price_cents} />
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
                  {selectedTreatments.length} treatments · {combinedDuration} min · <Money pence={combinedTreatmentCents} />
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
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '12px 14px', borderRadius: 10,
                          border: `1.5px solid ${isSelected ? brand : '#E8E4DF'}`,
                          background: isSelected ? brandLight : 'var(--bg-card)',
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
                          +<Money pence={ao.price_cents} />
                        </span>
                      </button>
                    );
                  })}
                </div>
                {selectedAddOns.length > 0 && (
                  <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 10, background: brandLight, fontSize: 13, fontWeight: 500, color: brand, textAlign: 'center' }}>
                    Total: <Money pence={grandTotalCents} /> · {(selectedTreatment.duration_minutes || 0) + addOnDuration} min
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
                        style={{ display: 'flex', alignItems: 'center', gap: 12,
                          padding: '12px 14px', borderRadius: 10,
                          border: `1.5px solid ${qty > 0 ? brand : '#E8E4DF'}`,
                          background: qty > 0 ? brandLight : 'var(--bg-card)',
                        }}
                      >
                        {product.image_url && (
                          <img
                            src={product.image_url}
                            alt={product.name}
                            style={{ width: 44, height: 44, borderRadius: 10, objectFit: 'cover' }}
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
                            <Money pence={product.price_cents} />
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {qty > 0 && (
                            <button className="fl-tap"
                              onClick={() => updateCart(product.id, -1)}
                              style={{ width: 28, height: 28, borderRadius: '50%', border: `1px solid ${brand}`,
                                background: 'var(--bg-card)', color: brand, fontSize: 16, fontWeight: 700,
                                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontFamily: 'inherit', padding: 0,
                              }}
                            >−</button>
                          )}
                          {qty > 0 && (
                            <span style={{ fontSize: 14, fontWeight: 600, minWidth: 16, textAlign: 'center' }}>{qty}</span>
                          )}
                          <button className="fl-tap"
                            onClick={() => updateCart(product.id, 1)}
                            style={{ width: 28, height: 28, borderRadius: '50%', border: 'none',
                              background: qty > 0 ? brand : '#E8E4DF', color: qty > 0 ? '#fff' : 'var(--text-secondary)',
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
                  <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 10, background: brandLight, fontSize: 13, fontWeight: 500, color: brand, textAlign: 'center' }}>
                    Products: <Money pence={cartTotalCents} /> · {cartItems.length} item{cartItems.length !== 1 ? 's' : ''}
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
            {needsPatchTest && (
              <div style={{ margin: '0 0 12px', padding: '11px 13px', borderRadius: 10, background: brandLight, border: `1px solid ${brandMedium}`, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                <strong style={{ color: brand }}>Heads up:</strong> new clients need a quick patch test at least 24 hours before this treatment. Pick a time from tomorrow onwards and we'll set the patch test up right after you book.
              </div>
            )}
            {fieldErrors.date && (
              <div style={styles.inlineError}>{fieldErrors.date}</div>
            )}
            {/* Month calendar, makes free days unmistakable */}
            <div style={styles.calWrap}>
              <div style={styles.calHeader}>
                <button
                  type="button"
                  onClick={() => canGoPrev && setCalMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                  disabled={!canGoPrev}
                  aria-label="Previous month"
                  style={{ ...styles.calNav, color: canGoPrev ? brand : '#D8D2CC', cursor: canGoPrev ? 'pointer' : 'default' }}
                >‹</button>
                <span style={styles.calMonthLabel}>
                  {calMonth ? calMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : ''}
                </span>
                <button
                  type="button"
                  onClick={() => canGoNext && setCalMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                  disabled={!canGoNext}
                  aria-label="Next month"
                  style={{ ...styles.calNav, color: canGoNext ? brand : '#D8D2CC', cursor: canGoNext ? 'pointer' : 'default' }}
                >›</button>
              </div>
              <div style={styles.calWeekRow}>
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(w => (
                  <span key={w} style={styles.calWeekday}>{w}</span>
                ))}
              </div>
              <div style={styles.calGrid}>
                {monthCells.map((d, i) => {
                  if (!d) return <span key={`b${i}`} />;
                  const iso = isoLocal(d);
                  const status = dayStatus(d);
                  const isSelected = selectedDate === iso;
                  const tappable = status === 'open';   // never 'unknown'
                  let bg = 'var(--bg-card)';
                  let color = 'var(--text-primary)';
                  let border = '1px solid transparent';
                  if (isSelected) {
                    bg = brand; color = '#fff'; border = `1px solid ${brand}`;
                  } else if (status === 'open') {
                    border = `1px solid ${brand}33`;
                  } else if (status === 'full') {
                    color = '#BAB4AE'; bg = 'transparent';
                  } else {
                    // past / beyond / off / closed
                    color = '#D2CCC6'; bg = 'transparent';
                  }
                  return (
                    <button
                      key={iso}
                      type="button"
                      disabled={!tappable}
                      onClick={() => { if (tappable) { setSelectedDate(iso); setFieldErrors({}); } }}
                      title={status === 'closed' ? 'Closed' : status === 'full' ? 'Fully booked' : status === 'unknown' ? 'Could not load this month' : undefined}
                      style={{ ...styles.calCell,
                        background: bg,
                        color,
                        border,
                        cursor: tappable ? 'pointer' : 'default',
                        fontWeight: isSelected ? 700 : status === 'open' ? 600 : 400,
                      }}
                    >
                      <span style={{ lineHeight: 1 }}>{d.getDate()}</span>
                      {/* "has space" dot */}
                      <span style={{ ...styles.calDot,
                        background: status === 'open' && !isSelected ? brand : 'transparent',
                      }} />
                    </button>
                  );
                })}
              </div>
              {calLoading && (
                <div style={styles.calLoadingRow}>
                  <span style={{ ...styles.calSpinner, borderTopColor: brand }} />
                </div>
              )}
              {/* Says out loud that it could not check, rather than drawing an
                  empty diary and letting somebody pick a day that is taken. */}
              {monthError && (
                <div style={{ textAlign: 'center', padding: '14px 0 4px' }}>
                  <p style={{ ...styles.noSlots, padding: 0, marginBottom: 10 }}>
                    Couldn't load this month just now, so these dates may not be right. Try again in a moment.
                  </p>
                  <button className="fl-tap"
                    onClick={() => setMonthRetryNonce(n => n + 1)}
                    style={{ padding: '10px 22px', borderRadius: 10, border: `1.5px solid ${brand}`, background: 'var(--bg-card)', color: brand, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    Try again
                  </button>
                </div>
              )}
              {/* Legend */}
              <div style={styles.calLegend}>
                <span style={styles.calLegendItem}>
                  <span style={{ ...styles.calLegendDot, background: brand }} /> has space
                </span>
                <span style={styles.calLegendItem}>
                  <span style={{ ...styles.calLegendDot, background: '#D2CCC6' }} /> unavailable
                </span>
              </div>
            </div>
            {selectedDate && availError && (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <p style={{ ...styles.noSlots, padding: 0, marginBottom: 10 }}>
                  Having trouble loading times for this day. Nothing is lost, just try again in a moment.
                </p>
                <button className="fl-tap"
                  onClick={() => setAvailRetryNonce(n => n + 1)}
                  style={{ padding: '10px 22px', borderRadius: 10, border: `1.5px solid ${brand}`, background: 'var(--bg-card)', color: brand, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  Try again
                </button>
              </div>
            )}
            {selectedDate && !availError && (
              <div style={styles.slotGrid}>
                {slots.length === 0 ? (
                  <p style={styles.noSlots}>No available slots on this day, try another date</p>
                ) : (
                  slots.map(s => (
                    <button
                      key={s.starts_at}
                      onClick={() => { setSelectedSlot(s); setFieldErrors({}); setStep(2); }}
                      style={{ ...styles.slotChip,
                        borderColor: selectedSlot?.starts_at === s.starts_at ? brand : '#E8E4DF',
                        background: selectedSlot?.starts_at === s.starts_at ? brand : 'var(--bg-card)',
                        color: selectedSlot?.starts_at === s.starts_at ? '#fff' : 'var(--text-primary)'
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
            {needsPatchTest && !recognisedClient?.found && selectedSlot &&
              ((new Date(selectedSlot.starts_at).getTime() - Date.now()) / 3600000) < 24 && (
              <div style={{ margin: '0 0 12px', padding: '11px 13px', borderRadius: 10, background: '#FEF3C7', border: '1px solid #F5D67E', fontSize: 12.5, lineHeight: 1.5, color: '#8A5A00' }}>
                That time is under 24 hours away. As a new client you'll need a quick patch test first, so please <button className="fl-tap" type="button" onClick={() => setStep(1)} style={{ background: 'none', border: 'none', padding: 0, color: '#8A5A00', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5 }}>pick a time from tomorrow onwards</button>.
              </div>
            )}
            <div style={styles.form}>
              <div>
                <input
                  type="text" placeholder="Your name *"
                  value={clientDetails.name}
                  onChange={e => setClientDetails({ ...clientDetails, name: e.target.value })}
                  style={{ ...styles.input,
                    borderColor: fieldErrors.name ? 'var(--danger)' : '#E8E4DF'
                  }} required
                />
                {fieldErrors.name && <span style={styles.fieldErrorText}>{fieldErrors.name}</span>}
              </div>
              <div>
                <PhoneField
                  value={clientDetails.phone}
                  onChange={phone => { setClientDetails({ ...clientDetails, phone }); setRecognisedClient(null); }}
                  onBlur={lookupClient}
                  style={styles.input}
                  error={!!fieldErrors.phone}
                />
                {fieldErrors.phone && <span style={styles.fieldErrorText}>{fieldErrors.phone}</span>}
                {memberInfo && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6,
                    padding: '6px 10px', borderRadius: 10, background: 'var(--gold-bg, #FFF8E1)',
                    border: '1px solid var(--gold, #8A6420)', fontSize: 12, fontWeight: 500,
                    color: 'var(--gold, #8A6420)',
                  }}><Icon name="star" size={14} inline /> Member, {memberInfo.plan_name}
                  </div>
                )}
                <p style={{ fontSize: 11, color: '#9C9690', marginTop: 6, marginBottom: 0, lineHeight: 1.4,
                }}>
                  By providing your phone number, you agree to receive SMS booking confirmations and reminders from your beautician. Reply <strong>STOP</strong> to opt out at any time. Standard message and data rates may apply. See our <a href="/privacy" style={{ color: '#9C9690', textDecoration: 'underline' }}>Privacy Policy</a>.
                </p>
              </div>
              <div>
                <input
                  type="email" placeholder="Email (optional)"
                  value={clientDetails.email}
                  onChange={e => { setClientDetails({ ...clientDetails, email: e.target.value }); setRecognisedClient(null); }}
                  onBlur={lookupClient}
                  style={{ ...styles.input,
                    borderColor: fieldErrors.email ? 'var(--danger)' : '#E8E4DF'
                  }}
                />
                {fieldErrors.email && <span style={styles.fieldErrorText}>{fieldErrors.email}</span>}
                {lookingUpClient && (
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Checking…</p>
                )}
                {recognisedClient?.found && (
                  <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 10,
                    background: `${brand}10`, border: `1px solid ${brand}30`,
                    fontSize: 13,
                  }}>
                    <span style={{ fontWeight: 600, color: brand }}>
                      Welcome back, {recognisedClient.client.name.split(' ')[0]}!
                    </span>
                    <span style={{ color: 'var(--text-secondary)' }}> We've filled in your details.</span>
                    {recognisedClient.hasPendingPatchTest && needsPatchTest && (
                      <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--warning)', fontWeight: 500 }}><Icon name="alert-triangle" size={14} inline /> You have a patch test pending, your beautician will be in touch.
                      </p>
                    )}
                    {recognisedClient.hasPendingForm && (
                      <p style={{ margin: '4px 0 0', fontSize: 12, color: '#7B6BA8', fontWeight: 500 }}><Icon name="list" size={14} inline /> You have a consultation form to complete.
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
                    // Consultation form + patch test are ONLY for new clients.
                    // A recognised (returning) client always skips straight to review,
                    // never re-asked for a form or patch test they've already done.
                    const askForms = !recognisedClient?.found /* every first visit gets the form (Ellie's rule) */;
                    setStep(askForms ? 2.5 : 3);
                  }
                }}
                disabled={!clientDetails.name || !clientDetails.phone}
                style={{ ...styles.primaryBtn,
                  background: (!clientDetails.name || !clientDetails.phone) ? '#ccc' : brand,
                  cursor: (!clientDetails.name || !clientDetails.phone) ? 'not-allowed' : 'pointer'
                }}
              >
                {!recognisedClient?.found /* every first visit gets the form (Ellie's rule) */ ? 'Next: Consultation form' : 'Review booking'}
              </button>
            </div>
          </div>
        )}
        {/* Step 2.5: Consultation Form (only for treatments that require it) */}
        {step === 2.5 && (
          <div>
            <h2 style={styles.stepTitle}>
              {consultationForms.length > 1 ? 'Consultation forms' : (consultationForm?.name || 'Consultation form')}
            </h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
              {needsConsultation
                ? `Required for ${selectedTreatment?.name}. This information helps your beautician prepare and is kept for insurance records.`
                : 'A few quick questions for your first visit. It helps your beautician look after you properly and is kept for insurance records.'}
            </p>
            {/* Consent paragraph moved to just before the signature (below), matching what the form editor promises. */}
            <div style={styles.formFields}>
              {consultationQuestions.map((q, qi) => {
                const isMissing = showConsultationErrors && missingConsultation.some(m => m.key === q.key);
                return (
                <div
                  key={q.key}
                  id={`consultation-q-${q.key}`}
                  style={{ marginBottom: 14,
                    // Marked, not shouted at: a thin rule down the side of the
                    // question rather than a red box round the whole thing.
                    ...(isMissing ? {
                      borderLeft: '3px solid var(--danger, #9E2B32)',
                      paddingLeft: 10,
                      marginLeft: -13,
                    } : {}),
                  }}
                >
                  {q.section && (qi === 0 || consultationQuestions[qi - 1].section !== q.section) && (
                    <div style={{ fontSize: 14, fontWeight: 700, color: brand, margin: '18px 0 10px', paddingBottom: 6, borderBottom: '1px solid var(--border-light, #ede7e3)' }}>
                      {q.section}
                    </div>
                  )}
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#444', marginBottom: 4 }}>
                    {q.label}
                    {q.type !== 'text_block' && q.required !== false && (
                      <span style={{ color: 'var(--danger, #9E2B32)' }}> *</span>
                    )}
                  </label>
                  {isMissing && (
                    <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 600, color: 'var(--danger, #9E2B32)' }}>
                      {q.type === 'signature' ? 'Please sign to confirm' : 'Please answer this one'}
                    </p>
                  )}
                  {/* Yes/No toggle */}
                  {q.type === 'yes_no' && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      {['Yes', 'No'].map(opt => (
                        <button className="fl-tap" key={opt} onClick={() => setConsultationAnswers(p => ({ ...p, [q.key]: opt }))}
                          style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                            background: consultationAnswers[q.key] === opt ? brand : '#F0ECE8',
                            color: consultationAnswers[q.key] === opt ? '#fff' : 'var(--text-secondary)'
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
                        <button className="fl-tap" key={opt} onClick={() => setConsultationAnswers(p => ({ ...p, [q.key]: opt }))}
                          style={{ padding: '8px 14px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 500,
                            cursor: 'pointer', fontFamily: 'inherit',
                            background: consultationAnswers[q.key] === opt ? brand : '#F0ECE8',
                            color: consultationAnswers[q.key] === opt ? '#fff' : 'var(--text-secondary)'
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
                          <button className="fl-tap" key={opt} onClick={() => {
                            setConsultationAnswers(p => {
                              const current = p[q.key] || [];
                              return { ...p, [q.key]: selected ? current.filter(v => v !== opt) : [...current, opt] };
                            });
                          }}
                            style={{ padding: '8px 14px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 500,
                              cursor: 'pointer', fontFamily: 'inherit',
                              background: selected ? brand : '#F0ECE8',
                              color: selected ? '#fff' : 'var(--text-secondary)'
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
                  {/* Signature: typing your full name acts as the e-signature */}
                  {q.type === 'signature' && (
                    <div>
                      {[...new Set(consultationForms.map(cf => cf.consent_text).filter(Boolean))].map((txt, ci) => (
                        <p key={`consent-${ci}`} style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5, padding: '10px 12px', background: 'var(--bg-subtle, #ede7e3)', borderRadius: 10, border: '1px solid var(--border-light)' }}>{txt}</p>
                      ))}
                      <input
                        type="text"
                        value={consultationAnswers[q.key] || ''}
                        onChange={e => setConsultationAnswers(p => ({ ...p, [q.key]: e.target.value }))}
                        placeholder="Type your full name to sign"
                        style={{ ...styles.input, fontFamily: "'Brush Script MT', 'Segoe Script', cursive", fontSize: 18 }}
                      />
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>Typing your name here counts as your signature.</p>
                    </div>
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
                );
              })}
            </div>
            {!consultationQuestions.some(q => q.type === 'signature') && [...new Set(consultationForms.map(cf => cf.consent_text).filter(Boolean))].map((txt, ci) => (
              <p key={`consent-fb-${ci}`} style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5, padding: '10px 12px', background: 'var(--bg-subtle, #ede7e3)', borderRadius: 10, border: '1px solid var(--border-light)' }}>{txt}</p>
            ))}
            {showConsultationErrors && missingConsultation.length > 0 && (
              <p style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600, color: 'var(--danger, #9E2B32)', lineHeight: 1.5 }}>
                {missingConsultation.length === 1
                  ? 'One question still needs an answer.'
                  : `${missingConsultation.length} questions still need an answer.`}
              </p>
            )}
            <div style={styles.buttonRow}>
              <button onClick={() => setStep(2)} style={styles.backBtn}>← Back</button>
              <button
                onClick={() => {
                  // Caught here rather than at Confirm. Sending someone to the
                  // review screen and refusing there means walking them back
                  // through a form they thought they had finished.
                  if (missingConsultation.length > 0) {
                    setShowConsultationErrors(true);
                    const first = document.getElementById(`consultation-q-${missingConsultation[0].key}`);
                    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    return;
                  }
                  setStep(3);
                }}
                style={{ ...styles.primaryBtn, background: brand }}
              >
                Review booking
              </button>
            </div>
          </div>
        )}
        {/* Step 3: Confirm */}
        {step === 3 && (
          <div>
            <h2 style={styles.stepTitle}>Confirm your booking</h2>
            {/* Outstanding balance heads-up for a recognised returning client.
                A warm notice only, never a wall: the backend fails open (zero)
                on any error and booking always goes ahead. */}
            {recognisedClient?.found && (recognisedClient.outstandingBalanceCents || 0) > 0 && (
              <div style={{ padding: '12px 14px', borderRadius: 10, marginBottom: 14,
                background: `${brand}10`, border: `1px solid ${brand}30`,
                fontSize: 13, color: 'var(--text-primary, #241B17)', lineHeight: 1.55,
              }}>
                Looks like there is an outstanding balance of <Money pence={recognisedClient.outstandingBalanceCents} /> from a previous visit. This will need settling at your appointment.
              </div>
            )}
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
                      <span style={styles.summaryValue}><Money pence={t.price_cents} /></span>
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
                      <span style={styles.summaryValue}><Money pence={combinedTreatmentCents} /></span>
                    </div>
                  )}
                  {selectedAddOns.map(ao => (
                    <div key={ao.id} style={styles.summaryRow}>
                      <span style={styles.summaryLabel}>+ {ao.name}</span>
                      <span style={styles.summaryValue}><Money pence={ao.price_cents} /></span>
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
                      <span style={styles.summaryValue}><Money pence={item.lineTotal} /></span>
                    </div>
                  ))}
                </>
              )}
              {discountCents > 0 && (
                <div style={styles.summaryRow}>
                  <span style={{ ...styles.summaryLabel, color: 'var(--success, #3F7D5C)' }}>
                    Discount ({appliedDiscount.code})
                  </span>
                  <span style={{ ...styles.summaryValue, color: 'var(--success, #3F7D5C)' }}>
                    −<Money pence={discountCents} />
                  </span>
                </div>
              )}
              <div style={{ ...styles.summaryRow, borderBottom: 'none' }}>
                <span style={styles.summaryLabel}>Total</span>
                <span style={{ ...styles.summaryValue, color: brand, fontWeight: 700, fontSize: 18 }}>
                  <Money pence={(grandTotalCents + cartTotalCents)} />
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
                    <button className="fl-tap"
                      onClick={() => setPaymentType('deposit')}
                      style={{ flex: 1, padding: '10px 0', borderRadius: 10, fontSize: 13, fontWeight: 500,
                        cursor: 'pointer', fontFamily: 'inherit', border: 'none',
                        background: paymentType === 'deposit' ? brand : '#F0ECE8',
                        color: paymentType === 'deposit' ? '#fff' : 'var(--text-secondary)',
                      }}
                    >
                      Pay deposit (<Money pence={depositCents} />)
                    </button>
                    <button className="fl-tap"
                      onClick={() => setPaymentType('full')}
                      style={{ flex: 1, padding: '10px 0', borderRadius: 10, fontSize: 13, fontWeight: 500,
                        cursor: 'pointer', fontFamily: 'inherit', border: 'none',
                        background: paymentType === 'full' ? brand : '#F0ECE8',
                        color: paymentType === 'full' ? '#fff' : 'var(--text-secondary)',
                      }}
                    >
                      Pay in full (<Money pence={grandTotalCents} />)
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
                stripeActive && accepted.includes('card_online') && { key: 'card', label: 'Card online', icon: 'card' },
                accepted.includes('cash') && { key: 'cash', label: 'Cash on the day', icon: 'pound' },
                accepted.includes('bank_transfer') && { key: 'bank_transfer', label: 'Bank transfer', icon: 'wallet' },
              ].filter(Boolean);
              if (available.length <= 1) return null;
              return (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #241B17)', marginBottom: 8 }}>
                    How would you like to pay?
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {available.map(m => (
                      <button className="fl-tap"
                        key={m.key}
                        onClick={() => setPaymentMethod(m.key)}
                        style={{ flex: 1, minWidth: 100, padding: '10px 12px', borderRadius: 10,
                          fontSize: 13, fontWeight: 500, cursor: 'pointer',
                          fontFamily: 'inherit', border: 'none',
                          background: paymentMethod === m.key ? brand : '#F0ECE8',
                          color: paymentMethod === m.key ? '#fff' : 'var(--text-secondary)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        }}
                      >
                        <span><Icon name={iconName(m.icon)} inline /></span> {m.label}
                      </button>
                    ))}
                  </div>
                  {(paymentMethod === 'cash' || paymentMethod === 'bank_transfer') && (
                    <p style={{ fontSize: 12, color: 'var(--text-muted, #6B5D54)', margin: '8px 0 0' }}>
                      {paymentMethod === 'bank_transfer'
                        ? `A card deposit of £${(depositCents / 100).toFixed(2)} secures your booking now. You'll transfer the rest to your beautician's bank details, sent after booking.`
                        : `A card deposit of £${(depositCents / 100).toFixed(2)} secures your booking now. You'll pay the rest in cash at your appointment.`}
                    </p>
                  )}
                </div>
              );
            })()}
            {/* Membership badge */}
            {memberInfo && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12,
                padding: '8px 12px', borderRadius: 10, background: 'var(--gold-bg, #FFF8E1)',
                border: '1px solid var(--gold, #8A6420)', fontSize: 13, fontWeight: 500,
                color: 'var(--gold, #8A6420)',
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
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        width: '100%', padding: '12px 14px', borderRadius: 10, marginBottom: 6,
                        border: `1.5px solid ${isSelected ? 'var(--success, #3F7D5C)' : 'var(--border, #E8DDD4)'}`,
                        background: isSelected ? 'var(--success-bg, #E9F0EB)' : 'var(--bg-card)',
                        cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: isSelected ? 'var(--success, #3F7D5C)' : 'var(--text-primary)' }}>
                          {isSelected ? '✓ ' : ''}{pkg.package_name}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {pkg.sessions_remaining} of {pkg.sessions_total} sessions remaining
                        </span>
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--success, #3F7D5C)' }}>
                        Use session
                      </span>
                    </button>
                  );
                })}
                {selectedPackage && (
                  <p style={{ fontSize: 12, color: 'var(--success, #3F7D5C)', marginTop: 4 }}>
                    No payment needed, using a session from your {selectedPackage.package_name} package
                  </p>
                )}
              </div>
            )}
            {/* Discount code section (hidden when using a package session) */}
            {!selectedPackage && <div style={{ marginBottom: 16 }}>
              {appliedDiscount ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', borderRadius: 10, background: 'var(--success-bg, #E9F0EB)',
                  border: '1px solid var(--success, #3F7D5C)', fontSize: 13,
                }}>
                  <span style={{ color: 'var(--success, #3F7D5C)', fontWeight: 600 }}>
                    ✓ {appliedDiscount.code}, saving <Money pence={discountCents} />
                  </span>
                  <button className="fl-tap" onClick={removeDiscount} style={{ background: 'none', border: 'none', fontSize: 16, color: 'var(--text-muted)',
                    cursor: 'pointer', padding: '0 4px', fontFamily: 'inherit',
                  }}>×</button>
                </div>
              ) : (
                <>
                  <button className="fl-tap"
                    onClick={() => setDiscountOpen(!discountOpen)}
                    style={{ background: 'none', border: 'none', fontSize: 13, color: brand,
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
                        style={{ minHeight: 44, ...styles.input, flex: 1, padding: '10px 12px', fontSize: 14,
                          borderColor: discountError ? 'var(--danger, #9E2B32)' : 'var(--border, #E8DDD4)',
                        }}
                      />
                      <button className="fl-tap"
                        onClick={validateDiscountCode}
                        disabled={discountLoading || !discountInput.trim()}
                        style={{ ...styles.primaryBtn, background: brand, padding: '10px 16px',
                          fontSize: 13, opacity: discountLoading || !discountInput.trim() ? 0.6 : 1,
                        }}
                      >
                        {discountLoading ? '...' : 'Apply'}
                      </button>
                    </div>
                  )}
                  {discountError && (
                    <p style={{ fontSize: 12, color: 'var(--danger, #9E2B32)', marginTop: 4 }}>{discountError}</p>
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
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 20,
              padding: '12px 14px', borderRadius: 10, background: 'var(--bg-subtle, #ede7e3)',
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
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 20,
              padding: '12px 14px', borderRadius: 10, background: 'var(--bg-subtle, #ede7e3)',
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
            {(() => {
              // Late cancel and no-show are SEPARATE charges and must be stated
              // separately. Lumping them into one percentage told a client that
              // cancelling late costs the same as never turning up, which for a
              // salon that only keeps the deposit on a cancel is simply untrue,
              // and an inaccurate notice is exactly what loses a card dispute.
              const bp = beautician?.booking_policy || {};
              const notice = bp.cancellation_notice_hours || 48;
              const lateP = Math.min(Number(bp.late_cancel_charge_percent) || 0, 100);
              const noShowP = Math.min(Number(bp.no_show_charge_percent) || 0, 100);
              if (lateP <= 0 && noShowP <= 0) return null;
              return (
                <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55,
                  margin: '0 0 16px', padding: '10px 14px', borderRadius: 10,
                  background: 'var(--bg-subtle, #ede7e3)', border: '1px solid var(--border-light)',
                }}>
                  Cancellation policy: free to cancel or move your appointment up to {notice} hours before.
                  {lateP > 0
                    ? ` Cancelling later than that may mean a fee of up to ${lateP}% of the treatment price charged to your card.`
                    : ' Cancelling later than that means your deposit is not refunded.'}
                  {noShowP > 0 && ` If you do not turn up at all, the full ${noShowP}% of the treatment price may be charged to your card.`}
                  {' '}By booking you agree to this.
                </p>
              );
            })()}
            {beautician?.booking_policy?.cancellation_message && (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, fontStyle: 'italic', whiteSpace: 'pre-line',
                margin: '0 0 16px', padding: '10px 14px', borderRadius: 10,
                background: 'var(--bg-subtle, #ede7e3)', border: '1px solid var(--border-light)',
              }}>
                {beautician.booking_policy.cancellation_message}
              </p>
            )}
            {TURNSTILE_SITE_KEY ? <TurnstileWidget onToken={setTurnstileToken} /> : null}
            <div style={styles.buttonRow}>
              <button onClick={() => setStep(2)} style={styles.backBtn}>← Back</button>
              <button
                onClick={handleBook}
                disabled={submitting}
                style={{ ...styles.primaryBtn,
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
      <SalonInfo beautician={beautician} reviewsData={reviewsData} brand={brand} />
      <div style={styles.footer}>
        <span style={styles.footerText}>Powered by </span>
        <span style={{ ...styles.footerBrand, color: brand }}>florrie.ai</span>
      </div>
    </div>
  );
}
// Supporting info below the booking flow: where the salon is, when it opens,
// and what clients say. Each block hides itself when there is nothing to show,
// so prospective clients never see an empty state.
function SalonInfo({ beautician, reviewsData, brand }) {
  const DAYS = [
    ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'],
    ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
  ];
  const hours = beautician?.working_hours || null;
  const address = (beautician?.address || '').trim();
  const postcode = (beautician?.postcode || '').trim();
  const fullAddress = [address, postcode].filter(Boolean).join(', ');
  const hasHours = !!hours && DAYS.some(([k]) => hours[k]?.start && hours[k]?.end);
  const recent = reviewsData?.recent || [];
  const hasReviews = (reviewsData?.count || 0) > 0;
  if (!fullAddress && !hasHours && !hasReviews) return null;

  const todayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];
  const sectionCard = { background: 'var(--bg-card)', borderRadius: 16, padding: '20px 24px', boxShadow: 'var(--shadow-md)', marginTop: 16 };
  const heading = { fontSize: 16, fontWeight: 600, margin: '0 0 12px', color: 'var(--text-primary)', fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" };
  const stars = n => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));

  return (
    <>
      {fullAddress && (
        <div style={sectionCard}>
          <h3 style={heading}>Find us</h3>
          <p style={{ fontSize: 14, color: 'var(--text-primary)', margin: '0 0 10px', lineHeight: 1.5 }}>{fullAddress}</p>
          <a
            href={`https://maps.google.com/?q=${encodeURIComponent(fullAddress)}`}
            target="_blank"
            rel="noreferrer"
            style={{ display: 'inline-block', minHeight: 44, lineHeight: '44px', fontSize: 14, fontWeight: 600, color: brand, textDecoration: 'none' }}
          >
            Get directions →
          </a>
        </div>
      )}
      {hasHours && (
        <div style={sectionCard}>
          <h3 style={heading}>Opening hours</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {DAYS.map(([key, label]) => {
              const day = hours[key];
              const open = day?.start && day?.end;
              const isToday = key === todayKey;
              return (
                <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                  <span style={{ color: isToday ? brand : 'var(--text-secondary)', fontWeight: isToday ? 700 : 400 }}>{label}</span>
                  <span style={{ color: open ? (isToday ? brand : 'var(--text-primary)') : 'var(--text-muted)', fontWeight: isToday ? 700 : 500 }}>
                    {open ? `${day.start} - ${day.end}` : 'Closed'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {hasReviews && (
        <div style={sectionCard}>
          <h3 style={heading}>What clients say</h3>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: recent.length ? 14 : 0 }}>
            <span style={{ fontSize: 18, color: brand, letterSpacing: 2 }}>{stars(reviewsData.average)}</span>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{reviewsData.average}</span>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {reviewsData.count} review{reviewsData.count === 1 ? '' : 's'}
            </span>
          </div>
          {recent.map((r, i) => (
            <div key={i} style={{ padding: '10px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border-light)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{r.first_name || 'A client'}</span>
                <span style={{ fontSize: 13, color: brand }}>{stars(r.rating)}</span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{r.comment}</p>
            </div>
          ))}
        </div>
      )}
    </>
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
    minHeight: 'var(--shell-viewport)',
    background: 'var(--bg)',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)",
    padding: '0 16px 40px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
  },
  loadingContainer: {
    minHeight: 'var(--shell-viewport)',
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
  brandBand: { textAlign: 'center', padding: '36px 20px 28px', marginTop: 24, marginBottom: 20, borderRadius: 16 },
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
    padding: '16px 18px', borderRadius: 10, border: '1.5px solid var(--border)',
    cursor: 'pointer', transition: 'all 0.2s', textAlign: 'left',
    background: 'var(--bg-card)', width: '100%', fontFamily: 'inherit'
  },
  treatmentInfo: { display: 'flex', flexDirection: 'column', gap: 3 },
  treatmentName: { fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' },
  treatmentDesc: { fontSize: 13, color: 'var(--text-secondary)' },
  treatmentDuration: { fontSize: 12, color: 'var(--text-muted)' },
  treatmentPrice: {
    fontSize: 19,
    fontWeight: 700,
    fontFamily: '"Plus Jakarta Sans", -apple-system, sans-serif',
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '-0.01em',
    color: 'var(--text-primary)',
  },
  calWrap: { marginBottom: 22 },
  calHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 14, padding: '0 2px',
  },
  calNav: {
    width: 38, height: 38, borderRadius: '50%', border: 'none',
    background: 'transparent', fontSize: 26, lineHeight: 1, fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
  },
  calMonthLabel: {
    fontSize: 17, fontWeight: 600, color: 'var(--text-primary)',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  calWeekRow: {
    display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 6,
  },
  calWeekday: {
    textAlign: 'center', fontSize: 11, fontWeight: 600, letterSpacing: '0.03em',
    color: 'var(--text-muted)', textTransform: 'uppercase',
  },
  calGrid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 },
  calCell: {
    aspectRatio: '1 / 1', borderRadius: 10, fontFamily: 'inherit', fontSize: 15,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 3, padding: 0, transition: 'background 0.15s, color 0.15s',
  },
  calDot: { width: 5, height: 5, borderRadius: '50%', display: 'block' },
  calLoadingRow: { display: 'flex', justifyContent: 'center', padding: '10px 0 2px' },
  calSpinner: {
    width: 18, height: 18, borderRadius: '50%',
    border: '2px solid var(--border-light)', borderTopColor: 'currentColor',
    animation: 'spin 0.8s linear infinite',
  },
  calLegend: {
    display: 'flex', gap: 18, justifyContent: 'center', alignItems: 'center',
    marginTop: 14, fontSize: 12, color: 'var(--text-secondary)',
  },
  calLegendItem: { display: 'flex', alignItems: 'center', gap: 6 },
  calLegendDot: { width: 7, height: 7, borderRadius: '50%', display: 'block' },
  slotGrid: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  slotChip: {
    padding: '10px 16px', borderRadius: 10, border: '1.5px solid var(--border)',
    fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit'
  },
  noSlots: { color: 'var(--text-muted)', fontSize: 14, padding: '20px 0' },
  form: { display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 },
  input: {
    padding: '14px 16px', borderRadius: 10, border: '1.5px solid var(--border)',
    fontSize: 15, fontFamily: 'inherit', outline: 'none', color: 'var(--text-primary)', background: 'var(--bg-subtle, #ede7e3)'
  },
  summaryCard: {
    background: 'var(--bg-subtle, #ede7e3)', borderRadius: 10, padding: '4px 18px',
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
    padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500,
    marginTop: 8, marginBottom: 8, border: '1px solid', textAlign: 'center'
  },
  buttonRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  backBtn: {
    background: 'none', border: 'none', fontSize: 14, color: 'var(--text-secondary)',
    cursor: 'pointer', padding: '10px 0', fontFamily: 'inherit'
  },
  primaryBtn: {
    padding: '14px 28px', borderRadius: 10, border: 'none', color: '#fff',
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
  bankRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
    padding: '5px 0', borderBottom: '1px solid rgba(0,0,0,0.05)',
  },
  bankLabel: { fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 },
  bankValue: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'right' },
  bankValueMono: {
    fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', textAlign: 'right',
    fontFamily: "'SF Mono', 'Roboto Mono', Menlo, monospace", letterSpacing: '0.04em',
  },
  errorBanner: {
    background: 'var(--danger-bg)', border: '1px solid var(--danger)', borderRadius: 10,
    padding: '12px 16px', marginBottom: 16, fontSize: 14, color: 'var(--danger)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center'
  },
  errorClose: { background: 'none', border: 'none', fontSize: 18, color: 'var(--danger)', cursor: 'pointer' },
  inlineError: {
    background: 'var(--danger-bg)', border: '1px solid var(--danger)', borderRadius: 10,
    padding: '10px 12px', marginBottom: 12, fontSize: 13, color: 'var(--danger)'
  },
  fieldErrorText: { display: 'block', fontSize: 12, color: 'var(--danger)', marginTop: 4 },
  footer: { textAlign: 'center', paddingTop: 32, fontSize: 12 },
  footerText: { color: 'var(--text-muted)' },
  footerBrand: { fontWeight: 600 }
};
