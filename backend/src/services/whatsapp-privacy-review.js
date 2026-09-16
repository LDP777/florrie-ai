import { supabase } from '../config.js';

// The job runner records and alerts on failures. Pending manual cleanup must
// remain visible to the operator instead of disappearing into a receipt table.
export async function reviewWhatsAppDataRequests() {
  const { data, error } = await supabase.from('whatsapp_privacy_requests')
    .select('id').eq('status','needs_review').limit(1);
  if (error || !Array.isArray(data)) throw new Error('WhatsApp privacy request queue could not be checked');
  if (data.length) throw new Error('WhatsApp privacy requests need operator review. Check the private privacy request queue.');
  return { pending: 0 };
}
