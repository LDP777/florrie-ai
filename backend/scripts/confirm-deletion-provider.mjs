// Operator-only: run AFTER actual provider revocation, with a review/ticket reference.
// No tokens or raw provider response bodies belong in the reference.
import { supabase } from '../src/config.js';
const args=process.argv.slice(2);
const value=name=>args[args.indexOf(name)+1];
const id=value('--request'),provider=value('--provider'),reference=value('--reference');
if (!args.includes('--confirm-revoked') || !/^[0-9a-f-]{36}$/i.test(id||'') || !['google','instagram','whatsapp','accounting','stripe_connect','apple','other_identity','sms'].includes(provider) || !reference || reference.length<3 || reference.length>200) {
 throw new Error('Usage: node backend/scripts/confirm-deletion-provider.mjs --request UUID --provider NAME --reference TICKET --confirm-revoked');
}
const {error}=await supabase.rpc('confirm_deletion_provider',{p_deletion_id:id,p_provider:provider,p_reference:reference});
if(error)throw new Error('Provider confirmation was not saved. Check the request and service configuration.');
console.log('Provider evidence saved. The deletion worker will retry remaining cleanup; this does not itself mark deletion complete.');
