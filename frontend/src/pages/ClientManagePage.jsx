import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';
import Icon, { iconName } from '../components/ui/Icon';
import Money from '../components/ui/Money';
import Button from '../components/ui/Button';
import { readableOnAll, onBrand, mixOver } from '../lib/brand-colour.js';

/** --accent-rose, darkened just enough to be legible on its own #FFF0F4 tint. */
const ROSE_INK = readableOnAll('#C76B8A', ['#FFF0F4']);

/**
 * ClientManagePage - public client self-service portal.
 * URL: /book/:slug/manage/:token
 *
 * Lets clients view, cancel, and check related requirements for their booking.
 * No login required - accessed via the management_token UUID from their confirmation.
 */

/**
 * One treatment in a picker.
 *
 * The swap list and the add list render the same row: name on the left, price
 * and length on the right. They were duplicated the moment the add list
 * existed, so they are one component. `prefix` is the only difference — adding
 * shows "+ £50" because it is money ON TOP, swapping shows "£50" because it is
 * money INSTEAD.
 */
function TreatmentOption({ treatment, onPick, busy, prefix = '' }) {
  return (
    <button className="fl-tap"
      onClick={() => onPick(treatment.id)}
      disabled={busy}
      style={{ width: '100%', textAlign: 'left', marginBottom: 6, padding: '10px 12px',
        borderRadius: 10, border: '1px solid #E8E4DF', background: 'var(--bg-card)',
        cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: '#2D1B1B' }}>{treatment.name}</span>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
        {prefix}<Money pence={(treatment.price_cents || 0)} /> · {treatment.duration_minutes}m
      </span>
    </button>
  );
}

