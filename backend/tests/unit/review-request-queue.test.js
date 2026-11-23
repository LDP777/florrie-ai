import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const state = vi.hoisted(()=>({db:{},calls:[],send:vi.fn(),verdict:{},failure:null,guard:vi.fn()}));
const value=(r,c)=>c.includes('->>') ? String(r[c.split('->>')[0]]?.[c.split('->>')[1]] ?? '') : r[c];
function builder(table) {
  const filters=[];let op=null, payload,maximum=Infinity,sort=null,offset=0;
  const q={select(){return q;},eq(c,v){filters.push(r=>value(r,c)===v);return q;},in(c,v){filters.push(r=>v.includes(value(r,c)));return q;},gte(c,v){filters.push(r=>value(r,c)>=v);return q;},lte(c,v){filters.push(r=>value(r,c)<=v);return q;},not(c,op,v){filters.push(r=>value(r,c)!==v && value(r,c)!=='');return q;},range(a,b){offset=a;maximum=b-a+1;return q;},order(c,opts={}){sort=[c,opts.ascending!==false];return q;},limit(n){maximum=n;return q;},insert(p){op='insert';payload=p;return q;},update(p){op='update';payload=p;return q;},maybeSingle(){return settle().then(r=>({...r,data:r.error?null:r.data?.[0]||null}));},then(a,b){return settle().then(a,b);}};
  async function settle(){
    state.calls.push({table,op,payload});
    if (state.failure?.(table,op,payload)) return {error:{message:'database unavailable'},data:null};
    const rows=state.db[table] ||= [];
    if(op==='insert') {
      if(rows.some(r=>r.id===payload.id))return {error:{code:'23505'}};
      rows.push({...structuredClone(payload),created_at:new Date().toISOString()});return {data:[],error:null};
    }
    let selected=rows.filter(r=>filters.every(f=>f(r)));
    if(sort)selected.sort((a,b)=>String(value(a,sort[0])).localeCompare(String(value(b,sort[0])))*(sort[1]?1:-1));
    selected=selected.slice(offset,offset+maximum);
    if(op==='update')for(const r of selected)Object.assign(r,structuredClone(payload));
    return {data:structuredClone(selected),error:null};
  }
  return q;
}
vi.mock('../../src/config.js',()=>({supabase:{from:builder}}));
vi.mock('../../src/services/messaging.js',()=>({sendOnChannel:(args)=>state.send(args)}));
vi.mock('../../src/lib/outbound-guard.js',()=>({evaluateOutbound:args=>{state.guard(args);return state.verdict;},recordOutbound:async args=>{const id=`out-${state.db.outbound_sends.length}`;state.db.outbound_sends.push({id,beautician_id:args.beauticianId,client_id:args.clientId,status:args.status,reason:args.reason});return id;}}));
const {scheduleReviewRequest,processReviewRequests,listReviewRequests,beginReviewApproval,finishReviewApproval,reviewChannel,scheduleCompletedReviewVisits}=await import('../../src/services/review-requests.js');
const now=Date.parse('2026-11-16T14:00:00Z');
function appt(overrides={}){return {id:'a1',beautician_id:'b1',client_id:'c1',status:'completed',starts_at:'2026-11-16T11:00:00Z',ends_at:'2026-11-16T12:00:00Z',clients:{id:'c1',beautician_id:'b1',first_name:'Test',phone:'fictional',preferred_channel:'sms',marketing_consent:true,marketing_opted_out_at:null},beauticians:{id:'b1',business_name:'Demo',timezone:'Europe/London',subscription_status:'active',google_review_link:'https://g.page/r/test/review'},treatments:{name:'Brows'},...overrides};}
async function queue(){await scheduleReviewRequest('b1','a1','c1');vi.setSystemTime(now+2*3600000+1);return state.db.ai_actions[0];}
beforeEach(()=>{vi.useFakeTimers({now,toFake:['Date']});state.db={beauticians:[],ai_actions:[],appointments:[appt()],outbound_sends:[],messages:[]};state.calls=[];state.failure=null;state.verdict={decision:'send',reason:'trusted_auto'};state.send.mockReset().mockResolvedValue({ok:true});state.guard.mockClear();});
afterEach(()=>vi.useRealTimers());

