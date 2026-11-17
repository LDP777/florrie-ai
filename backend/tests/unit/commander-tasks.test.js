import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {} } }));
vi.mock('../../src/lib/booking-preparation.js', () => ({ readBookingPreparation: vi.fn() }));
import { readBookingPreparation } from '../../src/lib/booking-preparation.js';
import { buildCommanderTask, processCommanderTask, returningCandidates, careItem, recordedIncome, readTaskSuggestion } from '../../src/services/commander-tasks.js';
const now = new Date('2026-11-17T12:00:00Z'), owner = { id: 'b1', timezone: 'Europe/London' };

function database(tables, { failTable, cap = 2 } = {}) {
  const calls = [];
  return { calls, from(table) {
    const predicates = [], orders = [], q = { table, filters: [] }; calls.push(q);
    const b = {
      select(fields, options) { q.fields = fields; q.options = options; return b; },
      eq(k,v) { q.filters.push([k,v]); predicates.push(r => r[k] === v); return b; },
      is(k,v) { predicates.push(r => (r[k] ?? null) === v); return b; },
      in(k,v) { predicates.push(r => v.includes(r[k])); return b; },
      gte(k,v) { predicates.push(r => r[k] >= v); return b; },
      lte(k,v) { predicates.push(r => r[k] <= v); return b; },
      lt(k,v) { predicates.push(r => r[k] < v); return b; },
      order(k) { orders.push(k); return b; },
      async range(start,end) {
        if (table === failTable) return { error: new Error('source unavailable') };
        const rows = (tables[table] || []).filter(r => predicates.every(p => p(r))).sort((a,b) => {
          for (const k of orders) { const d = String(a[k]).localeCompare(String(b[k])); if (d) return d; } return 0;
        });
        return { data: rows.slice(start, Math.min(end + 1, start + cap)), count: rows.length };
      },
    };
    return b;
  } };
}
const tx = (id, amount, extra = {}) => ({ id, beautician_id:'b1', created_at:'2026-11-16T10:00:00Z', amount_cents:amount, type:'payment', status:'completed', payment_method:'cash', ...extra });
beforeEach(() => readBookingPreparation.mockReset());

