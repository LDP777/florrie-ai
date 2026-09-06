import { supabase } from '../config.js';

// Called only after Stripe signature verification. An unreadable tombstone is
// a retryable webhook failure, never permission to resume account activity.
export async function discardDeletedAccountEvent(event, db = supabase) {
  const { data, error } = await db.rpc('is_deleted_account_event', { p_event: event });
  if (error) throw error;
  if (typeof data !== 'boolean') throw new Error('Account deletion status unavailable');
  if (!data) return false;
  const { error: writeError } = await db.from('stripe_events').upsert({
    id: event.id, type: event.type, data: { account_deleted: true },
    processed_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (writeError) throw writeError;
  return true;
}