describe('new owner-confirmed review requests',()=>{
  it('delays two hours and records a pending outcome separately from queue status',async()=>{await scheduleReviewRequest('b1','a1','c1');expect(state.db.ai_actions[0]).toMatchObject({status:'scheduled',outcome:'pending',details:{version:'owner-completed-v2',send_at:'2026-11-16T16:00:00.000Z'}});expect((await processReviewRequests()).sent).toBe(0);});
  it('deduplicates concurrent completion requests using the appointment key',async()=>{await Promise.all([scheduleReviewRequest('b1','a1','c1'),scheduleReviewRequest('b1','a1','c1')]);expect(state.db.ai_actions).toHaveLength(1);expect(state.db.ai_actions[0].id).toMatch(/^[a-f0-9-]{36}$/);});
  it('holds another request for the same client within seven days',async()=>{state.db.ai_actions.push({id:'previous',beautician_id:'b1',client_id:'c1',action_type:'review_requested',created_at:new Date().toISOString()});await scheduleReviewRequest('b1','a1','c1');expect(state.db.ai_actions).toHaveLength(1);});
  it.each(['confirmed','cancelled','no_show'])('does not schedule %s appointments',async status=>{state.db.appointments[0].status=status;expect(await scheduleReviewRequest('b1','a1','c1')).toEqual({scheduled:false});});
  it.each(['2026-11-01T12:00:00Z','2026-11-17T12:00:00Z'])('does not turn old or future visits into messages: %s',async starts_at=>{state.db.appointments[0].starts_at=starts_at;await scheduleReviewRequest('b1','a1','c1');expect(state.db.ai_actions).toHaveLength(0);});
  it('schedules an owner-confirmed treatment that finishes before its estimated end',async()=>{state.db.appointments[0].ends_at='2026-11-16T14:30:00Z';expect(await scheduleReviewRequest('b1','a1','c1')).toEqual({scheduled:true});});
  it('reports claim-storage errors without attempting a send',async()=>{await queue();state.failure=(t,op,p)=>t==='ai_actions'&&op==='update'&&p.status==='processing';await expect(processReviewRequests()).rejects.toBeTruthy();expect(state.send).not.toHaveBeenCalled();});
  it('fails closed on an unreadable dedup check',async()=>{state.failure=(t,op)=>t==='ai_actions'&&!op;await expect(scheduleReviewRequest('b1','a1','c1')).rejects.toBeTruthy();expect(state.db.ai_actions).toHaveLength(0);});
  it('does not replay legacy requests',async()=>{state.db.ai_actions.push({id:'old',action_type:'review_requested',status:'scheduled',details:{send_at:'2026-01-01T00:00:00Z'}});await processReviewRequests();expect(state.send).not.toHaveBeenCalled();expect(state.db.ai_actions[0].status).toBe('scheduled');});
});
describe('delivery and approval safety',()=>{
  it('two workers make one provider call; no second email accompanies it',async()=>{await queue();state.db.appointments[0].clients.email='fictional@example.test';await Promise.all([processReviewRequests(),processReviewRequests()]);expect(state.send).toHaveBeenCalledTimes(1);expect(state.send.mock.calls[0][0].channel).toBe('sms');expect(state.db.ai_actions[0].details.delivery_state).toBe('sent');expect(state.guard).toHaveBeenCalledWith(expect.objectContaining({confirmedReviewVisit:true}));});
  it.each(['cancelled','no_show'])('rechecks %s visits when due',async status=>{await queue();state.db.appointments[0].status=status;await processReviewRequests();expect(state.send).not.toHaveBeenCalled();expect(state.db.ai_actions[0].details.reason).toBe('visit_not_eligible');});
  it('rejects a client belonging to another salon',async()=>{await queue();state.db.appointments[0].clients.beautician_id='other';await processReviewRequests();expect(state.guard).not.toHaveBeenCalled();});
  it('holds paused salons without contacting anyone',async()=>{await queue();state.db.appointments[0].beauticians.client_reminder_prefs={paused:true};await processReviewRequests();expect(state.send).not.toHaveBeenCalled();expect(state.db.ai_actions[0].details.reason).toBe('salon_paused');});
  it('defers quiet hours without generating an approval or a provider call',async()=>{await queue();state.verdict={decision:'block',reason:'quiet_hours'};await processReviewRequests();expect(state.db.ai_actions[0].status).toBe('scheduled');expect(state.db.outbound_sends).toHaveLength(0);expect(state.send).not.toHaveBeenCalled();});
  it('expires requests instead of catching up days later',async()=>{await queue();vi.setSystemTime(now+49*3600000);await processReviewRequests();expect(state.db.ai_actions[0].details.reason).toBe('expired');expect(state.send).not.toHaveBeenCalled();});
  it('does not switch away from a missing preferred channel',()=>{expect(reviewChannel({preferred_channel:'email',phone:'fictional'})).toBe(null);});
  it('does not send outside an Instagram reply window',async()=>{await queue();Object.assign(state.db.appointments[0].clients,{preferred_channel:'instagram',instagram_id:'fake'});await processReviewRequests();expect(state.db.ai_actions[0].details.reason).toBe('channel_window_closed');expect(state.send).not.toHaveBeenCalled();});
  it('creates one approval and follows its confirmed send result',async()=>{const action=await queue();state.verdict={decision:'approve',reason:'awaiting_approval'};await processReviewRequests();await processReviewRequests();expect(state.db.outbound_sends).toHaveLength(1);expect(state.send).not.toHaveBeenCalled();expect((await listReviewRequests('b1')).requests[0].state).toBe('approval');const claimed=await beginReviewApproval('b1',action.details.outbound_id);await finishReviewApproval(claimed,true);expect((await listReviewRequests('b1')).requests[0].state).toBe('sent');});
  it('rechecks cancelled visits before approval',async()=>{const action=await queue();state.verdict={decision:'approve'};await processReviewRequests();state.db.appointments[0].status='no_show';await expect(beginReviewApproval('b1',action.details.outbound_id)).rejects.toThrow('no longer eligible');expect(state.db.ai_actions[0].details.delivery_state).toBe('held');});
  it('does not mistake Outbox’s optimistic claim for a sent message',async()=>{await queue();state.verdict={decision:'approve'};await processReviewRequests();state.db.outbound_sends[0].status='sent';expect((await listReviewRequests('b1')).requests[0].state).toBe('unconfirmed');});
  it('an uncertain provider result is visible and never automatically retried',async()=>{await queue();state.send.mockRejectedValue(new Error('timeout'));await processReviewRequests();await processReviewRequests();expect(state.send).toHaveBeenCalledTimes(1);expect((await listReviewRequests('b1')).requests[0].state).toBe('unconfirmed');});
  it('a status-write failure after a send never restores the queue',async()=>{await queue();state.failure=(t,op,p)=>t==='ai_actions'&&op==='update'&&p.status==='executed';await processReviewRequests();await processReviewRequests();expect(state.send).toHaveBeenCalledTimes(1);expect(state.db.ai_actions[0].status).toBe('processing');vi.setSystemTime(now+3*3600000);expect((await listReviewRequests('b1')).requests[0].state).toBe('unconfirmed');});
  it('a status-write failure after creating an approval never queues a duplicate draft',async()=>{await queue();state.verdict={decision:'approve'};state.failure=(t,op,p)=>t==='ai_actions'&&op==='update'&&p.status==='executed';await processReviewRequests();await processReviewRequests();expect(state.db.outbound_sends).toHaveLength(1);});
  it('never exposes a foreign client name through a forged action reference',async()=>{await queue();state.db.ai_actions[0].clients={beautician_id:'foreign',first_name:'Private name'};expect((await listReviewRequests('b1')).requests[0].client_name).toBe('Client');});
  it('status reads are tenant isolated, including linked outbound rows',async()=>{await queue();await processReviewRequests();expect((await listReviewRequests('other')).requests).toEqual([]);});
});


