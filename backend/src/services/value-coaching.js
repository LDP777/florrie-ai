import { supabase } from '../config.js';
import { businessInsights } from '../lib/business-insights.js';
import { nowInSalonWall } from '../lib/free-slots.js';

/** Weekly, evidence-backed coaching. No customer messages or price changes. */
export async function runValueCoaching() {
  const {data: owners,error}=await supabase.from('beauticians').select('id,timezone').limit(500);
  if(error)throw new Error('Could not read owners for coaching');
  let generated=0;let failed=0;
  for(const owner of owners||[]) {
    try {
      const since=new Date(Date.now()-7*86400000).toISOString();
      const {data: existing,error: readError}=await supabase.from('ai_actions').select('id').eq('beautician_id',owner.id).eq('action_type','value_coaching').contains('details',{evidence_version:2}).gte('created_at',since).limit(1);
      if(readError)throw readError;
      if(existing?.length)continue;
      const now=+nowInSalonWall(owner.timezone||'Europe/London');
      const [appointments,treatments]=await Promise.all([
        supabase.from('appointments').select('id,client_id,treatment_id,starts_at,ends_at,status,price_cents').eq('beautician_id',owner.id).eq('status','completed').gte('starts_at',new Date(now-56*86400000).toISOString()).lte('ends_at',new Date(now).toISOString()).limit(3000),
        supabase.from('treatments').select('id,name,price_cents,is_active').eq('beautician_id',owner.id).eq('is_active',true).limit(300),
      ]);
      if(appointments.error||treatments.error)throw new Error('Could not read coaching evidence');
      const insights=businessInsights(appointments.data,treatments.data,{now});
      if(!insights.length)continue;
      const {error: saveError}=await supabase.from('ai_actions').insert(insights.map(insight=>({beautician_id:owner.id,action_type:'value_coaching',outcome:'success',summary:insight.summary,digital_employee:'scout',details:{coaching_type:insight.type,evidence_version:2,evidence:insight.evidence,link_to:insight.link_to,confidence_kind:insight.confidence},created_at:new Date().toISOString()})));
      if(saveError)throw saveError;
      generated+=insights.length;
    } catch {failed++;}
  }
  if(failed)throw new Error(`Coaching could not finish for ${failed} owners`);
  return {generated};
}
