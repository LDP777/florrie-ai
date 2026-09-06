import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
vi.mock('../../src/lib/logger.js', () => ({ default: { warn() {}, error() {} } }));
import { createReschedulePayments } from '../../src/services/reschedule-payments.js';
let op, calls, failures, provider, db, service;
beforeEach(() => {
 op = { id:'op1', appointment_id:'appt', beautician_id:'salon', client_id:'client', amount_cents:1000, status:'pending', payment_intent_id:null };
 calls=[]; failures={};
 const appointment={id:'appt',beautician_id:'salon',client_id:'client',deposit_cents:1000,stripe_payment_method_id:'pm1',clients:{stripe_customer_id:'cus1'},beauticians:{stripe_account_id:'acct1',stripe_onboarding_complete:true}};
 db={from(table){
   let update, filters=[];
   const b={ select(){return b;},eq(key,value){filters.push(r=>r[key]===value);return b;},in(key,values){filters.push(r=>values.includes(r[key]));return b;},lt(){return b;},order(key,options){calls.push(`order:${key}:${options.ascending}`);return b;},limit(){return b;},update(values){update=values;return b;},
     single:async()=>({data:table==='appointments'?appointment:{...op},error:failures.read?{message:'offline'}:null}),
     then(resolve){
       if(update){
         if(failures.persist && update.payment_intent_id) return resolve({error:{message:'offline'}});
         if(!filters.every(f=>f(op)))return resolve({data:[],error:null});
         Object.assign(op,update);calls.push('persist');return resolve({data:[{id:op.id}],error:null});
       }
       resolve({data:[{id:op.id}],error:null});
     }}; return b;
 },rpc(name,args){
   const run=async()=>{
     calls.push(name);
     if(name==='prepare_reschedule_payment'){
       if(failures.reassignBeforePrepare) appointment.client_id='different-client';
       const changed=args.p_expected_client!==appointment.client_id || args.p_expected_beautician!==appointment.beautician_id;
       return {data:{...op},error:failures.prepare || changed?{message:'conflict'}:null};
     }
     if(name==='finish_paid_reschedule'){
       if(failures.move)return {error:{message:'slot conflict'}};
       if(op.status!=='pending')return {data:op.status==='complete'};
       op.status='complete';
       if(failures.moveResponse)return {error:{message:'lost response'}};
       return {data:true};
     }
     if(name==='claim_reschedule_refund'){
       if(failures.attachBeforeClaim) op.payment_intent_id='pi1';
       if(['complete','refunded','failed'].includes(op.status))return {data:false};
       op.status='refund_pending';return {data:true};
     }
     if(name==='finish_reschedule_refund'){
       if(failures.refundLedger)return {error:{message:'offline'}};
       op.status='refunded';return {data:null};
     }
     throw Error(name);
   };return {single:run,then(resolve,reject){return run().then(resolve,reject);}};
 }};
 provider={id:'pi1',status:'succeeded',latest_charge:{amount_refunded:0}};
 const stripe={paymentIntents:{
   create:vi.fn(async args=>{calls.push('create');expect(args.confirm).toBe(false);return {id:'pi1',status:'requires_confirmation'};}),
   confirm:vi.fn(async()=>{calls.push('confirm');expect(op.payment_intent_id).toBe('pi1');if(failures.confirm)throw Error('uncertain response');return provider;}),
   retrieve:vi.fn(async()=>({...provider,latest_charge:{...provider.latest_charge}})),
   cancel:vi.fn(async()=>{calls.push('cancel');if(failures.cancel)throw Error('processing');provider.status='canceled';return provider;}),
 },refunds:{list:vi.fn(async()=>({data:provider.latest_charge.amount_refunded ? [{amount:provider.latest_charge.amount_refunded,status:'succeeded'}] : [],has_more:false})),create:vi.fn(async()=>{calls.push('refund');if(failures.refund)throw Error('network');provider.latest_charge.amount_refunded=1000;return {status:'succeeded'};})}};
 service={...createReschedulePayments({db,stripe}),stripe};
});
const perform=()=>service.perform('appt','2027-01-01T10:00:00Z','2027-02-01T10:00:00Z','2027-02-01T11:00:00Z');
describe('durable reschedule compensation',()=>{
 it('persists the PI before confirming and atomically moves only after success',async()=>{
   expect(await perform()).toEqual({state:'moved'});
   expect(calls.indexOf('persist')).toBeLessThan(calls.indexOf('confirm'));
   expect(service.stripe.refunds.create).not.toHaveBeenCalled();
 });
 it('cannot charge when the PI cannot be stored',async()=>{
   failures.persist=true;
   expect(await perform()).toEqual({state:'failed'});
   expect(service.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
 });
 it('refunds a paid deposit when the slot mutation fails',async()=>{
   failures.move=true;
   expect(await perform()).toEqual({state:'refunded'});
   expect(op.status).toBe('refunded');
   expect(service.stripe.refunds.create).toHaveBeenCalledTimes(1);
 });
 it('does not refund a successful move whose database response was lost',async()=>{
   failures.moveResponse=true;
   expect(await perform()).toEqual({state:'moved'});
   expect(service.stripe.refunds.create).not.toHaveBeenCalled();
 });
 it('never retries an uncertain confirmation as a new charge',async()=>{
   failures.confirm=true;
   expect(await perform()).toEqual({state:'refunded'});
   await service.recover(op.id);
   expect(service.stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
   expect(service.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
 });
 it('retains failed refunds and recovers after restart without charging again',async()=>{
   failures.move=true; failures.refund=true;
   expect((await perform()).state).toBe('pending');expect(op.status).toBe('refund_pending');
   failures.refund=false;
   expect(await service.recover(op.id)).toEqual({state:'refunded'});
   expect(service.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
 });
 it('uses provider refund state after ledger failure instead of refunding twice',async()=>{
   failures.move=true;failures.refundLedger=true;
   expect((await perform()).state).toBe('pending');
   failures.refundLedger=false;
   expect(await service.recover(op.id)).toEqual({state:'refunded'});
   expect(service.stripe.refunds.create).toHaveBeenCalledTimes(1);
 });
 it('does not call processing a paid move; failed cancellation stays recoverable',async()=>{
   provider.status='processing';failures.cancel=true;
   expect((await perform()).state).toBe('pending');
   expect(calls).not.toContain('finish_paid_reschedule');
   provider.status='succeeded'; failures.cancel=false;
   expect(await service.recover(op.id)).toEqual({state:'refunded'});
 });
 it('re-reads the PI after claiming recovery when the request persisted it concurrently',async()=>{
   failures.attachBeforeClaim=true;
   expect(await service.recover(op.id)).toEqual({state:'refunded'});
   expect(service.stripe.refunds.create).toHaveBeenCalledTimes(1);
   expect(op.status).toBe('refunded');
 });
 it('does not mark a pending provider refund returned or create another one',async()=>{
   op.payment_intent_id='pi1';op.status='refund_pending';
   service.stripe.refunds.list.mockResolvedValue({data:[{amount:1000,status:'pending'}],has_more:false});
   expect(await service.recover(op.id)).toEqual({state:'pending'});
   expect(op.status).toBe('refund_pending');
   expect(service.stripe.refunds.create).not.toHaveBeenCalled();
 });
 it('does not charge the former client when appointment ownership changes before preparation',async()=>{
   failures.reassignBeforePrepare=true;
   expect((await perform()).state).toBe('pending');
   expect(service.stripe.paymentIntents.create).not.toHaveBeenCalled();
   expect(service.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
 });
 it('retries least recently attempted operations first so failed refunds cannot starve the queue',async()=>{
   await service.retry();
   expect(calls).toContain('order:updated_at:true');
 });
 it('never attempts payment without the operation row',async()=>{
   failures.prepare=true;
   expect((await perform()).state).toBe('pending');
   expect(service.stripe.paymentIntents.create).not.toHaveBeenCalled();
 });
 it('routes compensation refunds to their operation but keeps normal refunds for completed moves',async()=>{
   op.status='complete';op.payment_intent_id='pi1';
   expect(await service.handlesRefund(op.id)).toBe(false);
   op.status='refund_pending';provider.latest_charge.amount_refunded=1000;
   expect(await service.handlesRefund(op.id)).toBe(true);
   expect(op.status).toBe('refunded');
 });
});
