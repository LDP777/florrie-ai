import { beforeEach, describe, expect, it, vi } from 'vitest';
process.env.STRIPE_SECRET_KEY='sk_test_cancellation_fixture';
const state=vi.hoisted(()=>({tables:{},creates:[],retrieves:[],response:null,failAnchor:false,failReceipt:false,failRequest:false,nextId:0}));
vi.mock('../../src/config.js',()=>({supabase:{from(table){
  let mutation=null;const filters=[];const value=(r,k)=>k.split(/->>?/).reduce((v,p)=>v?.[p],r);
  const run=()=>{
    const rows=state.tables[table] ||= [];
    if(mutation?.kind==='insert'){
      if(mutation.row.id && rows.some(r=>r.id===mutation.row.id))return {data:null,error:{code:'23505'}};
      const row={id:'row-'+(++state.nextId),created_at:new Date().toISOString(),...mutation.row};rows.push(row);return {data:[row],error:null};
    }
    const matches=rows.filter(r=>filters.every(f=>f(r)));
    if(mutation?.kind==='update'){
      if(table==='appointments' && mutation.row.policy_fee_charged_at && state.failAnchor){state.failAnchor=false;return {data:null,error:{message:'write failed'}};}
      if(table==='ai_actions' && mutation.row.details?.request && state.failRequest){state.failRequest=false;return {data:null,error:{message:'write failed'}};}
      for(const row of matches)Object.assign(row,mutation.row);
    }
    return {data:matches.map(r=>structuredClone(r)),error:null};
  };
  const b={select(){return b;},insert(row){mutation={kind:'insert',row};return b;},update(row){mutation={kind:'update',row};return b;},
    eq(k,v){filters.push(r=>String(value(r,k))===String(v));return b;},in(k,v){filters.push(r=>v.includes(value(r,k)));return b;},gte(k,v){filters.push(r=>value(r,k)>=v);return b;},
    order(){return b;},limit(){return b;},maybeSingle(){const r=run();return Promise.resolve({...r,data:r.data?.[0]||null});},
    then(resolve,reject){return Promise.resolve(run()).then(resolve,reject);}};return b;
}}}));
vi.mock('stripe',()=>({default:class {constructor(){
  this.paymentMethods={list:async()=>({data:[{id:'pm_saved'}]})};
  this.paymentIntents={
    create:async(params,options)=>{state.creates.push(structuredClone({params,options}));if(state.response instanceof Error)throw state.response;return state.response;},
    retrieve:async id=>{state.retrieves.push(id);if(state.response instanceof Error)throw state.response;return state.response;},
  };
}}}));
vi.mock('../../src/lib/payment-receipt.js',()=>({insertPaymentReceipt:async(db,row)=>{
  if(state.failReceipt){state.failReceipt=false;return {error:{message:'receipt failed'}};}
  const rows=state.tables.transactions;
  if(!rows.some(r=>r.stripe_payment_intent_id===row.stripe_payment_intent_id))rows.push(row);
  return {error:null};
}}));
vi.mock('../../src/lib/logger.js',()=>({default:{info(){},warn(){},error(){},debug(){}}}));
vi.mock('@sentry/node',()=>({captureException(){},captureMessage(){}}));
const {queueClientCancellationFee,settleClientCancellationFee,attemptClientCancellationFee,retryClientCancellationFees}=await import('../../src/services/client-cancellation-fee.js');
const {computePolicyFee}=await import('../../src/services/policy-fees.js');
const appointment=()=>state.tables.appointments[0];
const intent=()=>state.tables.ai_actions.find(r=>r.action_type==='client_cancellation_fee');
const queue=async()=>{await queueClientCancellationFee(appointment(),2500);appointment().status='cancelled';};
beforeEach(()=>{
  state.tables={appointments:[{id:'a1',beautician_id:'b1',client_id:'c1',status:'confirmed',cancelled_at:'2026-11-14T17:00:00Z',price_cents:3500,deposit_cents:700,deposit_amount_cents:1000,deposit_paid:true,
    policy_snapshot:{late_cancel_charge_percent:100},stripe_payment_method_id:'pm_saved',clients:{id:'c1',first_name:'Demo',stripe_customer_id:'cus_demo'},
    beauticians:{id:'b1',stripe_account_id:'acct_demo',stripe_onboarding_complete:true}}],ai_actions:[],transactions:[]};
  state.creates=[];state.retrieves=[];state.response={id:'pi_demo',status:'succeeded'};state.failAnchor=false;state.failReceipt=false;state.failRequest=false;state.nextId=0;
});
describe('prospective late-cancellation payment recovery',()=>{
  it('never charges a staged request activated by a different cancellation',async()=>{
    appointment().cancelled_at=null;await queue();appointment().cancelled_at='2026-11-14T18:00:00Z';
    await retryClientCancellationFees();expect(state.creates).toHaveLength(0);
    intent().details.cancelled_at='2026-11-14T17:00:00Z';await retryClientCancellationFees();expect(state.creates).toHaveLength(0);
  });
  it('credits the actual deposit and a payment in full, not the configured deposit estimate',()=>{
    expect(computePolicyFee(appointment(),{late_cancel_charge_percent:100},'late_cancel').feeCents).toBe(2500);
    expect(computePolicyFee({...appointment(),payment_type:'full'},{late_cancel_charge_percent:100},'late_cancel').feeCents).toBe(0);
    expect(computePolicyFee({...appointment(),payment_type:'full',deposit_paid:false},{late_cancel_charge_percent:100},'late_cancel').feeCents).toBe(3500);
  });
  it('recovers after cancellation, records one payment and does not repeat it',async()=>{
    await queue();await retryClientCancellationFees();await retryClientCancellationFees();await settleClientCancellationFee('a1');
    expect(state.creates).toHaveLength(1);expect(state.creates[0].params.amount).toBe(2500);expect(intent().outcome).toBe('success');expect(state.tables.transactions).toHaveLength(1);
  });
  it('returns a pending receipt promptly while a slow provider finishes the durable attempt',async()=>{
    await queue();let finish;
    state.response=new Promise(resolve=>{finish=resolve;});
    const result=await attemptClientCancellationFee('a1',{budgetMs:10});
    expect(result).toEqual({charged:false,pending:true,reason:'awaiting_confirmation'});
    expect(appointment().status).toBe('cancelled');expect(appointment().policy_fee_charged_at).toBeUndefined();
    expect(intent().outcome).toBe('pending');expect(state.tables.transactions).toEqual([]);
    expect(intent().details.request).toMatchObject({params:{amount:2500}});
    finish({id:'pi_demo',status:'succeeded'});
    await vi.waitFor(()=>expect(intent().outcome).toBe('success'));
    await retryClientCancellationFees();expect(state.creates).toHaveLength(1);expect(state.tables.transactions).toHaveLength(1);
  });
  it('retries an unknown network result with the exact stored request and key despite later edits',async()=>{
    await queue();state.response=Object.assign(new Error('connection lost'),{type:'StripeConnectionError'});
    await settleClientCancellationFee('a1');expect(intent().outcome).toBe('pending');
    appointment().price_cents=9900;appointment().stripe_payment_method_id='pm_changed';appointment().clients.first_name='Changed';
    state.response={id:'pi_demo',status:'succeeded'};await retryClientCancellationFees();
    expect(state.creates).toHaveLength(2);expect(state.creates[1]).toEqual(state.creates[0]);expect(state.tables.transactions[0].amount_cents).toBe(2500);
  });
  it('does not report processing as paid; reconciles the known intent without another create',async()=>{
    await queue();state.response={id:'pi_demo',status:'processing'};const result=await settleClientCancellationFee('a1');
    expect(result).toMatchObject({charged:false,pending:true});expect(appointment().policy_fee_charged_at).toBeUndefined();expect(state.tables.transactions).toEqual([]);
    state.response={id:'pi_demo',status:'succeeded'};await retryClientCancellationFees();
    expect(state.creates).toHaveLength(1);expect(state.retrieves).toEqual(['pi_demo']);expect(state.tables.transactions).toHaveLength(1);
  });
  it('does not duplicate the payment or receipt when a webhook completes it before the retry',async()=>{
    await queue();state.response={id:'pi_demo',status:'processing'};await settleClientCancellationFee('a1');
    appointment().policy_fee_charged_at=new Date().toISOString();
    state.tables.transactions.push({stripe_payment_intent_id:'pi_demo',amount_cents:2500});
    state.response={id:'pi_demo',status:'succeeded'};await retryClientCancellationFees();
    expect(state.creates).toHaveLength(1);expect(state.tables.transactions).toHaveLength(1);expect(intent().outcome).toBe('success');
  });
  it('sends a declined card to owner review without repeated automatic attempts',async()=>{
    await queue();state.response=Object.assign(new Error('declined'),{type:'StripeCardError',code:'card_declined'});
    await settleClientCancellationFee('a1');await retryClientCancellationFees();await settleClientCancellationFee('a1');
    expect(intent().outcome).toBe('escalated');expect(state.creates).toHaveLength(1);expect(state.tables.transactions).toEqual([]);
  });
  it('does not reuse an expired idempotency key when the provider outcome is unknown',async()=>{
    await queue();state.response=new Error('network timeout');await settleClientCancellationFee('a1');
    intent().details.request.firstAttemptAt=new Date(Date.now()-24*3600000).toISOString();
    await retryClientCancellationFees();expect(state.creates).toHaveLength(1);expect(intent()).toMatchObject({outcome:'escalated',details:{result:{reason:'idempotency_expired'}}});
  });
  it('does not start a stale, previously unattempted fee or charge any historic cancellation',async()=>{
    appointment().status='cancelled';await retryClientCancellationFees();expect(state.creates).toEqual([]);
    await queue();intent().details.queued_at=new Date(Date.now()-2*3600000).toISOString();await retryClientCancellationFees();
    expect(state.creates).toEqual([]);expect(intent().outcome).toBe('escalated');
  });
  it('flags a missing card for the owner and stops automatic attempts',async()=>{
    await queue();appointment().clients.stripe_customer_id=null;appointment().stripe_payment_method_id=null;
    const result=await settleClientCancellationFee('a1');await retryClientCancellationFees();
    expect(result).toMatchObject({charged:false,needsReview:true,reason:'no_card_on_file'});
    expect(state.creates).toEqual([]);expect(intent().outcome).toBe('escalated');
  });
  it.each(['failAnchor','failReceipt'])('repairs %s after payment without another charge',async field=>{
    await queue();state[field]=true;await settleClientCancellationFee('a1');expect(intent().outcome).toBe('pending');
    await retryClientCancellationFees();expect(state.creates).toHaveLength(1);expect(state.retrieves).toEqual(['pi_demo']);expect(intent().outcome).toBe('success');expect(state.tables.transactions).toHaveLength(1);
  });
  it('does not call Stripe before its exact request is stored',async()=>{
    await queue();state.failRequest=true;await settleClientCancellationFee('a1');expect(state.creates).toEqual([]);
    await retryClientCancellationFees();expect(state.creates).toHaveLength(1);
  });
});
