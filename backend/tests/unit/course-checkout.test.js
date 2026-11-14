import { beforeEach, describe, it, expect, vi } from 'vitest';
const state=vi.hoisted(()=>({rpc:vi.fn(),receipt:vi.fn(),announce:vi.fn(),holds:[],queryCalls:[],checks:[],scopes:[],filters:[]}));
vi.mock('../../src/config.js',()=>({supabase:{rpc:state.rpc,from:()=>{let id;const q={select:()=>q,in:(key,values)=>{state.scopes.push([key,values]);return q;},eq:(key,value)=>{state.filters.push([key,value]);if(key==='id')id=value;return q;},or:expression=>{state.queryCalls.push(['or',expression]);return q;},order:(key,options)=>{state.queryCalls.push(['order',key,options]);return q;},update:patch=>{state.checks.push(patch);return q;},then:resolve=>Promise.resolve({error:null}).then(resolve),limit:async n=>{state.queryCalls.push(['limit',n]);return {data:state.holds,error:null};}};return q;}}}));
vi.mock('../../src/lib/payment-receipt.js',()=>({insertPaymentReceipt:state.receipt}));
vi.mock('../../src/services/course-notice-delivery.js',()=>({deliverCourseNotice:state.announce}));
const {settleCourseCheckout,reconcileCourseHolds,reconcileDueCourseHolds}=await import('../../src/services/course-checkout.js');
const session=()=>({id:'cs_demo',mode:'payment',payment_status:'paid',status:'complete',currency:'gbp',payment_intent:'pi_demo',amount_total:15000,metadata:{type:'course_deposit',enrollment_id:'enrolment-demo',course_id:'course-demo',beautician_id:'salon-demo'}});
beforeEach(()=>{state.rpc.mockReset().mockResolvedValue({data:{changed:true},error:null});state.receipt.mockReset().mockResolvedValue({error:null});state.announce.mockReset().mockResolvedValue();state.holds=[];state.queryCalls=[];state.checks=[];state.scopes=[];state.filters=[];});
describe('Verified course checkout settlement',()=>{
 it('atomically settles, records money, checks durable delivery on repeated payment events',async()=>{await settleCourseCheckout(session());expect(state.rpc).toHaveBeenCalledWith('settle_course_checkout',expect.objectContaining({p_id:'enrolment-demo',p_owner:'salon-demo',p_course:'course-demo',p_session:'cs_demo',p_intent:'pi_demo',p_amount:15000,p_expired:false}));expect(state.receipt).toHaveBeenCalledTimes(1);expect(state.announce).toHaveBeenCalledTimes(1);state.rpc.mockResolvedValue({data:{changed:false}});await settleCourseCheckout(session());expect(state.receipt).toHaveBeenCalledTimes(2);expect(state.announce).toHaveBeenCalledTimes(2);});
 it('surfaces database and receipt failures so webhook claims are retried',async()=>{state.rpc.mockResolvedValue({error:Error('Database failed')});await expect(settleCourseCheckout(session())).rejects.toThrow('Database failed');expect(state.receipt).not.toHaveBeenCalled();state.rpc.mockResolvedValue({data:{changed:true}});state.receipt.mockResolvedValue({error:Error('Receipt failed')});await expect(settleCourseCheckout(session())).rejects.toThrow('Receipt failed');});
 it.each([{payment_status:'unpaid'},{currency:'usd'},{mode:'subscription'},{metadata:{type:'course_deposit'}}])('rejects unconfirmed or incomplete payments %j',async patch=>{await expect(settleCourseCheckout({...session(),...patch})).rejects.toThrow();expect(state.rpc).not.toHaveBeenCalled();});
 it('never frees a payable session from a local expiry check',async()=>{state.holds=[{id:'enrolment-demo',checkout_session_id:'cs_demo',checkout_expires_at:new Date(0).toISOString()}];const stripe={checkout:{sessions:{retrieve:vi.fn().mockResolvedValue({...session(),status:'open',payment_status:'unpaid'})}}};await reconcileCourseHolds(stripe,['course-demo']);expect(state.rpc).not.toHaveBeenCalled();});
 it('finalises a paid session whose webhook was delayed instead of freeing it',async()=>{state.holds=[{id:'enrolment-demo',checkout_session_id:'cs_demo',checkout_expires_at:new Date(0).toISOString()}];const stripe={checkout:{sessions:{retrieve:vi.fn().mockResolvedValue(session())}}};await reconcileCourseHolds(stripe,['course-demo']);expect(state.rpc).toHaveBeenCalledWith('settle_course_checkout',expect.objectContaining({p_expired:false}));});
 it('only an expired provider session releases the place, without receipt or notification',async()=>{await settleCourseCheckout({...session(),status:'expired',payment_status:'unpaid',payment_intent:null},{expired:true});expect(state.rpc).toHaveBeenCalledWith('settle_course_checkout',expect.objectContaining({p_expired:true}));expect(state.receipt).not.toHaveBeenCalled();expect(state.announce).not.toHaveBeenCalled();});
 it('leaves capacity held during provider downtime',async()=>{state.holds=[{id:'enrolment-demo',checkout_session_id:'cs_demo',checkout_expires_at:new Date(0).toISOString()}];const stripe={checkout:{sessions:{retrieve:vi.fn().mockRejectedValue(Error('Provider unavailable'))}}};await expect(reconcileCourseHolds(stripe,['course-demo'])).rejects.toThrow('Provider unavailable');expect(state.rpc).not.toHaveBeenCalled();});
});

