import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ events: [], writes: [], deleted: false, deletionReadError: false, failWrite: false, failClaim: false, failCompletion: false,
  stripe: { subscriptions: { retrieve: vi.fn(), create: vi.fn() }, customers: { create: vi.fn() }, checkout: { sessions: { create: vi.fn() } }, webhooks: { constructEvent: p => JSON.parse(p) } },
  dunning: vi.fn(),
}));
vi.mock('stripe', () => ({ default: class { constructor() { return state.stripe; } } }));
vi.mock('../../src/config.js', () => ({ supabase: { rpc: async name => { if (name === 'is_deleted_account_event') return { data: state.deleted, error: state.deletionReadError ? { message: 'read unavailable' } : null }; throw new Error('Unexpected RPC: ' + name); }, from: table => {
  let op = 'read', value, filters = [];
  const field = (r, key) => key === 'data->billing_claim->>token' ? r.data?.billing_claim?.token : r[key];
  const finish = () => {
    const rows = table === 'stripe_events' ? state.events : [{ id: 'owner', subscription_stripe_id: 'sub_existing' }];
    const matches = rows.filter(r => filters.every(([key,v]) => field(r,key) === v));
    if (op === 'upsert') {
      if (table !== 'stripe_events') throw new Error('Unexpected upsert');
      const prior = rows.find(row => row.id === value.id);
      if (prior) Object.assign(prior, structuredClone(value)); else rows.push(structuredClone(value));
      return { data: [value], error: null };
    }
    if (op === 'insert') {
      if (state.failClaim) return { error: { message: 'DB unavailable' } };
      if (rows.some(r => r.id === value.id)) return { error: { code: '23505' } };
      rows.push(structuredClone(value)); return { data: [value], error: null };
    }
    if (op === 'update') {
      if (table === 'stripe_events' && value.processed_at && state.failCompletion) return { error: { message: 'completion failed' } };
      if (table === 'beauticians') {
        if (state.failWrite) return { error: { message: 'update failed' } };
        state.writes.push(value);
      }
      matches.forEach(r => Object.assign(r, structuredClone(value)));
    }
    return { data: matches, error: null };
  };
  const q = { upsert(v) { op='upsert'; value=v; return q; }, insert(v) { op='insert'; value=v; return q; }, update(v) { op='update'; value=v; return q; },
    select() { return q; }, eq(k,v) { filters.push([k,v]); return q; }, is(k,v) { filters.push([k,v]); return q; },
    async maybeSingle() { const result = finish(); return { ...result, data: result.data?.[0] || null }; },
    then(resolve,reject) { return Promise.resolve().then(finish).then(resolve,reject); },
  }; return q;
} } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req,res,next) => next() }));
vi.mock('../../src/lib/logger.js', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../src/services/dunning.js', () => ({ handleDunningEvent: (...args) => state.dunning(...args) }));
vi.mock('../../src/lib/team-seats.js', () => ({ teamSeatQuantity: async () => 1 }));
let router, handleBillingEvent;
beforeEach(async () => {
  vi.stubEnv('STRIPE_SECRET_KEY','sk_test_fake'); vi.stubEnv('STRIPE_PRICE_FLORRIE','price_test'); vi.stubEnv('STRIPE_WEBHOOK_SECRET','whsec_test');
  ({ default: router, handleBillingEvent } = await import('../../src/routes/billing.js'));
  state.events=[]; state.writes=[]; state.deleted=false; state.deletionReadError=false; state.failWrite=false; state.failClaim=false; state.failCompletion=false; vi.clearAllMocks();
  state.dunning.mockResolvedValue({ handled: true, statusWritten: true, marker: { written: true } });
});
function response() {
  const result = { status: 200 };
  const res = { status(s) { result.status=s; return res; }, json(body) { result.body=body; return res; } };
  return { result,res };
}
const event = (type='customer.subscription.updated', object={ id: 'sub_existing', status: 'active', metadata: { beautician_id: 'owner', plan: 'florrie' } }) => ({ id:'evt_test', type, data:{ object } });
async function deliver(e) { const {result,res}=response(); await handleBillingEvent(e,res); return result; }
async function route(path) {
  const {result,res}=response();
  const req={ body:{ plan:'florrie' }, beautician:{ id:'owner', subscription_stripe_id:'sub_existing' } };
  for (const layer of router.stack.find(l => l.route?.path === path).route.stack) {
    let next=false; await layer.handle(req,res,() => {next=true;}); if (!next) break;
  }
  return result;
}
describe('billing event ownership and recovery', () => {
  it.each(['payment','setup'])('does not consume %s checkout events', async mode => {
    expect((await deliver(event('checkout.session.completed',{ mode }))).body.ignored).toBe(true);
    expect(state.events).toEqual([]); expect(state.writes).toEqual([]);
  });
  it('does not consume unrelated events', async () => {
    await deliver(event('charge.refunded')); expect(state.events).toEqual([]);
  });
  it('retains a failed event unprocessed and applies a replay once', async () => {
    state.failWrite=true;
    expect((await deliver(event())).status).toBe(503);
    expect(state.events[0].processed_at).toBeNull(); expect(state.events[0].data.id).toBe('evt_test');
    state.failWrite=false;
    expect((await deliver(event())).status).toBe(200);
    expect(state.events[0].processed_at).toBeTruthy(); expect(state.writes).toHaveLength(1);
    expect((await deliver(event())).body.duplicate).toBe(true); expect(state.writes).toHaveLength(1);
  });
  it('refuses processing when its ledger cannot be written', async () => {
    state.failClaim=true; expect((await deliver(event())).status).toBe(503); expect(state.writes).toEqual([]);
  });
  it('does not acknowledge an in-flight claim and recovers a crashed claim after its lease', async () => {
    state.events.push({ id:'evt_test',processed_at:null,data:{ billing_claim:{ token:'old',claimed_at:new Date().toISOString() } } });
    expect((await deliver(event())).status).toBe(503); expect(state.writes).toEqual([]);
    state.events[0].data.billing_claim.claimed_at=new Date(Date.now()-11*60000).toISOString();
    expect((await deliver(event())).status).toBe(200); expect(state.writes).toHaveLength(1);
  });
  it('keeps an event retryable if the completion marker fails after its write', async () => {
    state.failCompletion=true;
    expect((await deliver(event())).status).toBe(503); expect(state.events[0].processed_at).toBeNull();
    state.failCompletion=false;
    expect((await deliver(event())).status).toBe(200);
    expect(state.events[0].processed_at).toBeTruthy();
    expect(state.writes[0]).toEqual(state.writes[1]); // subscription writes are idempotent
  });
  it('returns retryably when a handler throws', async () => {
    state.dunning.mockRejectedValue(new Error('Database unavailable'));
    expect((await deliver(event('invoice.paid'))).status).toBe(503);
    expect(state.events[0].processed_at).toBeNull();
  });
  it('preserves created-event subscription ID, tier and status', async () => {
    await deliver(event('customer.subscription.created'));
    expect(state.writes[0]).toMatchObject({ subscription_stripe_id:'sub_existing',subscription_plan:'florrie',subscription_status:'active' });
  });
  it('retries returned invoice-write failures instead of marking complete', async () => {
    state.dunning.mockResolvedValue({ handled:true,statusWritten:false,marker:{ written:true } });
    expect((await deliver(event('invoice.paid'))).status).toBe(503); expect(state.events[0].processed_at).toBeNull();
    expect(state.dunning).toHaveBeenCalledWith(expect.anything(),{ strict:true });
  });
});
describe('signed billing webhook deletion boundary', () => {
  async function webhook(payload) {
    const {result,res}=response();
    const handler=router.stack.find(layer=>layer.route?.path==='/webhook').route.stack.at(-1).handle;
    await handler({body:Buffer.from(JSON.stringify(payload)),headers:{'stripe-signature':'fixture-signature'}},res);
    return result;
  }
  it('acknowledges late deleted-account events with only a redacted dedupe row', async () => {
    state.deleted=true;
    const payload=event('customer.subscription.updated',{id:'sub_existing',status:'active',customer:'cus_private',metadata:{beautician_id:'owner'},description:'private client details'});
    const result=await webhook(payload);
    expect(result.status).toBe(200); expect(result.body.account_deleted).toBe(true);
    expect(state.writes).toEqual([]); expect(state.dunning).not.toHaveBeenCalled();
    expect(state.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toEqual({id:payload.id,type:payload.type,data:{account_deleted:true},processed_at:expect.any(String)});
    expect(JSON.stringify(state.events)).not.toContain('private');
  });
  it('returns 503 before any write when deletion status cannot be checked', async () => {
    state.deletionReadError=true;
    expect((await webhook(event())).status).toBe(503);
    expect(state.events).toEqual([]);expect(state.writes).toEqual([]);expect(state.dunning).not.toHaveBeenCalled();
  });
});
describe('existing subscription lookup failures', () => {
  it.each(['/create-checkout','/create-subscription-intent'])('%s refuses a second subscription when Stripe lookup fails', async path => {
    state.stripe.subscriptions.retrieve.mockRejectedValue(new Error('Stripe timeout'));
    expect((await route(path)).status).toBe(503);
    expect(state.stripe.customers.create).not.toHaveBeenCalled();
    expect(state.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(state.stripe.subscriptions.create).not.toHaveBeenCalled();
  });
});
