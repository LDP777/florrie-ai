import { exactEmailPattern } from './booking-identity.js';
import { isMissingColumnError } from './junk-classifier.js';

const CLIENT_COLUMNS = 'id, stripe_customer_id, blocked_at, phone, preferences';
const unavailable = (error, stage) => ({
  status: 503,
  error: 'We could not save your booking details just then. Nothing has been booked or charged. Please try again.',
  // Never log the database message/details: unique violations contain contacts.
  diagnostic: { code: error?.code || 'missing_client', stage },
});
const blocked = () => ({ status: 403, error: 'Online booking is not available for this account. Please contact us directly.' });

/** The caller must supply the email established by requireBookingIdentity. */
export async function resolveBookingClient(db, payload) {
  if (!payload.email) return { status: 401, error: 'Verify your email before continuing.' };
  const byEmail = async () => {
    const select = columns => db.from('clients').select(columns)
      .eq('beautician_id', payload.beautician_id)
      .ilike('email', exactEmailPattern(payload.email)).maybeSingle();
    let result = await select(`${CLIENT_COLUMNS}, archived_at`);
    if (result.error && isMissingColumnError(result.error)) result = await select(CLIENT_COLUMNS);
    return result;
  };
  const found = (client, created = false) => client.blocked_at ? blocked() : ({
    client, created, contactReview: client.preferences?.booking_contact_review === 'pending',
  });
  const insert = row => db.from('clients').insert(row).select(CLIENT_COLUMNS).single();

  const existing = await byEmail();
  if (existing.error) return unavailable(existing.error, 'lookup');
  if (existing.data) return found(existing.data);

  const created = await insert(payload);
  if (!created.error && created.data) return found(created.data, true);
  if (created.error?.code !== '23505') return unavailable(created.error, 'insert');

  // Another request may have created this verified identity after our lookup.
  // Re-read it before handling a phone collision. Never upsert over old records.
  const concurrent = await byEmail();
  if (concurrent.error) return unavailable(concurrent.error, 'concurrent_lookup');
  if (concurrent.data) return found(concurrent.data);
  if (!payload.phone) return unavailable(created.error, 'unresolved_conflict');

  const phoneMatch = await db.from('clients').select('id, blocked_at')
    .eq('beautician_id', payload.beautician_id).eq('phone', payload.phone).maybeSingle();
  if (phoneMatch.error) return unavailable(phoneMatch.error, 'phone_conflict_lookup');
  if (!phoneMatch.data) return unavailable(created.error, 'unresolved_conflict');
  if (phoneMatch.data.blocked_at) return blocked();

  // An old email, shared family number or mistyped number must not stop a new
  // booking, nor grant access to the other client's cards, forms or packages.
  // Keep a separate email-owned record. The supplied number stays in staff-only
  // notes for checking; it is not registered as a messaging/identity address.
  const isolated = await insert({
    ...payload,
    phone: null,
    preferred_channel: 'email',
    notes: `Contact details need checking: the number entered at online booking (${payload.phone}) is already on another client record. Use the verified email for this booking. Confirm the details with the client before linking records or moving their phone number.`,
    preferences: {
      booking_contact_review: 'pending',
      booking_supplied_phone: payload.phone,
      booking_phone_match_id: phoneMatch.data.id,
    },
  });
  if (!isolated.error && isolated.data) return found(isolated.data, true);
  if (isolated.error?.code === '23505') {
    const raced = await byEmail();
    if (raced.error) return unavailable(raced.error, 'isolated_concurrent_lookup');
    if (raced.data) return found(raced.data);
  }
  return unavailable(isolated.error, 'isolated_insert');
}