it('filters future holds before the batch limit and rotates checked holds behind unvisited rows',async()=>{state.holds=[{id:'old',checkout_session_id:'cs_old',checkout_expires_at:new Date(0).toISOString()}];const stripe={checkout:{sessions:{retrieve:vi.fn().mockResolvedValue({...session(),payment_status:'unpaid',status:'open'})}}};await reconcileCourseHolds(stripe,['course-demo']);expect(state.queryCalls[0]).toEqual(['or',expect.stringMatching(/^checkout_expires_at.is.null,checkout_expires_at.lte./)]);expect(state.queryCalls[1]).toEqual(['order','checkout_checked_at',{ascending:true,nullsFirst:true}]);expect(state.queryCalls.at(-1)).toEqual(['limit',10]);expect(state.checks[0].checkout_checked_at).toBeTruthy();expect(state.rpc).not.toHaveBeenCalled();});

it('records owner attention for an unrecoverable checkout identity without freeing capacity',async()=>{state.holds=[{id:'old',checkout_session_id:null,checkout_payload:null}];const stripe={checkout:{sessions:{retrieve:vi.fn()}}};await reconcileCourseHolds(stripe,['course-demo']);expect(state.checks).toContainEqual({checkout_attention_reason:'session_lookup_required'});expect(state.rpc).not.toHaveBeenCalled();expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();});


it('scheduled recovery includes held places on closed dates without needing a public visit', async () => {
  state.holds = [{ id: 'held-on-closed-date', course_id: 'closed-course', checkout_session_id: 'cs_demo', checkout_expires_at: new Date(0).toISOString() }];
  const stripe = { checkout: { sessions: { retrieve: vi.fn().mockResolvedValue({ ...session(), status: 'expired', payment_status: 'unpaid' }) } } };
  await reconcileDueCourseHolds(stripe);
  expect(state.scopes).toEqual([]);
  expect(state.filters).toContainEqual(['reservation_status', 'held']);
  expect(state.filters.some(([key]) => key === 'status')).toBe(false);
  expect(state.queryCalls.at(-1)).toEqual(['limit', 10]);
  expect(state.rpc).toHaveBeenCalledWith('settle_course_checkout', expect.objectContaining({ p_expired: true }));
});

it('scheduled recovery finishes other due holds before surfacing a failed provider lookup', async () => {
  state.holds = [
    { id: 'bad', checkout_session_id: 'cs_bad', checkout_expires_at: new Date(0).toISOString() },
    { id: 'good', checkout_session_id: 'cs_good', checkout_expires_at: new Date(0).toISOString() },
  ];
  const stripe = { checkout: { sessions: { retrieve: vi.fn(async id => {
    if (id === 'cs_bad') throw Error('Lookup failed');
    await new Promise(resolve => setTimeout(resolve, 5));
    return { ...session(), status: 'expired', payment_status: 'unpaid' };
  }) } } };
  await expect(reconcileDueCourseHolds(stripe)).rejects.toThrow('Lookup failed');
  expect(state.checks.filter(patch => patch.checkout_checked_at)).toHaveLength(2);
  expect(state.rpc).toHaveBeenCalledWith('settle_course_checkout', expect.objectContaining({ p_expired: true }));
});
