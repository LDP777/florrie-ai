import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { validWorkingHours, validateConnectionProof } from '../../src/lib/setup-readiness.js';
const fixture = vi.hoisted(() => ({ owner: {}, db: {}, failed: null, reads: [], writes: 0 }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  const filters = []; let head, cap = Infinity, field;
  fixture.reads.push(table);
  const q = {
    select(value, options) { head = options?.head; field = value; return q; },
    eq(k,v) { filters.push(r => r[k] === v); return q; },
    in(k,v) { filters.push(r => v.includes(r[k])); return q; },
    neq(k,v) { filters.push(r => r[k] !== v); return q; },
    gt(k,v) { filters.push(r => r[k] > v); return q; },
    gte(k,v) { filters.push(r => r[k] >= v); return q; },
    not(k,_op,v) { filters.push(r => r[k] != v); return q; },
    or() { return q; }, order() { return q; }, abortSignal() { return q; },
    ilike(k,v) { filters.push(r => v.endsWith('%') ? String(r[k]).toLowerCase().startsWith(v.slice(0,-1).toLowerCase()) : String(r[k]).toLowerCase() === v.toLowerCase()); return q; },
    limit(n) { cap = n; return q; },
    then(resolve,reject) {
      if (fixture.failed === table) return Promise.resolve({ data: null, count: null, error: { message: 'Unavailable' } }).then(resolve,reject);
      const rows = (fixture.db[table] || []).filter(r => filters.every(f => f(r))).slice(0,cap);
      return Promise.resolve({ error:null, count:rows.length, data:head ? null : rows.map(r => Object.fromEntries(field.split(',').map(k => [k,r[k]]))) }).then(resolve,reject);
    },
  }; return q;
} } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth(req,res,next) {
  if (req.headers.authorization !== 'Bearer fixture') return res.sendStatus(401);
  req.beautician = fixture.owner; next();
} }));
const { default: router } = await import('../../src/routes/setup.js');
let server, origin;
beforeAll(async () => { const app = express(); app.use('/api/setup', router); server = app.listen(0); await new Promise(r => server.once('listening',r)); origin = `http://127.0.0.1:${server.address().port}`; });
afterAll(() => new Promise(r => server.close(r)));
beforeEach(() => {
  fixture.owner = { id:'one', business_name:'Fictional salon', booking_slug:'fictional', working_hours:{mon:{start:'09:00',end:'17:00'}}, auto_reply_enabled:false, booking_policy:{cancellation_notice_hours:48,late_cancel_charge_percent:100}, instagram_page_token:'secret-not-for-response', stripe_account_id:'pending-account' };
  fixture.db = { treatments:[{id:'t',beautician_id:'one',is_active:true,booking_enabled:true,price_cents:3500,duration_minutes:45,requires_consultation:false}], messages:[] };
  fixture.failed = null; fixture.reads = [];
});
async function get(path, auth = true) { return fetch(origin+'/api/setup/'+path,{headers:auth?{Authorization:'Bearer fixture'}:{}}); }
const proof = () => ({channel:'instagram',code:'FLORRIE-AABBCCDDEEFF',since:new Date(Date.now()-60000).toISOString()});

describe('owner setup evidence', () => {
  it('requires authentication for both views',async()=>{expect((await get('status',false)).status).toBe(401);expect((await get('channel-proof',false)).status).toBe(401);expect(fixture.reads).toEqual([]);});
  it('does not call pending Stripe onboarding ready or expose credentials',async()=>{
    const res=await get('status');const data=await res.json(); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(data.money.stripe).toBe(false);expect(data.services.bookable_count).toBe(1);
    expect(data.readiness.items.find(i=>i.key==='policy').detail).toContain('100%');
    expect(JSON.stringify(data)).not.toMatch(/secret-not-for-response|pending-account/);
    expect(data.replies.automatic).toBe(false);
  });
  it('leaves failed counts and menu checks unknown',async()=>{
    fixture.failed='treatments'; const data=await (await get('status')).json();
    expect(data.services.bookable_count).toBeNull();expect(data.services.treatments_count).toBeNull();
    expect(data.readiness.items.find(i=>i.key==='treatments').state).toBe('unknown');
    expect(data.readiness.items.find(i=>i.key==='care').state).toBe('unknown');
  });
  it('excludes another salon and hidden treatments, flags missing care and incomplete prices',async()=>{
    fixture.db.treatments.push({id:'other',beautician_id:'two',is_active:true,booking_enabled:true,price_cents:4500,duration_minutes:60});
    fixture.db.treatments.push({id:'hidden',beautician_id:'one',is_active:false,booking_enabled:true,price_cents:0});
    fixture.db.treatments[0].requires_consultation=true; fixture.db.treatments[0].price_cents=0;
    const data=await (await get('status')).json();expect(data.services.bookable_count).toBe(0);expect(data.services.incomplete_count).toBe(1);expect(data.services.missing_forms).toBe(1);
  });
  it('rejects invalid or expired challenges before querying',async()=>{
    for (const params of [{...proof(),channel:'email'},{...proof(),code:'%'},{...proof(),since:'2020-01-01'}]) expect((await get('channel-proof?'+new URLSearchParams(params))).status).toBe(400);
    expect(fixture.reads).toEqual([]);
  });
  it('only proves an exact recent inbound in the requested channel and salon',async()=>{
    const input=proof(); const message={beautician_id:'one',channel:'instagram',direction:'inbound',content:input.code,created_at:new Date().toISOString()};
    fixture.db.messages=[{...message,beautician_id:'two'},{...message,channel:'whatsapp'},{...message,direction:'outbound'},{...message,content:'unrelated'},{...message,created_at:'2020-01-01T00:00:00Z'}];
    expect((await (await get('channel-proof?'+new URLSearchParams(input))).json()).received).toBe(false);
    fixture.db.messages.push(message);
    const data=await (await get('channel-proof?'+new URLSearchParams(input))).json();expect(data).toEqual({received:true,received_at:message.created_at});
    expect(Object.keys(data)).toEqual(['received','received_at']);
  });
  it('keeps failed evidence reads separate from a message not received',async()=>{
    fixture.failed='messages';expect((await get('channel-proof?'+new URLSearchParams(proof()))).status).toBe(503);
  });
  it('requires a genuine working interval',()=>{
    expect(validWorkingHours({mon:{start:'17:00',end:'09:00'}})).toBe(false);
    expect(validWorkingHours({mon:{start:'99:00',end:'99:30'}})).toBe(false);
    expect(validWorkingHours({anything:{start:'09:00',end:'17:00'}})).toBe(false);
    expect(validWorkingHours({sun:{start:'09:00',end:'17:00'}})).toBe(true);
  });
  it('rejects malformed proof values without coercion',()=>{expect(validateConnectionProof({...proof(),code:['FLORRIE-AABBCCDDEEFF']})).toBeNull();});
});
