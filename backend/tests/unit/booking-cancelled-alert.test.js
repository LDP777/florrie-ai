import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ tables:{}, pushes:[], result:null, failInsert:false }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  const conditions=[];let mutation=null;
  const value=(row,key)=>key.split(/->>?/).reduce((v,k)=>v?.[k],row);
  const run=()=>{
    const rows=state.tables[table]||=[];
    if(mutation?.kind==='insert'){
      if(state.failInsert)return {data:null,error:{code:'XX001'}};
      if(rows.some(r=>r.id===mutation.row.id))return {data:null,error:{code:'23505'}};
      const row={created_at:new Date().toISOString(),...mutation.row};rows.push(row);return {data:[row],error:null};
    }
    const matches=rows.filter(row=>conditions.every(f=>f(row)));
    if(mutation?.kind==='update')for(const row of matches)Object.assign(row,mutation.row);
    return {data:matches.map(row=>structuredClone(row)),error:null};
  };
  const b={select(){return b;},insert(row){mutation={kind:'insert',row};return b;},update(row){mutation={kind:'update',row};return b;},
    eq(k,v){conditions.push(row=>String(value(row,k))===String(v));return b;},in(k,v){conditions.push(row=>v.includes(value(row,k)));return b;},
    gte(k,v){conditions.push(row=>value(row,k)>=v);return b;},order(){return b;},limit(){return b;},
    maybeSingle(){const r=run();return Promise.resolve({...r,data:r.data?.[0]||null});},then(resolve,reject){return Promise.resolve(run()).then(resolve,reject);}};
  return b;
} } }));
vi.mock('../../src/lib/logger.js',()=>({default:{error(){},warn(){}}}));
vi.mock('../../src/services/push-notifications.js',()=>({pushClientCancelled:async(...args)=>{state.pushes.push(args);if(state.result instanceof Error)throw state.result;return state.result;}}));
const {queueClientCancellation,announceClientCancellation,retryClientCancellationAlerts,cancellationAlertId}=await import('../../src/services/booking-cancelled-alert.js');
const appt=()=>state.tables.appointments[0];
const ledger=()=>state.tables.ai_actions[0];
beforeEach(()=>{
  state.tables={appointments:[{id:'a1',beautician_id:'b1',client_id:'c1',status:'confirmed',cancelled_at:'2026-11-14T17:00:00Z',starts_at:'2026-12-12T11:00:00Z',clients:{first_name:'Demo'}}],ai_actions:[]};
  state.pushes=[];state.failInsert=false;state.result={sent:0,apns:{sent:1}};
});
describe('durable client cancellation notifications',()=>{
  it('ignores a staged request and a later unrelated cancellation',async()=>{
    appt().cancelled_at=null;await queueClientCancellation(appt(),{});appt().status='cancelled';appt().cancelled_at='2026-11-14T18:00:00Z';
    await announceClientCancellation('a1');expect(state.pushes).toEqual([]);
    ledger().details.cancelled_at='2026-11-14T17:00:00Z';await announceClientCancellation('a1');expect(state.pushes).toEqual([]);
  });
  it('queues before cancellation and sends only once the booking is cancelled',async()=>{
    await queueClientCancellation(appt(),{lateCancel:true,feeCents:2800});
    expect(ledger().outcome).toBe('pending');
    await announceClientCancellation('a1');expect(state.pushes).toEqual([]);
    appt().status='cancelled';await announceClientCancellation('a1');
    expect(state.pushes).toHaveLength(1);expect(ledger()).toMatchObject({outcome:'success',notification_sent:true});
    expect(state.pushes[0][3]).toMatchObject({appointmentId:'a1',apptDate:appt().starts_at,lateCancel:true,feeCents:2800,notificationId:cancellationAlertId('a1')});
  });
  it('deduplicates simultaneous delivery and repeated cancellation requests',async()=>{
    await queueClientCancellation(appt(),{});await queueClientCancellation(appt(),{});appt().status='cancelled';
    await Promise.all([announceClientCancellation('a1'),announceClientCancellation('a1')]);
    await announceClientCancellation('a1');
    expect(state.tables.ai_actions).toHaveLength(1);expect(state.pushes).toHaveLength(1);
  });
  it('retries failed APNs without repeating successful web delivery',async()=>{
    await queueClientCancellation(appt(),{});appt().status='cancelled';
    state.result={sent:1,apns:{sent:0,reason:'provider_rejected'}};
    await announceClientCancellation('a1');expect(ledger().outcome).toBe('failed');
    state.result={sent:0,apns:{sent:1}};await retryClientCancellationAlerts();
    expect(state.pushes[1][3].channels).toEqual({web:false,apns:true});
    expect(ledger()).toMatchObject({outcome:'success',details:{web_delivered:1,apns_delivered:1}});
    await retryClientCancellationAlerts();expect(state.pushes).toHaveLength(2);
  });
  it('recovers a queued cancellation after restart without changing or charging the booking',async()=>{
    await queueClientCancellation(appt(),{lateCancel:true,feeCents:2800});appt().status='cancelled';
    const before=structuredClone(appt());await retryClientCancellationAlerts();
    expect(appt()).toEqual(before);expect(state.pushes).toHaveLength(1);
  });
  it('keeps provider failures retryable and respects an explicit notification opt-out',async()=>{
    await queueClientCancellation(appt(),{});appt().status='cancelled';state.result=new Error('down');
    await announceClientCancellation('a1');expect(ledger().outcome).toBe('failed');
    state.result={sent:0,suppressed:'pref_off'};await retryClientCancellationAlerts();expect(ledger().outcome).toBe('success');
  });
  it('refuses to lose delivery intent and never invents alerts for historic cancellations',async()=>{
    state.failInsert=true;await expect(queueClientCancellation(appt(),{})).rejects.toThrow('Could not queue');
    appt().status='cancelled';await retryClientCancellationAlerts();await announceClientCancellation('a1');expect(state.pushes).toEqual([]);
  });
});
