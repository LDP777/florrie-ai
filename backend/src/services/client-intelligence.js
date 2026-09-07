import { supabase } from '../config.js';
import { intelligenceId, visitPatterns } from '../lib/client-learning.js';
import { nowInSalonWall } from '../lib/free-slots.js';

/** Recompute derived visit patterns. Existing notes and clinical fields are untouched. */
export async function updateClientIntelligence(beauticianId, clientId, { db = supabase, timezone = 'Europe/London' } = {}) {
  const [{data: appointments,error: appointmentError},{data: existing,error: existingError}] = await Promise.all([
    db.from('appointments').select('id,starts_at,ends_at,treatment_id,price_cents,status')
      .eq('beautician_id',beauticianId).eq('client_id',clientId).eq('status','completed').order('starts_at',{ascending:true}),
    db.from('client_intelligence').select('id').eq('beautician_id',beauticianId).eq('client_id',clientId).limit(2),
  ]);
  if(appointmentError || existingError) throw new Error('Could not read client history for learning');
  if(existing?.length>1) throw new Error('Duplicate intelligence records need review');
  const {visits,...patterns}=visitPatterns(appointments||[],nowInSalonWall(timezone));
  const id=existing?.[0]?.id || intelligenceId(beauticianId,clientId);
  const {error}=await db.from('client_intelligence').upsert({id,beautician_id:beauticianId,client_id:clientId,...patterns,updated_at:new Date().toISOString()},{onConflict:'id'});
  if(error)throw new Error('Could not save client intelligence');
  return {total_visits:visits,avg_booking_gap_days:patterns.rebooking_rhythm_days,next_predicted_visit:patterns.next_predicted_visit,...patterns};
}

/** Bounded passes favour never-learned clients, then changed and old profiles. */
export async function refreshAllIntelligence(beauticianId, {limit=50, timezone='Europe/London'}={}) {
  const [clientsResult, profilesResult, appointmentsResult] = await Promise.all([
    supabase.from('clients').select('id').eq('beautician_id',beauticianId).is('archived_at',null).is('blocked_at',null).order('id').limit(1000),
    supabase.from('client_intelligence').select('client_id,updated_at').eq('beautician_id',beauticianId).limit(1000),
    supabase.from('appointments').select('client_id,ends_at').eq('beautician_id',beauticianId).eq('status','completed').order('ends_at',{ascending:false}).limit(5000),
  ]);
  if([clientsResult,profilesResult,appointmentsResult].some(r=>r.error))throw new Error('Could not read client learning sources');
  const profiles=new Map((profilesResult.data||[]).map(p=>[p.client_id,Date.parse(p.updated_at)||0]));
  const latest=new Map();
  for(const appointment of appointmentsResult.data||[])if(!latest.has(appointment.client_id))latest.set(appointment.client_id,Date.parse(appointment.ends_at)||0);
  const due=(clientsResult.data||[]).filter(c=>latest.has(c.id) && (!profiles.has(c.id) || profiles.get(c.id)<latest.get(c.id) || profiles.get(c.id)<Date.now()-86400000))
    .sort((a,b)=>(profiles.get(a.id)||0)-(profiles.get(b.id)||0)).slice(0,limit);
  let completed=0;let failed=0;
  for(const client of due) {
    try { await updateClientIntelligence(beauticianId,client.id,{timezone});completed++; }
    catch {failed++;}
  }
  if(failed)throw new Error(`Client learning failed for ${failed} profiles; ${completed} saved`);
  return {count:due.length,completed};
}

export async function runClientIntelligenceRefresh() {
  const {data,error}=await supabase.from('beauticians').select('id,timezone').order('id').limit(500);
  if(error)throw new Error('Could not read owners for client learning');
  let completed=0;let failed=0;
  for(const owner of data||[]) {
    try {completed+=(await refreshAllIntelligence(owner.id,{timezone:owner.timezone||'Europe/London'})).completed;}
    catch {failed++;}
  }
  if(failed)throw new Error(`Client learning could not finish for ${failed} owners`);
  return {completed};
}