export default function ClientManagePage() {
  const { slug, token } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelResult, setCancelResult] = useState(null);

  // Change treatment. The deposit deliberately does NOT move: whatever they
  // paid carries over, and the balance (price minus deposit) recomputes itself.
  const [showTreatments, setShowTreatments] = useState(false);
  const [treatmentList, setTreatmentList] = useState(null);
  const [treatmentSaving, setTreatmentSaving] = useState(false);
  const [treatmentError, setTreatmentError] = useState(null);
  const [treatmentResult, setTreatmentResult] = useState(null);
  async function openTreatments() {
    setShowTreatments(true);
    setTreatmentError(null);
    if (treatmentList) return;
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${token}/treatments`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not load treatments');
      setTreatmentList(d.treatments || []);
    } catch (err) {
      setTreatmentError(err.message);
      setTreatmentList([]);
    }
  }
  async function changeTreatment(treatmentId) {
    setTreatmentSaving(true);
    setTreatmentError(null);
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${token}/change-treatment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ treatment_id: treatmentId }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not change your treatment');
      setTreatmentResult(d.message);
      setShowTreatments(false);
      await load();
    } catch (err) {
      setTreatmentError(err.message);
    } finally {
      setTreatmentSaving(false);
    }
  }

  // Add a treatment, rather than swap one.
  //
  // Lucy Walker, 21 August: "so sorry I just realised I need to add lash lift
  // to this booking! Should have been lash lift + brow lamination, tint."
  // Ellie: "You should be able to add and adjust your booking. Did you receive
  // a link at all?" Lucy: "No I didn't :/"
  //
  // Two separate failures in that exchange. Lucy had no link, which was a
  // backend bug. And this page could not have done it anyway — it could only
  // trade her brow lamination FOR a lash lift, never have both, which is not
  // what anyone means by "add". So Ellie did it by hand, hit a rate limit
  // doing it, and ended up blocking out 30 minutes instead.
  //
  // Add only. Taking a treatment off would drop the price below a deposit
  // already paid; that stays with Ellie in the app.
  const [showAdd, setShowAdd] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState(null);
  async function openAdd() {
    setShowAdd(true);
    setAddError(null);
    if (treatmentList) return;
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${token}/treatments`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not load treatments');
      setTreatmentList(d.treatments || []);
    } catch (err) {
      setAddError(err.message);
      setTreatmentList([]);
    }
  }
  async function addTreatment(treatmentId) {
    setAddSaving(true);
    setAddError(null);
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${token}/add-treatment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ treatment_id: treatmentId }),
      });
      const d = await res.json();
      // Every refusal from this endpoint is written to be shown to a client as
      // it is — "there is not enough time after your appointment for X as
      // well" — so there is nothing to translate here.
      if (!res.ok) throw new Error(d.error || 'Could not add that treatment');
      setTreatmentResult(d.message);
      setShowAdd(false);
      await load();
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAddSaving(false);
    }
  }

  // Reschedule state.
  //
  // There is no free date/time input any more. It was the default path, and
  // every guess that missed came back as a rejection: "it keeps saying it's
  // not available but that's cause I'm guessing haha x". Both modes now show
  // real, pickable times, so there is nothing left for the client to type.
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const [rescheduleResult, setRescheduleResult] = useState(null);
  const [rescheduleError, setRescheduleError] = useState(null);
  // The times she can actually move to: back-to-back only when the salon
  // restricts moves to slots that butt against existing bookings, otherwise
  // general availability, the same times the public booking page would offer.
  const [rescheduleSlots, setRescheduleSlots] = useState(null);
  const [loadingReschedSlots, setLoadingReschedSlots] = useState(false);
  const [reschedSlotsError, setReschedSlotsError] = useState(null);
  const [reschedHorizonDays, setReschedHorizonDays] = useState(28);

  // Resend payment state
  const [resendingPayment, setResendingPayment] = useState(false);
  const [paymentResent, setPaymentResent] = useState(false);

  // Patch test booking state
  const [patchTestSlots, setPatchTestSlots] = useState(null);
  const [patchTestDuration, setPatchTestDuration] = useState(10);
  const [patchTestBooked, setPatchTestBooked] = useState(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotsError, setSlotsError] = useState(null);
  const [confirmingSlot, setConfirmingSlot] = useState(false);
  const [showSlotPicker, setShowSlotPicker] = useState(false);

  const brand = data?.appointment?.beautician?.brandColor || '#C76B8A';
  const brandLight = brand + '15';
  // A brand colour a salon picked is not a text colour. Ellindigo's #c76b8a
  // measures 3.48:1 on the card and 3.22:1 on its own tint, so the balance
  // owed, the reschedule link and the footer were all under AA on the page her
  // clients land on after paying. Nothing had ever looked: the page needs a
  // management token, so the visual sweep could not reach it.
  //
  // Same treatment as the booking page — keep the hue, move the lightness only
  // as far as it has to go, and grade against every ground it sits on
  // including the flattened tint.
  const brandTint = mixOver(brand, '#FFFCF9', 0x15 / 255);
  const brandInk = readableOnAll(brand, ['#FFFCF9', '#FBF6F1', brandTint]);
  const onBrandColour = onBrand(brand);

  useEffect(() => {
    load();
  }, [slug, token]);

  // Deep link from the booking confirmation ("Book my patch test") opens the
  // slot picker straight away and scrolls to it, so it's one tap not three.
  const deepLinkedPatch = useRef(false);
  useEffect(() => {
    if (deepLinkedPatch.current || !data) return;
    const wantsPatch = new URLSearchParams(window.location.search).get('book') === 'patch';
    // Not gated on needsPatchTest any more. That flag is now narrow on
    // purpose, and the link in the confirmation text has already told her to
    // come here and book one; landing on a page with no picker on it would be
    // the same dead end from the other direction.
    if (wantsPatch && (data.needsPatchTest || data.patchTest?.required)) {
      deepLinkedPatch.current = true;
      loadPatchTestSlots();
      setTimeout(() => {
        document.getElementById('patch-test-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 350);
    }
  }, [data]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${token}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Booking not found');
      }
      setData(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCancel() {
    setCancelling(true);
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${token}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Cancellation failed');
      setCancelResult(result);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCancelling(false);
      setCancelConfirm(false);
    }
  }

  function openReschedule() {
    setShowReschedule(true);
    setRescheduleError(null);
    // Always fetch. Both modes are a list of real times now, so there is never
    // a state where opening the card means "start typing and hope".
    loadRescheduleSlots();
  }

  function closeReschedule() {
    setShowReschedule(false);
    setRescheduleError(null);
    setReschedSlotsError(null);
  }

  async function loadRescheduleSlots() {
    setLoadingReschedSlots(true);
    setReschedSlotsError(null);
    // Clear first: a stale list under a spinner invites a tap on a slot that
    // may already have gone.
    setRescheduleSlots(null);
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${token}/reschedule/slots`);
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not load available times');
      setRescheduleSlots(result.slots || []);
      if (result.horizonDays) setReschedHorizonDays(result.horizonDays);
    } catch (err) {
      setReschedSlotsError(err.message);
    } finally {
      setLoadingReschedSlots(false);
    }
  }

  async function handleReschedule(newStartsAt) {
    // Always an offered slot now: a zone-free wall string, exactly as the
    // endpoint handed it over. Guard against an event object sneaking in from
    // an onClick that forgot its arrow.
    const new_starts_at = (typeof newStartsAt === 'string' && newStartsAt) ? newStartsAt : null;
    if (!new_starts_at) return;
    setRescheduling(true);
    setRescheduleError(null);
    try {
      // Wall-clock convention: appointments are stored as the salon's local time.
      // Send the string raw (same as the booking page); toISOString() would shift it.
      const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${token}/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_starts_at }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Reschedule failed');
      setRescheduleResult(result);
      setShowReschedule(false);
      await load();
    } catch (err) {
      setRescheduleError(err.message);
      // Somebody else took it between the list loading and the tap. Refetch so
      // the times on screen are current; without this the same dead slot stays
      // tappable and the client is back to guessing.
      loadRescheduleSlots().catch(() => {});
    } finally {
      setRescheduling(false);
    }
  }

  async function handleResendPayment() {
    setResendingPayment(true);
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${token}/resend-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) setPaymentResent(true);
    } catch {
      // non-fatal
    } finally {
      setResendingPayment(false);
    }
  }

  async function loadPatchTestSlots() {
    setLoadingSlots(true);
    setSlotsError(null);
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${token}/patch-test/slots`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to load slots');
      }
      const result = await res.json();
      setPatchTestSlots(result.slots);
      if (result.duration_minutes) setPatchTestDuration(result.duration_minutes);
      setShowSlotPicker(true);
    } catch (err) {
      setSlotsError(err.message);
    } finally {
      setLoadingSlots(false);
    }
  }

  async function confirmPatchTestSlot(slot) {
    setConfirmingSlot(true);
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${token}/patch-test/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Confirmation failed');
      }
      setPatchTestBooked(slot);
      await load();
      setShowSlotPicker(false);
      setPatchTestSlots(null);
    } catch (err) {
      setSlotsError(err.message || 'That time just went. Pick another one.');
      // Refetch so the list she picks from is current. Without this the stale
      // list stays up and the same dead slot can be tapped again and again.
      loadPatchTestSlots().catch(() => {});
    } finally {
      setConfirmingSlot(false);
    }
  }

  if (loading) return (
    <div style={S.page}>
      <div style={S.loadingWrap}>
        <div style={S.spinner} />
        <p style={S.loadingText}>Loading your booking…</p>
      </div>
    </div>
  );

  if (error) return (
    <div style={S.page}>
      <div style={S.card}>
        <div style={{ fontSize: 40, textAlign: 'center', marginBottom: 12 }}><Icon name="search" size={40} /></div>
        <h2 style={S.cardTitle}>Booking not found</h2>
        <p style={S.cardBody}>
          {error === 'Booking not found'
            ? "We couldn't find this booking. The link may have expired or been used already."
            : error}
        </p>
      </div>
    </div>
  );

  const { appointment, policy, patchTests, needsPatchTest, pendingForms, payment } = data;
  /* What the salon actually knows about her patch test, and how sure it is.
   *
   * On 26 August Sophie moved her appointment with this page and was then
   * told, flatly, that she needed a patch test. She booked one. Ellie had to
   * message her to say she did not need it and cancel it by hand. Sophie had
   * been to her before: the demand was not a fact, it was a gap in our own
   * records read out loud as though it were one.
   *
   * needsPatchTest now means only "we know she has never been in", which is
   * the one case where the sentence is true and the one case where she can do
   * anything about it herself. Everything softer arrives here instead, and
   * says so in the client's own terms. `certainty` is one of:
   *   not_required | satisfied | booked | never_visited | uncertain
   *   | adverse | unknown
   */
  const patchTest = data.patchTest || { required: false, certainty: 'not_required', ask: null };
  // She has not been ruled out, but nothing on file rules her in either. The
  // page does not assert anything: the salon is asked, on her Patch Tests
  // page, and the client is told the truth, which is that it is being checked.
  const patchTestUnsure = ['uncertain', 'unknown'].includes(patchTest.certainty);
  const patchTestReaction = patchTest.certainty === 'adverse';
  const apptDate = new Date(appointment.startsAt);
  const isCancelled = appointment.status === 'cancelled';
  const isCompleted = appointment.status === 'completed';
  const isPast = apptDate < new Date() && !isCancelled;
  // A client who knows perfectly well she needs one can still book it, from
  // any of these states. What changes is whether we DEMAND it of her.
  const canOfferPatchTest = patchTest.required &&
    (needsPatchTest || patchTestUnsure) && !isCancelled && !isPast;
  // Everything already on this booking, so the add picker never offers
  // something they have got. The backend refuses a duplicate anyway; this is
  // so they never see the option and wonder why it failed.
  const bookedIds = new Set(
    [appointment.treatment?.id, ...(appointment.treatments || []).map(t => t?.id)].filter(Boolean),
  );

  // The chip paints itself on a 12.5% tint of itself, which is exactly the
  // pairing check-swatches exists to catch: #5ba67f on #ebf1ea is 2.54:1, so
  // the word "confirmed" — the one thing on this page a client scans for —
  // was the least readable thing on it. Darkened against its own flattened
  // tint, not against white.
  const rawStatusColour = {
    confirmed: '#5BA67F', pending: 'var(--warning)', cancelled: 'var(--danger)',
    completed: '#8A8580', no_show: 'var(--danger)',
  }[appointment.status] || '#8A8580';
  const statusTint = mixOver(rawStatusColour, '#FFFCF9', 0x20 / 255);
  const statusColour = readableOnAll(rawStatusColour, [statusTint]);

  const patchTestPickerCopy = {
    title: `Pick a day and time for your ${patchTestDuration}-min patch test`,
    emptyMessage: 'No patch test times are free before your appointment. Message me and we will sort one out.',
    confirmLabel: 'Confirm my patch test',
    confirmingLabel: 'Booking your patch test...',
  };

  // A way through when the diary has nothing in it. "Nothing available" and a
  // Back button is how a rebooking is lost, so if we hold her number the
  // client gets a tap-to-call; if we do not, she is at least told to reply to
  // the confirmation rather than left staring at a dead end.
  const salonPhone = (appointment.beautician?.phone || '').trim();
  const salonName = appointment.beautician.name;
  const reachTheSalon = salonPhone ? (
    <a
      href={`tel:${salonPhone.replace(/[^\d+]/g, '')}`}
      style={{
        display: 'block', textAlign: 'center', padding: '13px 12px', borderRadius: 10,
        border: `1.5px solid ${brand}`, background: brandLight, color: brandInk,
        fontSize: 14, fontWeight: 700, textDecoration: 'none', marginBottom: 10,
      }}
    >
      Call {salonName} on {salonPhone}
    </a>
  ) : (
    <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>
      Reply to your confirmation message and {salonName} will find you a time.
    </p>
  );

  const reschedulePickerCopy = {
    // The card already says "Pick a new time" above it; the picker does not
    // need to say it twice.
    title: null,
    emptyMessage: `There is nothing free in the next ${reschedHorizonDays} days for a ${appointment.totalDurationMinutes || appointment.treatment?.duration_minutes || 0}-minute appointment. ${salonName} can often fit something in that the diary will not show, so please get in touch.`,
    emptyExtra: reachTheSalon,
    confirmLabel: 'Confirm my new time',
    confirmingLabel: 'Moving your booking...',
    frameless: true,
  };

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={{ ...S.header, borderBottom: `3px solid ${brand}` }}>
        <div style={S.headerInner}>
          <h1 style={{ ...S.businessName, color: brandInk }}>
            {appointment.beautician.name}
          </h1>
          <p style={S.headerSub}>Your booking</p>
        </div>
      </div>

      <div style={S.content}>
        {/* THE UNCERTAIN CASE, WHICH IS NOT A DEMAND.
            Nothing on file either way, and she has been here before. The app
            does not know, so it does not say it does. Ellie is asked instead,
            on her Patch Tests page, because she was the one in the room and
            she can settle it in a tap. Sophie got the flat version of this and
            booked a slot she did not need. */}
        {patchTestUnsure && !needsPatchTest && !patchTestBooked && !isCancelled && !isPast && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start',
            padding: '14px 16px', borderRadius: 16, marginBottom: 16,
            background: 'var(--bg-card, #FFFCF9)', border: '1px solid var(--border, #E8DDD4)',
          }}>
            <span style={{ fontSize: 20, lineHeight: 1.1 }}><Icon name="syringe" size={15} /></span>
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 700, marginBottom: 3 }}>
                Patch test
              </span>
              <span style={{ display: 'block', fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary, #574A42)' }}>
                This treatment needs one within the last {patchTest.expiryMonths || 6} months.
                I have not got yours written down, which does not mean you have not had it.
                I will check my notes and message you if you need another one.
              </span>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => {
                  if (!showSlotPicker) loadPatchTestSlots();
                  document.getElementById('patch-test-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                style={{ marginTop: 6, marginLeft: -8, color: brandInk }}
              >
                Book one anyway
              </Button>
            </span>
          </div>
        )}

        {/* A reaction is on record. That is not an absence and it is not
            something to hand her a booking button for. */}
        {patchTestReaction && !isCancelled && !isPast && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start',
            padding: '14px 16px', borderRadius: 16, marginBottom: 16,
            background: 'var(--bg-card, #FFFCF9)', border: '1px solid var(--border, #E8DDD4)',
          }}>
            <span style={{ fontSize: 20, lineHeight: 1.1 }}><Icon name="syringe" size={15} /></span>
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 700, marginBottom: 3 }}>
                Let us have a chat before this one
              </span>
              <span style={{ display: 'block', fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary, #574A42)' }}>
                There is a note on your last patch test. Give me a message and we will sort out
                what is best for you before your appointment.
              </span>
            </span>
          </div>
        )}

        {/* The one thing they MUST do, and only when it is true of her: we
            have no record of her ever having been in. It sat far below the
            fold in a section called "Patch tests", so it read as small print
            and got ignored. */}
        {needsPatchTest && !patchTestBooked && !isCancelled && !isPast && (
          <button
            type="button"
            onClick={() => {
              if (!showSlotPicker) loadPatchTestSlots();
              document.getElementById('patch-test-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            style={{ width: '100%', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
              display: 'flex', gap: 12, alignItems: 'flex-start',
              padding: '14px 16px', borderRadius: 16, marginBottom: 16,
              background: brandLight, border: `1.5px solid ${brand}`,
            }}
          >
            <span style={{ fontSize: 20, lineHeight: 1.1 }}><Icon name="syringe" size={15} /></span>
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: brandInk, marginBottom: 3 }}>
                Book your patch test
              </span>
              <span style={{ display: 'block', fontSize: 13, lineHeight: 1.5, color: '#2D1B1B' }}>
                You need one before this appointment, at least 24 hours before, or it cannot go ahead.
                It only takes {patchTestDuration} minutes. Tap to pick a time.
              </span>
            </span>
            <span style={{ fontSize: 18, color: brandInk, alignSelf: 'center' }}>{'\u203A'}</span>
          </button>
        )}

        {/* Add to calendar, above everything except the patch-test warning.
            This page is where the confirmation text and WhatsApp message land,
            and until now the only record a client had of her booking was that
            message — which is why one messaged Ellie the evening before hers
            asking "I have an appointment with you tomorrow at 6pm correct? I
            can't seem to find all my bookings on the florrie app."

            The .ics carries its own reminders, so the next one does not have
            to find anything. */}
        {!isCancelled && !isPast && (
          <a
            href={`${API_BASE}/api/booking/${slug}/manage/${token}/calendar.ics`}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              width: '100%', boxSizing: 'border-box', minHeight: 48, padding: '13px 16px',
              borderRadius: 14, marginBottom: 16, textDecoration: 'none',
              background: brand, color: onBrandColour, fontSize: 15, fontWeight: 700 }}
          >
            <Icon name="calendar" size={16} inline />
            Add to my calendar
          </a>
        )}

        {/* Cancellation result banner */}
        {cancelResult && (
          <div style={{ padding: '12px 16px', borderRadius: 10, marginBottom: 16,
            background: cancelResult.isLateCancel ? 'var(--warning-bg)' : 'var(--success-bg)',
            border: `1px solid ${cancelResult.isLateCancel ? '#F59E0B' : '#86EFAC'}`,
            fontSize: 14, color: cancelResult.isLateCancel ? 'var(--warning-text)' : 'var(--success-text)',
          }}>
            {cancelResult.message}
          </div>
        )}

        {/* Reschedule result banner */}
        {rescheduleResult && (
          <div style={{ padding: '12px 16px', borderRadius: 10, marginBottom: 16,
            background: rescheduleResult.isLateReschedule ? 'var(--warning-bg)' : 'var(--success-bg)',
            border: `1px solid ${rescheduleResult.isLateReschedule ? '#F59E0B' : '#86EFAC'}`,
            fontSize: 14, color: rescheduleResult.isLateReschedule ? 'var(--warning-text)' : 'var(--success-text)',
            lineHeight: 1.5,
          }}>
            ✓ {rescheduleResult.message}
          </div>
        )}

        {/* Pending payment banner */}
        {appointment.status === 'pending' && !appointment.depositPaid && (
          <div style={{ padding: '12px 16px', borderRadius: 10, marginBottom: 4,
            background: 'var(--warning-bg)', border: '1px solid #F59E0B',
            fontSize: 13, color: 'var(--warning-text)',
          }}>
            <strong>Payment required</strong> - your slot is held but not confirmed until payment is received.
            {' '}
            {paymentResent ? (
              <span style={{ color: 'var(--success-text)', fontWeight: 600 }}><Icon name="check" size={14} inline /> Payment link sent to your email.</span>
            ) : (
              <button className="fl-tap"
                onClick={handleResendPayment}
                disabled={resendingPayment}
                style={{ background: 'none', border: 'none', color: 'var(--warning-text)', fontWeight: 700, fontSize: 13, cursor: 'pointer', textDecoration: 'underline', padding: 0, fontFamily: 'inherit' }}
              >
                {resendingPayment ? 'Sending…' : 'Resend payment link →'}
              </button>
            )}
          </div>
        )}

        {/* Booking card */}
        <div style={S.card}>
          <div style={S.bookingStatus}>
            <span style={{ ...S.statusChip, background: rawStatusColour + '20', color: statusColour }}>
              {appointment.status.replace(/_/g, ' ')}
            </span>
          </div>

          {/* Everything she booked. Sasha booked brows and a Korean lash lift
              and this line said "Signature brows" while charging her for both,
              so she messaged Ellie to check the time was right. A confirmation
              that leaves half the booking off is worse than no confirmation. */}
          <h2 style={S.treatmentName}>
            {(appointment.treatments?.length ? appointment.treatments : [appointment.treatment])
              .filter(Boolean).map(t => t.name).join(' + ')}
          </h2>

          <div style={S.metaGrid}>
            <MetaRow icon="calendar_today" label="Date"
              value={apptDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} />
            <MetaRow icon="schedule" label="Time"
              value={apptDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} />
            <MetaRow icon="timer" label="Duration"
              value={`${appointment.totalDurationMinutes || appointment.treatment?.duration_minutes || 0} min`} />
            <MetaRow icon="payments" label="Price"
              value={`£${((appointment.totalPriceCents || appointment.treatment?.price_cents || 0) / 100).toFixed(2)}`} />
          </div>

          {/* Change treatment. Ellie's case: booked a full lamination weeks
              ago, only needs the maintenance now. The deposit stays put. */}
          {!isCancelled && !isCompleted && !isPast && (
            <div style={{ marginTop: 14 }}>
              {treatmentResult && (
                <p style={{ fontSize: 13, lineHeight: 1.5, color: brandInk, background: brandLight, border: `1px solid ${brand}55`, borderRadius: 10, padding: '10px 12px', margin: '0 0 10px' }}>
                  {treatmentResult}
                </p>
              )}
              {/* ADD comes first, because adding is what people message
                  about. Lucy did; so did the two before her. */}
              {!showAdd && !showTreatments && (
                <Button variant="secondary" onClick={openAdd} style={{ ...S.keepBtn, width: '100%', marginBottom: 8 }}>
                  Add another treatment
                </Button>
              )}
              {showAdd && (
                <div style={{ border: `1px solid ${brand}33`, borderRadius: 10, padding: 12, background: brandLight, marginBottom: 8 }}>
                  <p style={{ fontSize: 13, fontWeight: 700, color: '#2D1B1B', margin: '0 0 4px' }}>
                    Add to this appointment
                  </p>
                  <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
                    Your appointment gets longer and you pay the extra on the day. Your deposit stays exactly as it is.
                  </p>
                  {treatmentList === null && (
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>Loading…</p>
                  )}
                  {(treatmentList || []).filter(t => !bookedIds.has(t.id)).length === 0 && treatmentList !== null && (
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
                      Nothing else to add here. Message me and I'll sort it.
                    </p>
                  )}
                  {(treatmentList || []).filter(t => !bookedIds.has(t.id)).map(t => (
                    <TreatmentOption key={t.id} treatment={t} onPick={addTreatment} busy={addSaving} prefix="+ " />
                  ))}
                  {addError && (
                    <p style={{ fontSize: 13, color: 'var(--danger)', margin: '8px 0 0', lineHeight: 1.45 }}>{addError}</p>
                  )}
                  <Button variant="secondary" onClick={() => { setShowAdd(false); setAddError(null); }} disabled={addSaving}
                    style={{ ...S.keepBtn, width: '100%', marginTop: 6 }}>
                    Not now
                  </Button>
                </div>
              )}
              {!showTreatments ? (
                !showAdd && (
                  <button onClick={openTreatments} style={{ ...S.keepBtn, width: '100%' }}>
                    Change my treatment
                  </button>
                )
              ) : (
                <div style={{ border: `1px solid ${brand}33`, borderRadius: 10, padding: 12, background: brandLight }}>
                  <p style={{ fontSize: 13, fontWeight: 700, color: '#2D1B1B', margin: '0 0 4px' }}>
                    Pick a different treatment
                  </p>
                  <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
                    Your deposit stays exactly as it is. You'll just pay the difference on the day.
                  </p>
                  {treatmentList === null && (
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>Loading…</p>
                  )}
                  {treatmentList?.length === 0 && (
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
                      No other treatments available to swap to. Message me and I'll sort it.
                    </p>
                  )}
                  {(treatmentList || []).filter(t => t.id !== appointment.treatment?.id).map(t => (
                    <TreatmentOption key={t.id} treatment={t} onPick={changeTreatment} busy={treatmentSaving} />
                  ))}
                  {treatmentError && (
                    <p style={{ fontSize: 13, color: 'var(--danger)', margin: '8px 0 0', lineHeight: 1.45 }}>{treatmentError}</p>
                  )}
                  <button onClick={() => { setShowTreatments(false); setTreatmentError(null); }} disabled={treatmentSaving}
                    style={{ ...S.keepBtn, width: '100%', marginTop: 6 }}>
                    Keep {appointment.treatment?.name}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Client info */}
          <div style={S.clientSection}>
            <p style={S.sectionLabel}>Your details</p>
            <p style={S.clientName}>{appointment.client.name}</p>
            {appointment.client.email && <p style={S.clientMeta}>{appointment.client.email}</p>}
            {appointment.client.phone && <p style={S.clientMeta}>{appointment.client.phone}</p>}
          </div>
        </div>

        {/* Payment summary. States exactly what was paid and what remains,
            because clients kept assuming the deposit was the full amount (or
            the other way round). Figures come from the logged charge on the
            backend, so they match the card statement. */}
        {!isCancelled && payment && (payment.depositPaidCents > 0 || payment.paidInFull) && (
          <div style={{ ...S.policyCard, borderLeft: `3px solid ${brand}` }}>
            <p style={S.sectionLabel}>Payment</p>
            {/* One plain subtraction, same server figures the beautician sees
                on her sheet: total, minus what was paid, equals what is left.
                Clients kept assuming the deposit WAS the full amount (or the
                other way round); a visible sum leaves no room for that. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 14, color: '#2D1B1B' }}>
              <span>Total</span>
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}><Money pence={(payment.priceCents || 0)} /></span>
            </div>
            {payment.depositPaidCents > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 14, color: 'var(--text-muted, #6B5D54)' }}>
                <span>{payment.paidInFull ? 'Paid at booking' : 'Deposit paid'}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{'\u2212'}<Money pence={payment.depositPaidCents} /></span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', marginTop: 4, borderTop: '1px solid rgba(0,0,0,0.08)', fontSize: 15 }}>
              {payment.paidInFull || payment.remainingCents === 0 ? (
                <span style={{ fontWeight: 700, color: brandInk }}>Paid in full</span>
              ) : (
                <>
                  <span style={{ fontWeight: 700, color: brandInk }}>Outstanding</span>
                  <span style={{ fontWeight: 700, color: brandInk, fontVariantNumeric: 'tabular-nums' }}><Money pence={payment.remainingCents} /></span>
                </>
              )}
            </div>
            {(payment.paidInFull || payment.remainingCents === 0) && !isCompleted && (
              <p style={{ ...S.policyText, color: 'var(--text-muted)', marginTop: 6 }}>
                Nothing more to pay on the day.
              </p>
            )}
          </div>
        )}

        {/* Balance to pay, after the deposit. Shown when there's a remaining
            amount and the booking is still live. */}
        {!isCancelled && !isCompleted && payment?.remainingCents > 0 && (
          <div style={{ ...S.policyCard, borderLeft: `3px solid ${brand}` }}>
            <p style={S.sectionLabel}>Balance to pay</p>
            <p style={S.policyText}>
              <strong style={{ fontSize: 16, color: '#2D1B1B' }}><Money pence={payment.remainingCents} /></strong> {payment.depositPaidCents > 0 ? 'remaining after your deposit.' : 'to pay.'}
            </p>
            {payment.bankDetails?.account_number ? (
              <div style={{ marginTop: 12, padding: '14px', borderRadius: 10, background: brandLight, border: `1px solid ${brand}22` }}>
                <p style={{ ...S.policyText, fontWeight: 600, color: '#2D1B1B', margin: '0 0 8px' }}>Pay by bank transfer:</p>
                {payment.bankDetails.account_name && (
                  <div style={S.bankRow}>
                    <span style={S.bankLabel}>Account name</span>
                    <span style={S.bankValue}>{payment.bankDetails.account_name}</span>
                  </div>
                )}
                {payment.bankDetails.sort_code && (
                  <div style={S.bankRow}>
                    <span style={S.bankLabel}>Sort code</span>
                    <span style={S.bankValueMono}>{payment.bankDetails.sort_code}</span>
                  </div>
                )}
                <div style={S.bankRow}>
                  <span style={S.bankLabel}>Account number</span>
                  <span style={S.bankValueMono}>{payment.bankDetails.account_number}</span>
                </div>
                <div style={S.bankRow}>
                  <span style={S.bankLabel}>Reference</span>
                  <span style={S.bankValue}>
                    {payment.bankDetails.reference_note || (appointment.client.name || '').split(' ')[0]}
                  </span>
                </div>
              </div>
            ) : (
              <p style={{ ...S.policyText, color: 'var(--text-muted)', marginTop: 8 }}>
                Your beautician will share payment details.
              </p>
            )}
          </div>
        )}

        {/* Cancellation policy info */}
        {!isCancelled && !isCompleted && (
          <div style={S.policyCard}>
            <p style={S.sectionLabel}>Cancellation policy</p>
            {policy.cancellation_notice_hours > 0 ? (
              <>
                <p style={S.policyText}>
                  Free cancellation up to <strong>{policy.cancellation_notice_hours} hours</strong> before your appointment.
                </p>
                {policy.late_cancel_charge_percent > 0 && (
                  <p style={S.policyText}>
                    Cancellations within {policy.cancellation_notice_hours} hours may incur a charge of{' '}
                    <strong>{policy.late_cancel_charge_percent}%</strong> of the treatment price.
                  </p>
                )}
                {policy.no_show_charge_percent > 0 && (
                  <p style={S.policyText}>
                    If you do not turn up, <strong>{policy.no_show_charge_percent}%</strong> of the
                    treatment price may be charged to your card.
                  </p>
                )}
                {policy.withinCancellationWindow && (
                  <div style={S.warningBanner}><Icon name="alert-triangle" size={14} inline /> You are within the {policy.cancellation_notice_hours}-hour notice period.
                    A fee may apply if you cancel now.
                  </div>
                )}
              </>
            ) : (
              <p style={S.policyText}>Free cancellation at any time before your appointment.</p>
            )}
            <p style={{ ...S.policyText, color: 'var(--text-muted)', marginTop: 8 }}>
              {policy.hoursUntil > 0
                ? `Your appointment is in ${policy.hoursUntil} hour${policy.hoursUntil !== 1 ? 's' : ''}.`
                : 'Your appointment is very soon.'}
            </p>
            {policy.cancellation_message && (
              <p style={{ ...S.policyText, fontStyle: 'italic', marginTop: 8, whiteSpace: 'pre-line' }}>
                {policy.cancellation_message}
              </p>
            )}
          </div>
        )}

        {/* Patch tests section - shown when the treatment requires one and we
            are either asking or offering, OR there are records to show. */}
        {(canOfferPatchTest || (patchTests && patchTests.length > 0)) && (
          <div id="patch-test-section" style={S.card}>
            <p style={S.sectionLabel}>Patch tests</p>

            {patchTestBooked && (
              <div style={{ background: brandLight, border: `1.5px solid ${brand}`, borderRadius: 10,
                padding: '12px 14px', marginBottom: 12,
              }}>
                <p style={{ margin: '0 0 2px', fontSize: 14, fontWeight: 700, color: brandInk }}>
                  Patch test booked
                </p>
                <p style={{ margin: 0, fontSize: 13, color: '#2D1B1B' }}>
                  {new Date(`${patchTestBooked.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })} at {patchTestBooked.slice(11, 16)}. It takes about {patchTestDuration} minutes. See you then.
                </p>
              </div>
            )}

            {/* No patch test on record and the treatment needs one. The
                heading and the sentence under it both change with how sure we
                actually are: "required" is a claim, and it is only made of a
                client we know has never been in. */}
            {canOfferPatchTest && (
              <div style={S.patchTestBooking}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 20 }}><Icon name="syringe" size={15} /></span>
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: '0 0 2px', fontSize: 14, fontWeight: 600, color: '#2D1B1B' }}>
                      {needsPatchTest ? 'Patch test required' : 'Book a patch test'}
                    </p>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
                      {needsPatchTest
                        ? `Before your ${appointment.treatment?.name} on ${apptDate.toLocaleDateString('en-GB', { timeZone: 'UTC' })} - must be done at least 24 hours before`
                        : `If you would rather not wait for me to check, pick a time before your ${appointment.treatment?.name} on ${apptDate.toLocaleDateString('en-GB', { timeZone: 'UTC' })}.`}
                    </p>
                  </div>
                </div>
                {!showSlotPicker ? (
                  <>
                    <button
                      onClick={loadPatchTestSlots}
                      disabled={loadingSlots}
                      style={{ ...S.confirmSlotBtn, background: brand, color: onBrandColour, width: '100%' }}
                    >
                      {loadingSlots ? 'Loading slots…' : 'Book your patch test'}
                    </button>
                    {slotsError && <p style={{ fontSize: 13, color: 'var(--danger)', marginTop: 8 }}>{slotsError}</p>}
                  </>
                ) : (
                  <SlotPicker
                    slots={patchTestSlots}
                    {...patchTestPickerCopy}
                    onPick={confirmPatchTestSlot}
                    confirming={confirmingSlot}
                    error={slotsError}
                    onBack={() => { setShowSlotPicker(false); setSlotsError(null); }}
                    brand={brand}
                    brandLight={brandLight}
                  />
                )}
              </div>
            )}

            {patchTests && patchTests.map(pt => {
              // Check if this patch test needs auto-booking (pending, not confirmed).
              // A row Ellie recorded herself is neither pending nor bookable:
              // it already happened, in her chair, and asking the client to
              // book it is the whole bug this page is being fixed for.
              const recordedByOwner = pt.status === 'recorded_by_owner';
              const needsBooking = pt.status === 'pending' && !pt.confirmed_at && !recordedByOwner;
              const isSuggested = pt.suggested_slot && !pt.confirmed_at;

              if (needsBooking) {
                return (
                  <div key={pt.id}>
                    {!showSlotPicker ? (
                      <div style={S.patchTestBooking}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                          <span style={{ fontSize: 20 }}><Icon name="syringe" size={15} /></span>
                          <div style={{ flex: 1 }}>
                            <p style={{ margin: '0 0 2px', fontSize: 14, fontWeight: 600, color: '#2D1B1B' }}>
                              Patch test required
                            </p>
                            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
                              Before your {appointment.treatment?.name} on {apptDate.toLocaleDateString('en-GB', { timeZone: 'UTC' })}
                            </p>
                          </div>
                        </div>

                        {isSuggested ? (
                          <>
                            <p style={{ margin: '0 0 12px', fontSize: 13, color: '#555', lineHeight: 1.5 }}>
                              We've pencilled in <strong>{new Date(pt.suggested_slot).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} at {new Date(pt.suggested_slot).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}</strong> - does this work?
                            </p>
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button
                                onClick={() => confirmPatchTestSlot(pt.suggested_slot)}
                                disabled={confirmingSlot}
                                style={{ ...S.confirmSlotBtn, background: brand, color: onBrandColour, flex: 1 }}
                              >
                                {confirmingSlot ? 'Confirming…' : 'Confirm'}
                              </button>
                              <button
                                onClick={loadPatchTestSlots}
                                disabled={loadingSlots}
                                style={{ ...S.altSlotBtn, flex: 1 }}
                              >
                                {loadingSlots ? 'Loading…' : 'Pick different time'}
                              </button>
                            </div>
                          </>
                        ) : (
                          <button
                            onClick={loadPatchTestSlots}
                            disabled={loadingSlots}
                            style={{ ...S.confirmSlotBtn, background: brand, color: onBrandColour, width: '100%' }}
                          >
                            {loadingSlots ? 'Loading slots…' : 'Find available slots'}
                          </button>
                        )}

                        {slotsError && (
                          <p style={{ fontSize: 13, color: 'var(--danger)', marginTop: 8 }}>{slotsError}</p>
                        )}
                      </div>
                    ) : (
                      <SlotPicker
                        slots={patchTestSlots}
                        {...patchTestPickerCopy}
                        onPick={confirmPatchTestSlot}
                        confirming={confirmingSlot}
                        error={slotsError}
                        onBack={() => { setShowSlotPicker(false); setSlotsError(null); }}
                        brand={brand}
                        brandLight={brandLight}
                      />
                    )}
                  </div>
                );
              }

              /* Display past/confirmed patch tests.
               *
               * This used to print a green tick and the word "passed" for
               * `pt.status === 'passed'`, a value the database has never held
               * and, on the result column, could not hold: the CHECK
               * constraint knows 'pending', 'pass', 'fail' and 'reaction'. So
               * it painted every real row amber and captioned it "pending",
               * which reads to a client as though something were wrong.
               *
               * What is said now is only what the row actually attests to:
               * the salon wrote it down, or a slot is booked, or a result was
               * recorded by a person. Never a pass this app decided on. */
              const outcome = pt.result === 'pass' ? 'No reaction'
                : pt.result === 'fail' || pt.result === 'reaction' ? 'Reaction noted'
                  : null;
              const caption = recordedByOwner ? 'Done in the salon'
                : outcome || (pt.confirmed_at ? 'Booked' : 'To be booked');
              const dot = outcome === 'Reaction noted' ? 'var(--danger)'
                : (recordedByOwner || outcome) ? '#5BA67F'
                  : 'var(--warning)';
              const when = pt.test_date || pt.suggested_slot;
              return (
                <div key={pt.id} style={S.patchTestRow}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: dot }} />
                  <div style={{ flex: 1 }}>
                    <p style={S.patchTestName}>
                      {pt.treatments?.name || 'Patch test'}
                    </p>
                    <p style={S.patchTestMeta}>
                      {when
                        ? new Date(`${String(when).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC' })
                        : 'Date TBC'}
                      {' \u00b7 '}
                      <span>{caption}</span>
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pending consultation forms */}
        {pendingForms && pendingForms.length > 0 && (
          <div style={{ ...S.card, borderLeft: `3px solid #7B6BA8` }}>
            <p style={S.sectionLabel}>Consultation forms</p>
            {pendingForms.map(form => (
              <div key={form.id} style={S.formRow}>
                <Icon name={iconName('assignment')} size={18} inline style={{ color: '#7B6BA8' }} />
                <div style={{ flex: 1 }}>
                  <p style={S.formName}>{form.consultation_forms?.name || 'Consultation form'}</p>
                  <p style={S.formMeta}>Please complete this before your appointment</p>
                </div>
                {form.form_url && (
                  <a href={form.form_url} style={{ ...S.formLink, color: '#7B6BA8', borderColor: '#7B6BA830', background: '#7B6BA810' }}>
                    Complete
                  </a>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Reschedule section */}
        {!isCancelled && !isCompleted && !isPast && (
          <div>
            {policy.reschedule_once && policy.alreadyRescheduled ? (
              <div style={S.reschedUsedNote}>
                You've already moved this booking once. Please contact {appointment.beautician.name} directly if you need to change it again.
              </div>
            ) : !showReschedule ? (
              <button onClick={openReschedule} style={S.rescheduleBtn}>
                Reschedule appointment
              </button>
            ) : (
              <div style={S.rescheduleCard}>
                {policy.withinCancellationWindow && policy.late_cancel_charge_percent > 0 && (
                  <div style={{ ...S.warningBanner, marginBottom: 12 }}><Icon name="alert-triangle" size={14} inline /> You're within the {policy.cancellation_notice_hours}-hour window. Rescheduling now may result in a {policy.late_cancel_charge_percent}% charge for this appointment, plus you'll need to pay for your new booking.
                  </div>
                )}

                {policy.reschedule_between_only ? (
                  <>
                    <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px', color: '#1a1a1a' }}>
                      Pick a new time
                    </p>
                    <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: 1.5 }}>
                      These are the times that fit right before or after another booking.
                    </p>
                    {loadingReschedSlots ? (
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>Finding times…</p>
                    ) : reschedSlotsError ? (
                      <p style={{ fontSize: 13, color: 'var(--danger)', margin: '0 0 12px' }}>{reschedSlotsError}</p>
                    ) : rescheduleSlots && rescheduleSlots.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                        {rescheduleSlots.map((slot) => (
                          <button className="fl-tap"
                            key={slot}
                            onClick={() => handleReschedule(slot)}
                            disabled={rescheduling}
                            style={{ padding: '12px 14px', borderRadius: 10, border: '1.5px solid #E8E4DF',
                              background: 'var(--bg-card)', fontSize: 13, fontWeight: 600, color: '#2D1B1B',
                              cursor: rescheduling ? 'not-allowed' : 'pointer', opacity: rescheduling ? 0.5 : 1,
                              textAlign: 'left', fontFamily: 'inherit', transition: 'all 0.2s',
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.borderColor = brand}
                            onMouseLeave={(e) => e.currentTarget.style.borderColor = '#E8E4DF'}
                          >
                            {slotLabel(slot)}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <>
                        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: 1.5 }}>
                          No back-to-back times are free in the next {reschedHorizonDays} days. {appointment.beautician.name} can often fit something in that the diary will not show, so please get in touch.
                        </p>
                        {reachTheSalon}
                      </>
                    )}
                    {rescheduleError && (
                      <p style={{ fontSize: 13, color: 'var(--danger)', margin: '0 0 10px' }}>{rescheduleError}</p>
                    )}
                    <button onClick={closeReschedule} style={S.keepBtn}>
                      Back
                    </button>
                  </>
                ) : (
                  <>
                    {/* THE DEFAULT. It used to be a date box, a time box and a
                        client guessing, and every guess that missed came back
                        as "that time is not available". Same real, pickable
                        times the public booking page offers, minus this very
                        appointment, which must not block its own replacement. */}
                    <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px', color: '#1a1a1a' }}>
                      Pick a new time
                    </p>
                    <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: 1.5 }}>
                      These are the times {appointment.beautician.name} has free. Anything you can tap here is yours.
                    </p>

                    {rescheduleError && (
                      <p style={{ fontSize: 13, color: 'var(--danger)', margin: '0 0 10px', fontWeight: 600 }}>{rescheduleError}</p>
                    )}

                    {loadingReschedSlots ? (
                      <>
                        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>Finding your available times…</p>
                        <button onClick={closeReschedule} style={S.keepBtn}>Back</button>
                      </>
                    ) : reschedSlotsError ? (
                      <>
                        {/* A failed lookup is not an empty diary, and it must
                            not read like one. Say so, and offer the retry. */}
                        <p style={{ fontSize: 13, color: 'var(--danger)', margin: '0 0 12px', lineHeight: 1.5 }}>
                          {reschedSlotsError} We could not load the diary just then, so this is not a list of everything that is free.
                        </p>
                        <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                          <button onClick={closeReschedule} style={S.keepBtn}>Back</button>
                          <Button variant="secondary" onClick={loadRescheduleSlots} style={{ flex: 1 }}>
                            Try again
                          </Button>
                        </div>
                        {reachTheSalon}
                      </>
                    ) : (
                      <SlotPicker
                        slots={rescheduleSlots || []}
                        {...reschedulePickerCopy}
                        onPick={handleReschedule}
                        confirming={rescheduling}
                        error={null}
                        onBack={closeReschedule}
                        brand={brand}
                        brandLight={brandLight}
                      />
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Cancel button */}
        {!isCancelled && !isCompleted && !isPast && (
          <div style={{ marginTop: 8 }}>
            {!cancelConfirm ? (
              <button onClick={() => setCancelConfirm(true)} style={S.cancelBtn}>
                Cancel appointment
              </button>
            ) : (
              <div style={S.confirmCancel}>
                <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: '#1a1a1a' }}>
                  Are you sure you want to cancel?
                </p>
                {policy.withinCancellationWindow && policy.lateCancelFeeCents > 0 ? (
                  <p style={{ fontSize: 13, color: 'var(--danger)', margin: '0 0 12px' }}>
                    {policy.cardOnFile
                      ? `Cancelling within ${policy.cancellation_notice_hours || 48} hours of your appointment means a £${(policy.lateCancelFeeCents / 100).toFixed(2)} fee on the card you used for your deposit.`
                      : `Cancelling within ${policy.cancellation_notice_hours || 48} hours of your appointment means a £${(policy.lateCancelFeeCents / 100).toFixed(2)} late cancellation fee may apply.`}
                  </p>
                ) : policy.withinCancellationWindow && policy.late_cancel_charge_percent > 0 ? (
                  <p style={{ fontSize: 13, color: 'var(--danger)', margin: '0 0 12px' }}>
                    A {policy.late_cancel_charge_percent}% cancellation fee may be charged as you are within the notice period.
                  </p>
                ) : null}
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setCancelConfirm(false)} style={S.keepBtn}>
                    Keep booking
                  </button>
                  <Button variant="danger" onClick={handleCancel} disabled={cancelling} style={{ flex: 1 }}>
                    {cancelling ? 'Cancelling…' : 'Yes, cancel'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {isCancelled && (
          <div style={S.cancelledBanner}>
            This appointment has been cancelled.{' '}
            <a href={`/book/${slug}`} style={{ color: brandInk, fontWeight: 600 }}>Book again →</a>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={S.footer}>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Powered by </span>
        <span style={{ color: brandInk, fontSize: 13, fontWeight: 700, fontFamily: "'Playfair Display', Georgia, serif", fontStyle: 'italic' }}>florrie.ai</span>
      </div>
    </div>
  );
}

function slotLabel(iso) {
  // Wall-clock read: the slot is stored as salon local time, so slice it.
  const d = String(iso).slice(0, 10);
  const t = String(iso).slice(11, 16);
  const dt = new Date(`${d}T12:00:00Z`);
  const day = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${day} · ${t}`;
}

function MetaRow({ icon, label, value }) {
  return (
    <div style={S.metaRow}>
      <Icon name={iconName(icon)} size={16} inline style={{ color: 'var(--text-muted)' }} />
      <span style={S.metaLabel}>{label}</span>
      <span style={S.metaValue}>{value}</span>
    </div>
  );
}

/**
 * A proper calendar: pick a day, then a time, exactly like the main booking
 * page. Slots arrive as SALON WALL TIME in the UTC slot, so we read the
 * date/time straight off the string (slice) and never let the browser timezone
 * shift them.
 *
 * This was PatchTestPicker, and for a while it was the only place on this page
 * where a client could see real times. Rescheduling had a date box and a time
 * box and a client guessing, which is what she told Ellie it felt like. It is
 * the same picker, so it is one component; only the words around it change.
 */
function SlotPicker({
  slots, onPick, confirming, error, onBack, brand, brandLight,
  title, emptyMessage, emptyExtra = null, confirmLabel, confirmingLabel,
  // The reschedule card is already a card. Nesting a second identical one
  // inside it draws two borders round the same thing.
  frameless = false,
}) {
  const byDay = useMemo(() => {
    const m = new Map();
    for (const s of slots || []) {
      const k = s.slice(0, 10);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    return m;
  }, [slots]);

  const dayKeys = useMemo(() => [...byDay.keys()].sort(), [byDay]);
  const months = useMemo(() => [...new Set(dayKeys.map(k => k.slice(0, 7)))].sort(), [dayKeys]);

  const [selectedDay, setSelectedDay] = useState(null);
  const [selectedTime, setSelectedTime] = useState(null);
  const [month, setMonth] = useState(null);

  const longDay = (key) => new Date(`${key}T00:00:00Z`)
    .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  useEffect(() => {
    if (dayKeys.length && !selectedDay) {
      setSelectedDay(dayKeys[0]);
      setMonth(dayKeys[0].slice(0, 7));
    }
  }, [dayKeys, selectedDay]);

  // NOTHING FREE IS NOT AN ANSWER ON ITS OWN. A client who is told "no times
  // available" and given no next step simply does not rebook, so the caller
  // always passes a way to reach the salon alongside the bad news.
  const frame = frameless ? undefined : S.slotPickerCard;

  if (!dayKeys.length) {
    return (
      <div style={frame}>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
          {emptyMessage}
        </p>
        {emptyExtra}
        <button onClick={onBack} style={S.keepBtn}>Back</button>
      </div>
    );
  }

  const shown = month || dayKeys[0].slice(0, 7);
  const [yy, mm] = shown.split('-').map(Number);
  const firstOfMonth = new Date(Date.UTC(yy, mm - 1, 1));
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const lead = (firstOfMonth.getUTCDay() + 6) % 7; // Monday-first grid
  const monthLabel = firstOfMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const mIdx = months.indexOf(shown);
  const times = selectedDay ? (byDay.get(selectedDay) || []) : [];

  const navBtn = (on) => ({
    width: 30, height: 30, borderRadius: 10, border: 'none', background: 'transparent',
    color: on ? brand : '#D8D2CC', fontSize: 18, cursor: on ? 'pointer' : 'default', fontFamily: 'inherit',
  });

  return (
    <div style={frame}>
      {title ? (
        <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 10px', color: '#1a1a1a' }}>
          {title}
        </p>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <button type="button" disabled={mIdx <= 0} onClick={() => setMonth(months[mIdx - 1])} style={navBtn(mIdx > 0)} aria-label="Previous month">{'\u2039'}</button>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#2D1B1B' }}>{monthLabel}</span>
        <button type="button" disabled={mIdx >= months.length - 1} onClick={() => setMonth(months[mIdx + 1])} style={navBtn(mIdx < months.length - 1)} aria-label="Next month">{'\u203A'}</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
          <span key={d} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: '#9C9690' }}>{d}</span>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 12 }}>
        {Array.from({ length: lead }).map((_, i) => <span key={`blank${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => {
          const key = `${shown}-${String(d).padStart(2, '0')}`;
          const has = byDay.has(key);
          const sel = key === selectedDay;
          return (
            <button
              key={key}
              type="button"
              disabled={!has}
              onClick={() => { setSelectedDay(key); setSelectedTime(null); }}
              style={{ aspectRatio: '1', borderRadius: 10, fontFamily: 'inherit', fontSize: 13,
                border: sel ? `1.5px solid ${brand}` : '1.5px solid transparent',
                background: sel ? brand : has ? brandLight : 'transparent',
                color: sel ? '#fff' : has ? '#2D1B1B' : '#D8D2CC',
                fontWeight: has ? 700 : 500,
                cursor: has ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {d}
            </button>
          );
        })}
      </div>

      {selectedDay && (
        <>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 8px' }}>
            {longDay(selectedDay)}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 8, marginBottom: 14 }}>
            {times.map(t => {
              const on = t === selectedTime;
              return (
                <button className="fl-tap"
                  key={t}
                  type="button"
                  disabled={confirming}
                  onClick={() => setSelectedTime(t)}
                  style={{ padding: '11px 6px', borderRadius: 10,
                    border: on ? `1.5px solid ${brand}` : '1.5px solid #E8E4DF',
                    background: on ? brand : 'var(--bg-card)',
                    color: on ? '#fff' : '#2D1B1B',
                    fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                    cursor: confirming ? 'not-allowed' : 'pointer',
                    opacity: confirming && !on ? 0.5 : 1,
                    transition: 'all 0.15s',
                  }}
                >
                  {t.slice(11, 16)}
                </button>
              );
            })}
          </div>
        </>
      )}

      {error && (
        <p style={{ fontSize: 13, color: 'var(--danger)', margin: '0 0 10px', fontWeight: 600 }}>{error}</p>
      )}

      {selectedTime ? (
        <>
          <div style={{ background: brandLight, borderRadius: 10, padding: '10px 12px', marginBottom: 10,
            fontSize: 13, color: '#2D1B1B', fontWeight: 600, textAlign: 'center',
          }}>
            {longDay(selectedTime.slice(0, 10))} at {selectedTime.slice(11, 16)}
          </div>
          <button
            type="button"
            disabled={confirming}
            onClick={() => onPick(selectedTime)}
            style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none',
              background: brand, color: '#fff', fontSize: 15, fontWeight: 700,
              fontFamily: 'inherit', cursor: confirming ? 'wait' : 'pointer',
              opacity: confirming ? 0.75 : 1, marginBottom: 8,
            }}
          >
            {confirming ? confirmingLabel : confirmLabel}
          </button>
        </>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', margin: '0 0 10px' }}>
          Tap a time to choose it, then confirm.
        </p>
      )}

      <button onClick={onBack} disabled={confirming} style={S.keepBtn}>Back</button>
    </div>
  );
}

const S = {
  page: {
    minHeight: 'var(--shell-viewport)',
    background: 'var(--bg)',
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
    display: 'flex',
    flexDirection: 'column',
  },
  loadingWrap: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 16, padding: 40,
  },
  spinner: {
    width: 32, height: 32, borderRadius: '50%',
    border: '3px solid var(--border-light)', borderTopColor: 'var(--accent-rose)',
    animation: 'spin 0.8s linear infinite',
  },
  loadingText: { fontSize: 14, color: 'var(--text-muted)', margin: 0 },
  header: {
    background: 'var(--bg-card)',
    padding: '20px 20px 16px',
    boxShadow: '0 1px 0 rgba(0,0,0,0.06)',
  },
  headerInner: { maxWidth: 480, margin: '0 auto' },
  businessName: {
    margin: 0, fontSize: 22, fontWeight: 700,
    fontFamily: "'Playfair Display', Georgia, serif",
    fontStyle: 'italic',
  },
  headerSub: { margin: '2px 0 0', fontSize: 13, color: 'var(--text-muted)' },
  content: { flex: 1, maxWidth: 480, margin: '0 auto', width: '100%', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 12 },
  card: {
    background: 'var(--bg-card)', borderRadius: 16,
    padding: '18px 18px', boxShadow: 'var(--elev-2)',
  },
  cardTitle: {
    textAlign: 'center', fontSize: 18, fontWeight: 700, margin: '0 0 8px',
    fontFamily: "'Playfair Display', Georgia, serif",
  },
  cardBody: { textAlign: 'center', fontSize: 14, color: 'var(--text-secondary)', margin: 0 },
  bookingStatus: { display: 'flex', justifyContent: 'flex-end', marginBottom: 8 },
  statusChip: {
    padding: '3px 10px', borderRadius: 'var(--radius-xs)', fontSize: 12, fontWeight: 600,
    textTransform: 'capitalize', letterSpacing: '0.02em',
  },
  treatmentName: {
    margin: '0 0 14px', fontSize: 20, fontWeight: 700,
    fontFamily: "'Playfair Display', Georgia, serif",
    color: '#2D1B1B',
  },
  metaGrid: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 },
  metaRow: { display: 'flex', alignItems: 'center', gap: 8 },
  metaLabel: { fontSize: 13, color: 'var(--text-muted)', width: 60, flexShrink: 0 },
  metaValue: { fontSize: 13, fontWeight: 600, color: '#2D1B1B', flex: 1 },
  clientSection: { borderTop: '1px solid #F0EBE6', paddingTop: 14 },
  sectionLabel: {
    margin: '0 0 8px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.08em', color: 'var(--text-muted)',
  },
  clientName: { margin: '0 0 2px', fontWeight: 600, fontSize: 15, color: '#2D1B1B' },
  clientMeta: { margin: '0 0 2px', fontSize: 13, color: 'var(--text-secondary)' },
  policyCard: {
    background: 'var(--bg-card)', borderRadius: 16,
    padding: '16px 18px', boxShadow: 'var(--elev-2)',
  },
  policyText: { margin: '0 0 4px', fontSize: 13, color: '#555', lineHeight: 1.5 },
  bankRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
    padding: '6px 0', borderBottom: '1px solid rgba(0,0,0,0.05)',
  },
  bankLabel: { fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 },
  bankValue: { fontSize: 14, fontWeight: 600, color: '#2D1B1B', textAlign: 'right' },
  bankValueMono: {
    fontSize: 15, fontWeight: 700, color: '#2D1B1B', textAlign: 'right',
    fontFamily: "'SF Mono', 'Roboto Mono', Menlo, monospace", letterSpacing: '0.04em',
  },
  warningBanner: {
    marginTop: 10, padding: '10px 12px', borderRadius: 10,
    background: '#FFFBEB', border: '1px solid #F59E0B',
    fontSize: 13, color: 'var(--warning-text)', fontWeight: 500,
  },
  patchTestRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 0', borderBottom: '1px solid #F5F0EB',
  },
  patchTestName: { margin: 0, fontSize: 14, fontWeight: 600, color: '#2D1B1B' },
  patchTestMeta: { margin: '2px 0 0', fontSize: 12, color: 'var(--text-secondary)' },
  patchTestBooking: {
    padding: '14px', borderRadius: 10, background: '#FFFBF0',
    border: '1.5px solid #F5E6D3',
  },
  confirmSlotBtn: {
    padding: '12px 14px', borderRadius: 10, border: 'none',
    color: '#fff', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  altSlotBtn: {
    padding: '12px 14px', borderRadius: 10, border: '1.5px solid #E8E4DF',
    background: 'var(--bg-card)', color: '#555', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  slotPickerCard: {
    background: 'var(--bg-card)', borderRadius: 16, padding: '18px 18px',
    boxShadow: 'var(--elev-2)', border: '1px solid #E8E4DF',
  },
  formRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 0', borderBottom: '1px solid #F5F0EB',
  },
  formName: { margin: 0, fontSize: 14, fontWeight: 600, color: '#2D1B1B' },
  formMeta: { margin: '2px 0 0', fontSize: 12, color: 'var(--text-secondary)' },
  formLink: {
    padding: '6px 12px', borderRadius: 10, fontSize: 12, fontWeight: 600,
    border: '1.5px solid', textDecoration: 'none', flexShrink: 0,
  },
  cancelBtn: {
    width: '100%', padding: '13px 0', borderRadius: 10, border: '1.5px solid #FECACA',
    background: '#FFF5F5', color: 'var(--danger)', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  confirmCancel: {
    background: 'var(--bg-card)', borderRadius: 16, padding: '18px 18px',
    boxShadow: 'var(--elev-2)', border: '1px solid #FECACA',
  },
  keepBtn: {
    flex: 1, padding: '12px 0', borderRadius: 10, border: '1.5px solid #E8E4DF',
    background: 'var(--bg-card)', color: '#555', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  confirmCancelBtn: {
    flex: 1, padding: '12px 0', borderRadius: 10, border: 'none',
    background: 'var(--danger)', color: '#fff', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  cancelledBanner: {
    textAlign: 'center', padding: '16px', borderRadius: 10,
    background: '#F9F9F9', fontSize: 14, color: 'var(--text-secondary)',
    border: '1px solid #E8E4DF',
  },
  footer: {
    textAlign: 'center', padding: '20px 16px',
    borderTop: '1px solid #F0EBE6',
  },
  reschedUsedNote: {
    padding: '14px 16px', borderRadius: 10, background: '#F9F9F9',
    border: '1px solid #E8E4DF', fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.5,
  },
  rescheduleBtn: {
    width: '100%', padding: '13px 0', borderRadius: 10,
    border: '1.5px solid #C76B8A33', background: '#FFF0F4',
    // NOT var(--accent-rose). The token is #c76b8a and this button paints it
    // on #FFF0F4, its own tint, which is 3.22:1 — under AA on the control a
    // client taps to move their appointment. Same rose, one shade deeper, so
    // it still reads as the same button.
    color: ROSE_INK, fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  rescheduleCard: {
    background: 'var(--bg-card)', borderRadius: 16, padding: '18px 18px',
    boxShadow: 'var(--elev-2)', border: '1px solid #E8E4DF',
  },
};
