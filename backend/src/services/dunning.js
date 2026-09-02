/**
 * Dunning: what happens when the salon's own Florrie payment fails.
 *
 * Until September 2026 neither Stripe webhook handled invoice.payment_failed
 * or invoice.paid. A declined renewal produced nothing at all: no email to
 * the owner, no banner, no Sentry. The subscription drifted to 'past_due' via
 * customer.subscription.updated (when that write did not fail on the CHECK
 * constraint, see lib/subscription-status.js), the diary locked, and the
 * first the owner heard of it was clients saying the booking page was down.
 *
 * ONE handler, called from BOTH webhook routes. /api/stripe/webhook and
 * /api/billing/webhook are both mounted in index.js and both dedupe on the
 * stripe_events table, so whichever one Stripe hits first processes the event
 * and the other skips it as a duplicate. If only one of them knew about
 * invoice events, an event landing on the other would be recorded and
 * silently dropped. Sharing the function is what stops that.
 *
 * payment_failed_at is a NEW column (migration 20260902_backend027). The
 * migrations are applied by hand, so the code must work whether or not the
 * column exists yet: the status update and the marker update are two separate
 * writes, and a missing column only costs the marker, never the status.
 */
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { internalStatusFor } from '../lib/subscription-status.js';
import { isMissingColumnError } from '../lib/junk-classifier.js';
import { sendEmail } from './notifications.js';

const APP_URL = process.env.APP_URL || 'https://app.florrie.ai';
export const BILLING_PAGE_PATH = '/pricing';
export const GRACE_DAYS = 7;

function idOf(ref) {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id || null;
}

/**
 * Find the beautician an invoice belongs to. Stripe copies the subscription's
 * metadata onto the invoice (subscription_details.metadata, or
 * parent.subscription_details.metadata on newer API versions), so the
 * beautician_id is usually right there. Failing that, match on the
 * subscription id, then on the customer id.
 *
 * Every read reports its error: a missing column here resolves with
 * { data: null, error } and must not be mistaken for "no such salon".
 */
export async function findBeauticianForInvoice(invoice) {
  const metaId = invoice?.subscription_details?.metadata?.beautician_id
    || invoice?.parent?.subscription_details?.metadata?.beautician_id
    || invoice?.metadata?.beautician_id
    || null;
  const subscriptionId = idOf(invoice?.subscription) || idOf(invoice?.parent?.subscription_details?.subscription);
  const customerId = idOf(invoice?.customer);

  const lookups = [];
  if (metaId) lookups.push(['id', metaId]);
  if (subscriptionId) lookups.push(['subscription_stripe_id', subscriptionId]);
  if (customerId) lookups.push(['stripe_customer_id', customerId]);

  for (const [column, value] of lookups) {
    const { data, error } = await supabase
      .from('beauticians')
      .select('id, email, first_name, business_name, subscription_status, subscription_plan')
      .eq(column, value)
      .maybeSingle();
    if (error) {
      logger.error({ err: error, column, value, invoiceId: invoice?.id }, 'dunning: beautician lookup failed');
      continue;
    }
    if (data) return data;
  }
  return null;
}

async function writeStatus(beauticianId, stripeStatus, invoiceId, eventType) {
  const status = internalStatusFor(stripeStatus);
  const { error } = await supabase
    .from('beauticians')
    .update({ subscription_status: status })
    .eq('id', beauticianId);
  if (error) {
    logger.error({ err: error, beauticianId, status, invoiceId, eventType }, 'dunning: subscription_status update failed');
    Sentry.captureException(error, {
      tags: { area: 'billing', check: 'subscription_status_write' },
      extra: { beauticianId, status, invoiceId, eventType },
    });
    return { ok: false, status };
  }
  return { ok: true, status };
}

/**
 * The marker write is separate from the status write on purpose. PostgREST
 * rejects a whole UPDATE when one column in it is unknown, so bundling
 * payment_failed_at into the status update would mean an unapplied migration
 * silently blocks the status change, which is the exact class of failure this
 * file exists to end.
 */
async function writeMarker(beauticianId, value, eventType) {
  const { error } = await supabase
    .from('beauticians')
    .update({ payment_failed_at: value })
    .eq('id', beauticianId);
  if (!error) return { written: true };
  if (isMissingColumnError(error)) {
    logger.warn({ beauticianId, eventType }, 'dunning: beauticians.payment_failed_at is missing, skipping the marker (apply migration 20260902_backend027)');
    return { written: false, missing: true };
  }
  logger.error({ err: error, beauticianId, eventType }, 'dunning: payment_failed_at update failed');
  Sentry.captureException(error, {
    tags: { area: 'billing', check: 'payment_failed_at_write' },
    extra: { beauticianId, eventType },
  });
  return { written: false, missing: false };
}

