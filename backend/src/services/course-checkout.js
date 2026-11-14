import Stripe from 'stripe';
import { supabase } from '../config.js';
import { insertPaymentReceipt } from '../lib/payment-receipt.js';
import { deliverCourseNotice } from './course-notice-delivery.js';

// Only call with a signature-verified webhook or a session retrieved from Stripe.
export async function settleCourseCheckout(session, { expired = false } = {}) {
  const meta = session.metadata || {};
  if (meta.type !== 'course_deposit' || !meta.enrollment_id || !meta.course_id || !meta.beautician_id) throw new Error('Missing course checkout metadata');
  if (expired ? session.status !== 'expired' : session.mode !== 'payment' || session.payment_status !== 'paid' || session.currency !== 'gbp') throw new Error('Course checkout is not settled');
  const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  const { data, error } = await supabase.rpc('settle_course_checkout', {
    p_id: meta.enrollment_id, p_owner: meta.beautician_id, p_course: meta.course_id,
    p_session: session.id, p_intent: intent || null, p_amount: session.amount_total || 0, p_expired: expired,
  });
  if (error) throw error;
  if (!expired) {
    // Delivery state is independent of the payment transition, including retries.
    await deliverCourseNotice(meta.enrollment_id);
    // Independently idempotent so a crash after reserving the paid place cannot lose its receipt.
    const receipt = await insertPaymentReceipt(supabase, { beautician_id: meta.beautician_id,
      amount_cents: session.amount_total, type: 'deposit', status: 'completed',
      stripe_payment_intent_id: intent, payment_method: 'card_online' });
    if (receipt.error) throw receipt.error;
  }
  return data;
}

// Do not free a place just because our clock passed expires_at. A successful
// payment may be waiting for its webhook. Stripe must prove it cannot be paid.
export async function reconcileCourseHolds(stripe, courseIds = null) {
  if (!stripe || (courseIds && !courseIds.length)) return;
  let query = supabase.from('course_enrollments')
    .select('id,course_id,beautician_id,checkout_session_id,checkout_payload,checkout_expires_at,checkout_checked_at');
  if (courseIds) query = query.in('course_id', courseIds);
  const { data, error } = await query.eq('reservation_status', 'held')
    .or(`checkout_expires_at.is.null,checkout_expires_at.lte.${new Date().toISOString()}`)
    .order('checkout_checked_at', { ascending: true, nullsFirst: true }).order('id', { ascending: true }).limit(10);
  if (error) throw error;
  const outcomes = await Promise.allSettled((data || []).map(async row => {
    if (row.checkout_expires_at && Date.parse(row.checkout_expires_at) > Date.now()) return;
    // Rotate attempted rows to the end even when Stripe is unavailable. Future
    // holds are filtered before LIMIT, so they cannot starve expired checkouts.
    const checked = await supabase.from('course_enrollments').update({ checkout_checked_at: new Date().toISOString() })
      .eq('id', row.id).eq('reservation_status', 'held');
    if (checked.error) throw checked.error;
    let session;
    if (row.checkout_session_id) {
      session = await stripe.checkout.sessions.retrieve(row.checkout_session_id, {}, { timeout: 5000, maxNetworkRetries: 0 });
    } else if (row.checkout_payload && Date.now() - Date.parse(row.checkout_expires_at) < 20 * 60 * 60 * 1000) {
      // Same immutable request/key recovers a successful create whose response was lost.
      session = await stripe.checkout.sessions.create(row.checkout_payload, { idempotencyKey: `course-place-${row.id}`, timeout: 5000, maxNetworkRetries: 0 });
      const attached = await supabase.rpc('attach_course_checkout', { p_id: row.id, p_session: session.id });
      if (attached.error) throw attached.error;
    } else {
      // Keep the seat safe and make the unresolved payment visible to its owner.
      const attention = await supabase.from('course_enrollments').update({ checkout_attention_reason: 'session_lookup_required' })
        .eq('id', row.id).eq('reservation_status', 'held');
      if (attention.error) throw attention.error;
      return;
    }
    if (session.status === 'expired') await settleCourseCheckout(session, { expired: true });
    else if (session.payment_status === 'paid') await settleCourseCheckout(session);
  }));
  // Keep the scheduler lease until every bounded attempt has finished. A failed
  // provider lookup must not stop the other rows from recovering their places.
  const failed = outcomes.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

// Run independently of catalogue traffic, including courses closed to new
// bookings. The same provider checks apply if an expiry webhook was missed.
export async function reconcileDueCourseHolds(stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null) {
  await reconcileCourseHolds(stripe);
}
