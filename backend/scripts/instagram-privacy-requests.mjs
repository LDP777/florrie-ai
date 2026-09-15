// Operator queue. Never marks a request complete unless the operator supplies
// an evidence reference after reviewing and fulfilling the actual data request.
import { supabase } from '../src/config.js';
const args = process.argv.slice(2);
if (!args.length || args[0] === 'list') {
  const { data, error } = await supabase.from('instagram_privacy_requests')
    .select('id,beautician_ids,issued_at,requested_at,status').eq('action','delete')
    .eq('status','needs_review').order('requested_at');
  if (error) throw new Error('Instagram privacy queue unavailable');
  console.log(JSON.stringify(data, null, 2));
} else if (args[0] === 'complete' && /^[0-9a-f-]{36}$/i.test(args[1] || '')
  && args[2] === '--evidence' && args[3]?.length >= 3 && args[3].length <= 200
  && args[4] === '--confirm-cleanup-finished' && args.length === 5) {
  const { error } = await supabase.rpc('confirm_instagram_data_cleanup', { p_request_id: args[1], p_reference: args[3] });
  if (error) throw new Error('Cleanup confirmation was not saved');
  console.log('Recorded completed cleanup and updated the request status.');
} else {
  throw new Error('Usage: node backend/scripts/instagram-privacy-requests.mjs list | complete UUID --evidence TICKET --confirm-cleanup-finished');
}