function paymentFailedEmail(beautician) {
  const name = beautician.first_name ? `Hi ${beautician.first_name},` : 'Hi,';
  const billingUrl = `${APP_URL}${BILLING_PAGE_PATH}`;
  const text = [
    name,
    '',
    'Your Florrie subscription payment did not go through. This is usually an expired card or a bank decline, and it is easily fixed.',
    '',
    `Nothing changes for the next ${GRACE_DAYS} days. Your diary, clients and messages all carry on as normal while the card is sorted out. Stripe will retry the payment automatically, and you can update your card here:`,
    '',
    billingUrl,
    '',
    'Your clients are not affected. Their bookings, reminders and the booking page keep working.',
    '',
    `If the payment has not gone through after ${GRACE_DAYS} days, Florrie will pause your account until it does. Reply to this email if anything looks wrong and we will sort it.`,
    '',
    'Florrie',
  ].join('\n');
  const html = text
    .split('\n')
    .map(line => (line === billingUrl ? `<p><a href="${billingUrl}">Update your card</a></p>` : line ? `<p>${line}</p>` : ''))
    .join('');
  return { subject: 'Your Florrie payment did not go through', text, html };
}

/**
 * invoice.payment_failed
 * Marks the salon past_due, stamps payment_failed_at (if the column exists),
 * emails the owner, and tells Sentry so the failure count is visible.
 */
export async function handleInvoicePaymentFailed(invoice, { eventType = 'invoice.payment_failed' } = {}) {
  const beautician = await findBeauticianForInvoice(invoice);
  if (!beautician) {
    logger.warn({ invoiceId: invoice?.id, customer: idOf(invoice?.customer) }, 'dunning: payment failed for an invoice with no matching beautician');
    return { handled: false, reason: 'no_beautician' };
  }

  const statusResult = await writeStatus(beautician.id, 'past_due', invoice?.id, eventType);
  const marker = await writeMarker(beautician.id, new Date().toISOString(), eventType);

  let emailed = false;
  if (beautician.email) {
    try {
      const mail = paymentFailedEmail(beautician);
      await sendEmail({ to: beautician.email, ...mail });
      emailed = true;
    } catch (err) {
      logger.error({ err, beauticianId: beautician.id }, 'dunning: payment failed email could not be sent');
    }
  } else {
    logger.warn({ beauticianId: beautician.id }, 'dunning: beautician has no email, payment failed notice not sent');
  }

  Sentry.captureMessage('Florrie subscription payment failed', {
    level: 'warning',
    tags: { area: 'billing', check: 'invoice_payment_failed' },
    extra: {
      beauticianId: beautician.id,
      invoiceId: invoice?.id || null,
      attemptCount: invoice?.attempt_count ?? null,
      amountDue: invoice?.amount_due ?? null,
      statusWritten: statusResult.ok,
      markerWritten: marker.written,
    },
  });

  logger.warn({ beauticianId: beautician.id, invoiceId: invoice?.id, emailed, marker }, 'dunning: subscription payment failed');
  return { handled: true, beauticianId: beautician.id, status: statusResult.status, statusWritten: statusResult.ok, marker, emailed };
}

/**
 * invoice.paid / invoice.payment_succeeded
 * The card went through (first payment or a retry): back to 'active', and the
 * failure marker is cleared so the grace period clock stops.
 */
export async function handleInvoicePaid(invoice, { eventType = 'invoice.paid' } = {}) {
  const beautician = await findBeauticianForInvoice(invoice);
  if (!beautician) {
    logger.warn({ invoiceId: invoice?.id, customer: idOf(invoice?.customer) }, 'dunning: invoice paid for an invoice with no matching beautician');
    return { handled: false, reason: 'no_beautician' };
  }

  const statusResult = await writeStatus(beautician.id, 'active', invoice?.id, eventType);
  const marker = await writeMarker(beautician.id, null, eventType);

  logger.info({ beauticianId: beautician.id, invoiceId: invoice?.id, marker }, 'dunning: subscription invoice paid');
  return { handled: true, beauticianId: beautician.id, status: statusResult.status, statusWritten: statusResult.ok, marker };
}

export const DUNNING_EVENT_TYPES = ['invoice.payment_failed', 'invoice.paid', 'invoice.payment_succeeded'];

/**
 * Route an invoice event to its handler. Returns null for anything that is
 * not a dunning event so the caller's switch can carry on.
 */
export async function handleDunningEvent(event) {
  const invoice = event?.data?.object;
  switch (event?.type) {
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(invoice, { eventType: event.type });
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return handleInvoicePaid(invoice, { eventType: event.type });
    default:
      return null;
  }
}
