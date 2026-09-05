import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: {}, fail: null, sms: vi.fn(), rpc: vi.fn() }));
vi.mock('../../src/config.js', () => ({ supabase: {
  rpc: (...args) => state.rpc(...args),
  from: table => {
    const filters = []; let write; let limit = Infinity; let single = false;
    const settle = () => {
      if (state.fail === table) return { data: null, error: { message: 'unavailable' } };
      if (write?.type === 'update' && state.beforeUpdate) { state.beforeUpdate(); state.beforeUpdate = null; }
      const all = state.db[table] || [];
      let rows = all.filter(r => filters.every(fn => fn(r))).slice(0, limit);
      if (write?.type === 'insert') { rows = [{ id: 'created', ...write.value }]; state.db[table] = [...all, ...rows]; }
      if (write?.type === 'update') rows.forEach(r => Object.assign(r, write.value));
      if (write?.type === 'delete') state.db[table] = all.filter(r => !rows.includes(r));
      rows = rows.map(r => table === 'consultation_responses' ? { ...r, consultation_forms: (state.db.consultation_forms || []).find(f => f.id === r.form_id) } : r);
      return { data: single ? rows[0] || null : rows, error: null };
    };
    const q = {
      select: () => q, eq: (k,v) => { filters.push(r => r[k] === v); return q; },
      is: (k,v) => { filters.push(r => (r[k] ?? null) === v); return q; },
      in: (k,v) => { filters.push(r => v.includes(r[k])); return q; },
      not: (k,op,v) => { filters.push(r => r[k] != null); return q; },
      order: () => q, limit: n => { limit=n; return q; },
      insert: value => { write={type:'insert',value}; return q; }, update: value => { write={type:'update',value}; return q; }, delete: () => { write={type:'delete'}; return q; },
      maybeSingle: () => { single=true; return Promise.resolve(settle()); }, single: () => { single=true; return Promise.resolve(settle()); },
      then: (a,b) => Promise.resolve(settle()).then(a,b),
    }; return q;
  },
} }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req,res,next) => next() }));
vi.mock('../../src/services/notifications.js', () => ({ sendSMS: (...args) => state.sms(...args) }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info(){},warn(){},error(){} } }));
import router from '../../src/routes/consultation-forms.js';
async function run(method, path, options = {}) {
  const req = { beautician: { id:'owner' }, params:{}, query:{}, body:{}, ...options };
  const out = { status:200,body:null }; const res = { status(n){out.status=n;return res;},json(body){out.body=body;return res;} };
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  for (const middleware of layer.route.stack) {
    let next = false;
    await middleware.handle(req,res,err => {if(err) throw err; next=true;});
    if (!next) break;
  }
  return out;
}
beforeEach(() => {
  state.fail = null; state.beforeUpdate = null; state.rpc.mockReset(); state.sms.mockReset().mockResolvedValue({ accepted:true });
  state.db = {
    clients:[{id:'client',beautician_id:'owner',phone:'+447700900123'}],
    consultation_forms:[{id:'brow',beautician_id:'owner',name:'Brows',is_active:true,is_default:true},{id:'lash',beautician_id:'owner',name:'Lashes',is_active:true}],
    treatments:[{id:'brow-treatment',beautician_id:'owner',requires_consultation:true,consultation_form_id:'brow'},{id:'lash-treatment',beautician_id:'owner',requires_consultation:true,consultation_form_id:'lash'}],
    appointments:[{id:'booking',beautician_id:'owner',client_id:'client',treatment_id:'brow-treatment',extra_treatment_ids:['lash-treatment']}],
    consultation_responses:[],messages:[],
  };
});
describe('consultation API actions', () => {
  it('saves the actual signed public payload against issued questions', async () => {
    state.db.consultation_responses.push({id:'response',token:'token',status:'pending',form_id:'brow',form_snapshot:{consultation_form_fields:[{id:'sig',type:'signature',required:true}]}});
    const result = await run('post','/public/:token/submit',{params:{token:'token'},body:{answers:{},signature_data:'data:image/png;base64,YQ=='}});
    expect(result.status).toBe(200); expect(state.db.consultation_responses[0].status).toBe('completed');
  });
  it('does not write unsigned required forms or allow expired records', async () => {
    state.db.consultation_responses.push({id:'r',token:'t',status:'pending',form_snapshot:{consultation_form_fields:[{id:'s',label:'Signature',type:'signature',required:true}]}});
    expect((await run('post','/public/:token/submit',{params:{token:'t'},body:{answers:{}}})).status).toBe(400);
    expect(state.db.consultation_responses[0].status).toBe('pending');
    state.db.consultation_responses[0].status='expired';
    expect((await run('post','/public/:token/submit',{params:{token:'t'},body:{answers:{}}})).status).toBe(410);
  });
  it('opening an old completed link cannot expire the submitted evidence', async () => {
    state.db.consultation_responses.push({id:'r',token:'t',status:'completed',expires_at:'2020-01-01'});
    expect((await run('get','/public/:token',{params:{token:'t'}})).body.completed).toBe(true);
    expect(state.db.consultation_responses[0].status).toBe('completed');
  });
  it('a racing public expiry lookup cannot overwrite a completed submission', async () => {
    state.db.consultation_responses.push({id:'r',token:'t',status:'pending',expires_at:'2020-01-01'});
    state.beforeUpdate=()=>{state.db.consultation_responses[0].status='completed';};
    expect((await run('get','/public/:token',{params:{token:'t'}})).status).toBe(410);
    expect(state.db.consultation_responses[0].status).toBe('completed');
  });
  it('rejects a mismatched client and booking before sending', async () => {
    state.db.appointments[0].client_id='someone-else';
    expect((await run('post','/send',{body:{client_id:'client',appointment_id:'booking'}})).status).toBe(400);
    expect(state.sms).not.toHaveBeenCalled(); expect(state.db.consultation_responses).toHaveLength(0);
  });
  it('sends forms required by extra treatments too', async () => {
    expect((await run('post','/send',{body:{client_id:'client',appointment_id:'booking'}})).status).toBe(200);
    expect(state.db.consultation_responses.map(r=>r.form_id)).toEqual(['brow','lash']); expect(state.sms).toHaveBeenCalledTimes(2);
  });
  it('sends only the missing extra form when the primary form is already completed', async () => {
    state.db.consultation_responses.push({id:'done',beautician_id:'owner',client_id:'client',status:'completed',form_id:'brow'});
    expect((await run('post','/send',{body:{client_id:'client',appointment_id:'booking'}})).status).toBe(200);
    expect(state.db.consultation_responses.filter(r => r.status === 'pending').map(r=>r.form_id)).toEqual(['lash']);
    expect(state.sms).toHaveBeenCalledTimes(1);
  });
  it('does not leave an awaiting-response record after rejected delivery', async () => {
    state.sms.mockResolvedValue(null);
    expect((await run('post','/send',{body:{client_id:'client',form_id:'lash'}})).status).toBe(500);
    expect(state.db.consultation_responses).toHaveLength(0);
  });
  it('does not equate any completed form with coverage for all booked treatments', async () => {
    state.db.consultation_responses.push({id:'r',beautician_id:'owner',client_id:'client',status:'completed',form_id:'brow'});
    expect((await run('get','/for-appointment/:appointmentId',{params:{appointmentId:'booking'}})).body.response).toBeNull();
    state.db.consultation_responses.push({id:'r2',beautician_id:'owner',client_id:'client',status:'completed',form_id:'lash'});
    expect((await run('get','/for-appointment/:appointmentId',{params:{appointmentId:'booking'}})).body.response).toBeTruthy();
  });
  it('hides send when all missing forms await responses, but permits an unrequested extra', async () => {
    state.db.consultation_responses.push({id:'waiting',beautician_id:'owner',client_id:'client',status:'pending',form_id:'brow',expires_at:'2099-01-01'});
    let result=await run('get','/for-appointment/:appointmentId',{params:{appointmentId:'booking'}});
    expect(result.body.form_available).toBe(true);
    expect(result.body.missing_forms.map(f=>f.status)).toEqual(['awaiting_response','not_requested']);
    state.db.consultation_responses.push({id:'waiting2',beautician_id:'owner',client_id:'client',status:'pending',form_id:'lash',expires_at:'2099-01-01'});
    result=await run('get','/for-appointment/:appointmentId',{params:{appointmentId:'booking'}});
    expect(result.body.form_available).toBe(false);
    expect(result.body.missing_forms.every(f=>f.status==='awaiting_response')).toBe(true);
  });
  it('returns failed records as an error, not an empty history', async () => {
    state.fail='consultation_responses';
    expect((await run('get','/responses/list',{query:{client_id:'client'}})).status).toBe(500);
  });
  it('does not send a duplicate active form request', async () => {
    state.db.consultation_responses.push({ id: 'waiting', beautician_id: 'owner', client_id: 'client', form_id: 'lash', status: 'pending', expires_at: '2099-01-01' });
    expect((await run('post', '/send', { body: { client_id: 'client', form_id: 'lash' } })).status).toBe(409);
    expect(state.sms).not.toHaveBeenCalled(); expect(state.db.consultation_responses).toHaveLength(1);
  });
  it('never exposes request tokens and distinguishes retention from an unanswered link', async () => {
    state.db.consultation_responses.push({ id: 'waiting', beautician_id: 'owner', client_id: 'client', form_id: 'lash', status: 'pending', token: 'secret', expires_at: '2099-01-01' });
    state.db.consultation_responses.push({ id: 'purged', beautician_id: 'owner', client_id: 'client', form_id: 'brow', status: 'expired', token: 'secret2', completed_at: '2020-01-01' });
    const result = await run('get', '/responses/list', { query: { client_id: 'client' } });
    expect(result.status).toBe(200);
    expect(result.body.requests.map(r => r.status)).toEqual(['pending', 'answers_removed']);
    expect(JSON.stringify(result.body)).not.toContain('secret');
  });
  it('fails an edit safely if the snapshot migration is absent', async () => {
    state.rpc.mockResolvedValue({error:{message:'function missing'},data:null});
    expect((await run('patch','/:id',{params:{id:'brow'},body:{name:'Edited',fields:[]}})).status).toBe(500);
    expect(state.db.consultation_forms[0].name).toBe('Brows');
  });
});