describe('Commander fixed plans', () => {
  it('does not confuse dormant leads, returning clients, archived clients and people already booked', () => {
    const clients = ['returning','new','booked','recent','archived','imported'].map(id => ({ id, first_name:id, archived_at:id==='archived'?'x':null, last_visit_at:id==='imported'?'2026-08-01':null }));
    const visits = ['returning','booked','recent','archived'].map(client_id => ({ client_id, status:'completed', starts_at:client_id==='recent'?'2026-11-10T10:00:00Z':'2026-08-10T10:00:00Z' }));
    expect(returningCandidates(clients, visits, [{client_id:'booked'}], '2026-11-17').map(c=>c.id)).toEqual(['returning','imported']);
  });
  it('uses complete owner-scoped histories and the Money reconciliation rules', async () => {
    const db = database({ transactions:[tx('deposit',1000,{stripe_payment_intent_id:'pi'}),tx('duplicate',1000,{stripe_payment_intent_id:'pi'}),tx('assumed',9000,{payment_method:null}),tx('cash',2000),tx('refund',-500,{type:'refund'}),tx('prior',1200,{created_at:'2026-11-09T10:00:00Z'}),tx('other',999999,{beautician_id:'other'})], expenses:[{id:'e',beautician_id:'b1',date:'2026-11-17',amount_cents:500}] });
    const out = await buildCommanderTask({taskId:'money',beautician:owner,supabase:db,now});
    expect(out.cards.map(c=>c.value)).toEqual(['£25.00','£12.00','£5.00']);
    expect(out.items[1].value).toBe('£90.00');
    expect(db.calls.every(q=>q.filters.some(f=>f[0]==='beautician_id'&&f[1]==='b1'))).toBe(true);
    expect((await recordedIncome(db,owner,{period:'this_week'},now)).totals.income_cents).toBe(2500);
  });
  it('uses salon dates on Sunday and around the UK midnight change', async () => {
    const sunday = await recordedIncome(database({}),owner,{period:'this_week'},new Date('2026-11-22T12:00:00Z'));
    expect(sunday.start).toBe('2026-11-16');
    const summer = await recordedIncome(database({}),owner,{period:'today'},new Date('2026-07-01T23:30:00Z'));
    expect(summer.start).toBe('2026-07-02');
  });
  it('does not make up zeros or call the model when a required read fails', async () => {
    const ai={messages:{create:vi.fn()}};
    await expect(processCommanderTask({taskId:'money',beautician:owner,supabase:database({}, {failTable:'transactions'}),now},{ai})).rejects.toThrow();
    expect(ai.messages.create).not.toHaveBeenCalled();
  });
  it('reads care for each booking, marks failures and never includes medical answers or tokens', async () => {
    const appointments = [1,2].map(i=>({id:`a${i}`,beautician_id:'b1',client_id:`c${i}`,starts_at:`2026-11-18T1${i}:00:00Z`,status:'confirmed',clients:{beautician_id:'b1',first_name:`Client${i}`}}));
    readBookingPreparation.mockResolvedValueOnce({patch:{state:'waiting',evidence:[{result:'reaction'}]},forms:[{status:'received',review_required:true,response:{answers:{medical:'secret condition'},token:'private-token'}}]}).mockRejectedValueOnce(new Error('offline'));
    const out=await buildCommanderTask({taskId:'tomorrow',beautician:owner,supabase:database({appointments}),now});
    expect(out.items).toHaveLength(2);
    expect(out.items[1].unavailable).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/secret condition|private-token|reaction/);
    expect(out.cards[1].value).toBe('2');
  });
  it('does not present another tenant’s joined client name',()=> {
    expect(careItem({starts_at:'2026-11-18T11:00:00Z',clients:{beautician_id:'other',first_name:'Private'}},{patch:{state:'ready'},forms:[]},'b1').label).toBe('11:00 · Client');
  });
  it('provides a useful empty result rather than inventing candidates', async()=>{
    const out=await buildCommanderTask({taskId:'reconnect',beautician:owner,supabase:database({}),now});
    expect(out.items).toEqual([]); expect(out.cards[0].value).toBe('0');
  });
  it('includes diary blocks without advertising empty days as bookable', async()=>{
    const out=await buildCommanderTask({taskId:'week',beautician:owner,supabase:database({hours_exceptions:[{id:'h',beautician_id:'b1',date:'2026-11-16',end_date:'2026-11-18',start_time:'12:00:00',end_time:'14:00:00'}]}),now});
    expect(out.items).toHaveLength(7); expect(out.items[0].detail).toContain('12:00–14:00'); expect(out.items[2].detail).toContain('No diary changes'); expect(out.items[1].detail).toContain('12:00–14:00');
    expect(out.limits[0]).toContain('not a list of bookable slots');
  });
  it('makes one bounded AI call with no tools, no proposals and no client writes', async()=>{
    const ai={messages:{create:vi.fn().mockResolvedValue({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({suggestion:'Check your cash records before deciding what to set aside.',draft:null})}],usage:{input_tokens:500,output_tokens:20}})}};
    const out=await processCommanderTask({taskId:'money',beautician:owner,supabase:database({}),now},{ai});
    expect(ai.messages.create).toHaveBeenCalledTimes(1);
    const sent=ai.messages.create.mock.calls[0][0]; expect(sent.tools).toBeUndefined(); expect(sent.max_tokens).toBe(500);
    expect(out.proposals).toEqual([]); expect(out.actions).toEqual([]); expect(out.task.suggestion).toContain('cash');
  });
  it('cleans model formatting, accepts a rebooking draft only for a real shortlist, and rejects incomplete output',()=>{
    const response={stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({suggestion:'**Review** your preferences — first.',draft:'Hi Demo, would you like to book your next visit?'})}]};
    expect(readTaskSuggestion(response,{id:'reconnect',items:[{label:'Demo'}]})).toEqual({suggestion:'Review your preferences, first.',draft:'Hi Demo, would you like to book your next visit?'});
    expect(readTaskSuggestion(response,{id:'money',items:[]}).draft).toBeNull();
    expect(readTaskSuggestion({...response,stop_reason:'max_tokens'},{id:'reconnect',items:[{}]}).suggestion).toBeNull();
    expect(readTaskSuggestion({stop_reason:'end_turn',content:[{type:'text',text:'not JSON'}]},{id:'week',items:[]})).toEqual({suggestion:null,draft:null});
  });
  it('keeps verified records when AI is unavailable, and rejects unknown tasks before reading', async()=>{
    const ai={messages:{create:vi.fn().mockRejectedValue(new Error('provider down'))}};
    const out=await processCommanderTask({taskId:'money',beautician:owner,supabase:database({}),now},{ai});
    expect(out.task.suggestion).toBeNull(); expect(out.task.cards[0].value).toBe('£0.00');
    await expect(buildCommanderTask({taskId:'send_message',beautician:owner,supabase:{from(){throw new Error('read forbidden')}},now})).rejects.toThrow('Unknown');
  });
});