describe('future diary review opt-in',()=>{
  function enable(since='2026-11-16T10:00:00Z') {
    const visit=state.db.appointments[0];
    visit.completed_at='2026-11-16T12:00:00Z';
    visit.beauticians.autonomy={review_request:'ask',review_request_started_at:since};
    state.db.beauticians=[visit.beauticians];
    return visit;
  }
  it('leaves every existing salon unchanged until explicitly enabled',async()=>{
    expect(await scheduleCompletedReviewVisits()).toEqual({scheduled:0});expect(state.db.ai_actions).toHaveLength(0);
  });
  it('recovers an enqueue failure, creates one request and waits for approval',async()=>{
    enable();state.failure=(t,op)=>t==='ai_actions'&&op==='insert';
    await expect(scheduleCompletedReviewVisits()).rejects.toBeTruthy();
    state.failure=null;expect((await scheduleCompletedReviewVisits()).scheduled).toBe(1);
    expect((await scheduleCompletedReviewVisits()).scheduled).toBe(0);
    state.verdict={decision:'approve',reason:'awaiting_approval'};await processReviewRequests();
    expect(state.db.ai_actions[0].details).toMatchObject({source:'diary',delivery_state:'approval',send_at:'2026-11-16T14:00:00.000Z'});
    expect(state.send).not.toHaveBeenCalled();
  });
  it('does not catch up appointments that started before activation',async()=>{
    enable('2026-11-16T11:30:00Z');expect((await scheduleCompletedReviewVisits()).scheduled).toBe(0);
  });
  it('also applies future-only activation to manual completion and old pending requests',async()=>{
    await queue();
    enable('2026-11-16T13:00:00Z');
    expect(await scheduleReviewRequest('b1','a1','c1')).toEqual({scheduled:false});
    await processReviewRequests();expect(state.send).not.toHaveBeenCalled();
    expect(state.db.ai_actions[0].details.reason).toBe('visit_not_eligible');
  });
  it.each(['off','paused','missing_link','future_completion','future_end','patch_test'])('does not queue %s visits',async reason=>{
    const visit=enable();
    if(reason==='off') visit.beauticians.autonomy.review_request='off';
    if(reason==='paused') visit.beauticians.client_reminder_prefs={paused:true};
    if(reason==='missing_link') visit.beauticians.google_review_link=null;
    if(reason==='future_completion') visit.completed_at='2026-11-17T12:00:00Z';
    if(reason==='future_end') visit.ends_at='2026-11-17T12:00:00Z';
    if(reason==='patch_test') visit.treatments.name='Patch test';
    expect((await scheduleCompletedReviewVisits()).scheduled).toBe(0);
  });
  it('applies the activation boundary in salon wall time in summer',async()=>{
    vi.setSystemTime('2026-06-16T14:00:00Z');const visit=enable('2026-06-16T10:30:00Z');
    Object.assign(visit,{starts_at:'2026-06-16T11:00:00Z',ends_at:'2026-06-16T12:00:00Z',completed_at:'2026-06-16T11:00:00Z'});
    expect((await scheduleCompletedReviewVisits()).scheduled).toBe(0);
    visit.starts_at='2026-06-16T11:45:00Z';expect((await scheduleCompletedReviewVisits()).scheduled).toBe(1);
  });
  it('rechecks the opt-in before a pending request sends',async()=>{
    const visit=enable();await scheduleCompletedReviewVisits();visit.beauticians.autonomy.review_request='off';
    await processReviewRequests();expect(state.db.ai_actions[0].details.reason).toBe('visit_or_permission_changed');expect(state.send).not.toHaveBeenCalled();
  });
  it('holds missing or changed Google destinations rather than sending generic feedback',async()=>{
    await queue();state.db.appointments[0].beauticians.google_review_link=null;
    await processReviewRequests();expect(state.db.ai_actions[0].details.reason).toBe('review_link_missing');expect(state.send).not.toHaveBeenCalled();
  });
  it('refuses approval if the destination changed after the draft was created',async()=>{
    const action=await queue();state.verdict={decision:'approve'};await processReviewRequests();
    state.db.appointments[0].beauticians.google_review_link='https://g.page/r/different/review';
    await expect(beginReviewApproval('b1',action.details.outbound_id)).rejects.toThrow('no longer eligible');expect(state.send).not.toHaveBeenCalled();
  });
  it('paginates completed visits beyond the first 200',async()=>{
    const original=enable();state.db.appointments=Array.from({length:201},(_,i)=>({...structuredClone(original),id:`a-${String(i).padStart(3,'0')}`,client_id:`c-${i}`,clients:{...original.clients,id:`c-${i}`}}));
    expect((await scheduleCompletedReviewVisits()).scheduled).toBe(201);expect(state.db.ai_actions).toHaveLength(201);expect(state.send).not.toHaveBeenCalled();
  });
});
