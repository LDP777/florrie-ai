import { randomUUID } from 'node:crypto';
import { supabase } from '../config.js';

const LEASE_MS = 10 * 60 * 1000;

// A completed timestamp means the consumer finished, not merely received the event.
// Pending claims expire so a process crash cannot permanently consume an event.
export async function claimPaymentEvent(event) {
  const claim = { token: randomUUID(), claimed_at: new Date().toISOString() };
  const data = { ...event, payment_claim: claim };
  const { error } = await supabase.from('stripe_events').insert({
    id: event.id, type: event.type, data, processed_at: null,
  });
  if (!error) return claim;
  if (error.code !== '23505') throw error;

  const { data: existing, error: readError } = await supabase.from('stripe_events')
    .select('processed_at, data').eq('id', event.id).maybeSingle();
  if (readError) throw readError;
  if (existing?.processed_at) return { duplicate: true };
  const previous = existing?.data?.payment_claim;
  const age = Date.now() - Date.parse(previous?.claimed_at);
  if (!previous?.token || !Number.isFinite(age) || age < LEASE_MS) {
    throw new Error('Payment event is already processing');
  }
  const { data: reclaimed, error: reclaimError } = await supabase.from('stripe_events')
    .update({ data }).eq('id', event.id).eq('data->payment_claim->>token', previous.token)
    .is('processed_at', null).select('id');
  if (reclaimError) throw reclaimError;
  if (!reclaimed?.length) throw new Error('Payment event claim changed');
  return claim;
}

export async function completePaymentEvent(event, claim) {
  const { data, error } = await supabase.from('stripe_events')
    .update({ processed_at: new Date().toISOString() })
    .eq('id', event.id).eq('data->payment_claim->>token', claim.token).select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('Payment event claim was lost');
}

export async function releasePaymentEvent(event, claim) {
  const { error } = await supabase.from('stripe_events').update({
    data: { ...event, payment_claim: { ...claim, claimed_at: new Date(0).toISOString() } },
  })
    .eq('id', event.id).eq('data->payment_claim->>token', claim.token).is('processed_at', null);
  if (error) throw error;
}
