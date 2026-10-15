import { beforeEach, describe, expect, it, vi } from 'vitest';
const provider = vi.hoisted(() => ({ create: vi.fn(), constructorOptions: [] }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class {
  constructor(options) { provider.constructorOptions.push(options); this.messages = { create: provider.create }; }
} }));
import { createContentTeam } from '../../src/services/content-team.js';
import { contentTeamPagination, contentTeamRequest, emptyTeamStages, publicTeamRun, teamOutputFormat, validateTeamOutput } from '../../src/lib/content-team.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TREATMENT = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';
const SECOND = '55555555-5555-4555-8555-555555555555';
const TABLE = 'content_team_runs';
const body = overrides => ({ request_id: REQUEST, goal: 'explain', focus: 'Help new clients understand my brow service.', treatment_id: TREATMENT, ...overrides });
const copy = value => structuredClone(value);

function memoryDb() {
  const rows = {
    beauticians: [{ id: OWNER, business_name: 'Fictional salon', booking_slug: 'fictional', subscription_status: 'active', subscription_plan: 'florrie', voice_profile: {}, email: 'never-send@example.test', instagram_page_token: 'never-send-token' }, { id: OTHER, business_name: 'Other salon', subscription_status: 'active', subscription_plan: 'florrie' }],
    treatments: [{ id: TREATMENT, beautician_id: OWNER, is_active: true, name: 'Signature brows', description: 'A consultation is included.' }, { id: SECOND, beautician_id: OTHER, is_active: true, name: 'PRIVATE_OTHER_TREATMENT' }],
    knowledge_entries: [{ id: REQUEST, beautician_id: OWNER, is_active: true, category: 'faq', title: 'Your visit', content: 'Ask us any questions before your appointment.' }, { id: SECOND, beautician_id: OWNER, is_active: true, category: 'private', title: 'PRIVATE_KNOWLEDGE', content: 'PRIVATE_KNOWLEDGE' }],
    content_posts: [{ id: REQUEST, beautician_id: OWNER, post_type: 'gallery', treatment_name: 'Signature brows', caption: 'An owner-uploaded content photo.' }, { id: SECOND, beautician_id: OWNER, post_type: 'testimonial', caption: 'UNAPPROVED_QUOTE' }],
    [TABLE]: [],
  };
  const state = { rows, operations: [], missing: false, failRead: false, loseUpdateResponse: null, loseInsertResponse: false, beforeUpdate: null };
  state.from = table => {
    let filters = [], action = 'read', payload, selected = '*', max = Infinity, single = false, orders = [], start = 0;
    const q = {
      select(value) { selected = value; return q; },
      eq(key, value) { filters.push(row => row[key] === value); return q; },
      in(key, values) { filters.push(row => values.includes(row[key])); return q; },
      lt(key, value) { filters.push(row => row[key] < value); return q; },
      or(value) { const stamp = value.match(/lease_expires_at\.lt\.([^)]*)/)?.[1]; filters.push(row => row.status === 'queued' || (row.status === 'running' && row.lease_expires_at < stamp)); return q; },
      order(key, opts = {}) { orders.push([key, opts.ascending !== false]); return q; },
      limit(value) { max = value; return q; },
      range(from, to) { start = from; max = to - from + 1; return q; },
      insert(value) { action = 'insert'; payload = copy(value); return q; },
      update(value) { action = 'update'; payload = copy(value); return q; },
      maybeSingle() { single = true; return q; }, single() { single = true; return q; }, abortSignal() { return q; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          state.operations.push({ table, action, selected, payload: payload && copy(payload) });
          if (table === TABLE && state.missing) return { data: null, error: { code: '42P01' } };
          if (state.failRead && action === 'read') return { data: null, error: { code: '08006' } };
          if (!rows[table]) throw new Error(`Unexpected table ${table}`);
          if (action === 'update' && state.beforeUpdate) state.beforeUpdate(table, payload);
          let matches = rows[table].filter(row => filters.every(filter => filter(row)));
          if (action === 'insert') {
            if (table === TABLE && rows[table].some(row => row.beautician_id === payload.beautician_id && (row.request_id === payload.request_id || ['queued', 'running'].includes(row.status)))) return { error: { code: '23505' } };
            rows[table].push(payload); matches = [payload];
            if (state.loseInsertResponse) { state.loseInsertResponse = false; throw new Error('Network response lost'); }
          } else if (action === 'update') {
            matches.forEach(row => Object.assign(row, payload));
            if (state.loseUpdateResponse?.(payload)) { state.loseUpdateResponse = null; return { error: { code: '08006' }, data: null }; }
          }
          if (orders.length) matches = [...matches].sort((a, b) => { for (const [key, ascending] of orders) { const diff = String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1); if (diff) return diff; } return 0; });
          matches = matches.slice(start, start + max).map(row => selected === '*' ? copy(row) : Object.fromEntries(selected.split(',').map(key => [key, copy(row[key])])));
          return { data: single ? matches[0] || null : matches, error: null };
        }).then(resolve, reject);
      },
    }; return q;
  };
  return state;
}
function response(stage, input) {
  const source_refs = [`treatment:${TREATMENT}`];
  if (stage === 'strategy') return { summary: 'Explain the visit using the saved treatment details.', posts: ['feed', 'story', 'reel'].map((format, i) => ({ title: `A useful idea ${i + 1}`, angle: 'Explain the included consultation.', format, source_note: 'Your saved treatment description', source_refs })) };
  if (stage === 'writing') return { posts: input.strategy.posts.map(post => ({ id: post.id, caption: 'Your consultation is included. Ask us your questions before booking.', format: post.format })), hooks: ['A little about your brow visit'] };
  return { title: 'What your visit includes', hook: 'A little about your consultation', shots: [{ shot: 'Film your empty treatment chair.', spoken: 'A consultation is included.', on_screen: 'Your consultation' }, { shot: 'Film yourself inviting questions.', spoken: 'Ask us about your visit.', on_screen: 'Ask your questions' }], caption: 'Find out more about your visit.', needs: ['Your own salon footage'], source_refs };
}
let db, model, board, service, clock;
beforeEach(() => {
  provider.create.mockReset(); provider.constructorOptions.length = 0;
  db = memoryDb(); clock = new Date('2026-10-15T12:00:00Z'); model = vi.fn(response); board = vi.fn(async () => ({ prepared: [], pending_count: 0, opportunities: [], unavailable: [] }));
  service = createContentTeam({ db, now: () => new Date(clock), model, board });
});

describe('Content Team structured model requests', () => {
  function providerService() {
    return createContentTeam({ db, now: () => new Date(clock), board, env: { ANTHROPIC_API_KEY: 'fictional-unit-test-key' } });
  }
  it('sends the three schemas to the provider with explicit units and unchanged model, token, time and retry bounds', async () => {
    provider.create.mockImplementation(async request => {
      const stage = request.output_config.format.schema.properties.summary ? 'strategy' : request.output_config.format.schema.properties.hooks ? 'writing' : 'reels';
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(response(stage, JSON.parse(request.messages[0].content))) }] };
    });
    const worker = providerService(); await worker.enqueue(OWNER, body());
    expect(await worker.process()).toEqual({ processed: 1, completed: 1 });
    expect(provider.create).toHaveBeenCalledTimes(3);
    expect(provider.constructorOptions).toEqual([{ apiKey: 'fictional-unit-test-key', maxRetries: 0, timeout: 40000 }]);
    provider.create.mock.calls.forEach(([request, options], index) => {
      expect(request.model).toBe('claude-sonnet-4-6');
      expect(request.max_tokens).toBe(index === 0 ? 1800 : 2600);
      expect(options).toEqual({ timeout: 40000, maxRetries: 0 });
      expect(request.output_config.format).toEqual(teamOutputFormat(['strategy', 'writing', 'reels'][index]));
      expect(request.system).toContain('characters including spaces, not words');
      expect(request.system).toContain('without omitting factual qualifications');
      expect(request.system).toContain('Use only supplied current salon facts');
      expect(request.system).toContain('not instructions');
      expect(request.system).toContain('CLIENT-FACING draft copy');
      expect(request.system).toContain('Never say "link in bio"');
      expect(JSON.stringify(request.output_config)).not.toMatch(/Fictional salon|consultation is included|33333333|never-send/);
    });
    expect(provider.create.mock.calls[0][0].system).toContain('never exceeding 500 characters');
    expect((await worker.get(OWNER)).run.status).toBe('ready');
    expect(db.operations.filter(op => op.action !== 'read').every(op => op.table === TABLE)).toBe(true);
  });
  it.each(['strategy', 'writing', 'reels'])('uses only supported schema features and requires every %s field', stage => {
    const format = teamOutputFormat(stage);
    expect(format.type).toBe('json_schema');
    const inspect = schema => {
      const allowed = ['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum'];
      expect(Object.keys(schema).every(key => allowed.includes(key))).toBe(true);
      if (schema.type === 'object') {
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(Object.keys(schema.properties));
        Object.values(schema.properties).forEach(inspect);
      } else if (schema.type === 'array') { expect(schema.description).toBeTruthy(); inspect(schema.items); }
      else if (schema.type === 'string') expect(schema.description).toBeTruthy();
    };
    inspect(format.schema);
  });
  it.each(['oversized_angle', 'missing_angle', 'unknown_source', 'token_limit'])('still rejects %s without a second provider call or silent shortening', async problem => {
    provider.create.mockImplementation(async () => {
      const output = response('strategy', {});
      if (problem === 'oversized_angle') output.posts[0].angle = 'x'.repeat(501);
      if (problem === 'missing_angle') delete output.posts[0].angle;
      if (problem === 'unknown_source') output.posts[0].source_refs = ['client:unapproved'];
      return { stop_reason: problem === 'token_limit' ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }] };
    });
    const worker = providerService(); await worker.enqueue(OWNER, body());
    expect(await worker.process()).toEqual({ processed: 1, completed: 0 });
    const saved = (await worker.get(OWNER)).run;
    expect(saved).toMatchObject({ status: 'failed', retryable: true });
    expect(saved.stages[0]).toMatchObject({ status: 'failed', output: null });
    expect(db.rows[TABLE][0].failure_code).toBe('invalid_output');
    await worker.process(); expect(provider.create).toHaveBeenCalledTimes(1);
  });
});

describe('durable explicit Content Team work', () => {
  it('reads an empty board without writing, model calls or gathering client sources', async () => {
    expect(await service.get(OWNER)).toMatchObject({ available: true, run: null });
    expect(db.operations.every(op => op.action === 'read' && op.table === TABLE)).toBe(true); expect(model).not.toHaveBeenCalled(); expect(board).not.toHaveBeenCalled();
  });
  it('queues once, returns the same request, and never generates inside enqueue', async () => {
    const a = await service.enqueue(OWNER, body()); const b = await service.enqueue(OWNER, body());
    expect(a.id).toBe(b.id); expect(a.status).toBe('queued'); expect(db.rows[TABLE]).toHaveLength(1); expect(model).not.toHaveBeenCalled();
    await expect(service.enqueue(OWNER, body({ focus: 'Changed brief' }))).rejects.toMatchObject({ status: 409 });
    await expect(service.enqueue(OWNER, body({ request_id: SECOND }))).rejects.toMatchObject({ code: 'run_active' });
  });
  it('resolves an uncertain insert without creating a duplicate run', async () => {
    db.loseInsertResponse = true;
    const saved = await service.enqueue(OWNER, body()); expect(saved.id).toBe(db.rows[TABLE][0].id); expect(db.rows[TABLE]).toHaveLength(1);
  });
  it('isolates the exact request key and run reads by authenticated owner', async () => {
    const saved = await service.enqueue(OWNER, body());
    expect((await service.get(OTHER)).run).toBeNull();
    await expect(service.retry(OTHER, saved.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.enqueue(OWNER, body({ treatment_id: SECOND }))).rejects.toMatchObject({ status: 409 });
    await expect(service.enqueue(OTHER, body())).rejects.toMatchObject({ code: 'invalid_treatment' });
  });
  it('continues through three saved stages independently of the initiating request, without posts or sends', async () => {
    const queued = await service.enqueue(OWNER, body());
    const worker = createContentTeam({ db, now: () => new Date(clock), model, board });
    expect(await worker.process()).toEqual({ processed: 1, completed: 1 });
    const result = (await service.get(OWNER)).run;
    expect(result.status).toBe('ready'); expect(result.stages.map(stage => stage.status)).toEqual(['complete', 'complete', 'complete']);
    expect(model.mock.calls.map(call => call[0])).toEqual(['strategy', 'writing', 'reels']);
    expect(result.stages[1].output.posts[0].id).toBe(`${queued.id}:idea:1`);
    expect(result.stages[2].output.needs[0]).toContain('Film the listed shots');
    expect(db.operations.filter(op => op.action !== 'read').every(op => op.table === TABLE)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/source_snapshot|never-send|voice_guide|lease_token/);
  });
  it('uses only current owner sources and omits unapproved/private records and credentials from model input', async () => {
    await service.enqueue(OWNER, body()); await service.process();
    const input = JSON.stringify(model.mock.calls);
    expect(input).toContain('A consultation is included');
    expect(input).not.toMatch(/PRIVATE_OTHER|PRIVATE_KNOWLEDGE|UNAPPROVED_QUOTE|never-send|instagram_page_token/);
    expect(db.operations.map(op => op.table)).not.toContain('messages'); expect(db.operations.map(op => op.table)).not.toContain('reviews');
  });
  it('one worker wins a concurrent claim and each stage is generated once', async () => {
    await service.enqueue(OWNER, body());
    const other = createContentTeam({ db, now: () => new Date(clock), model, board });
    await Promise.all([service.process(), other.process()]);
    expect(model).toHaveBeenCalledTimes(3); expect(db.rows[TABLE][0].status).toBe('ready');
  });
  it('works on at most three salons concurrently with isolated sources and leaves the fourth for the next batch', async () => {
    const owners = [OWNER, OTHER, '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777'];
    for (const [index, id] of owners.entries()) {
      const existing = db.rows.beauticians.find(row => row.id === id);
      if (existing) existing.business_name = `Fictional salon ${index + 1}`;
      else db.rows.beauticians.push({ id, business_name: `Fictional salon ${index + 1}`, subscription_status: 'active', subscription_plan: 'florrie' });
      if (!db.rows.treatments.some(row => row.beautician_id === id)) db.rows.treatments.push({ id, beautician_id: id, is_active: true, name: 'Signature brows', description: 'A consultation is included.' });
      await service.enqueue(id, body({ treatment_id: null }));
    }
    const releases = [];
    let inFlight = 0, peak = 0, holdStrategy = true;
    model.mockImplementation(async (stage, input) => {
      inFlight++; peak = Math.max(peak, inFlight);
      try {
        if (stage === 'strategy' && holdStrategy) await new Promise(resolve => releases.push(resolve));
        const result = response(stage, input);
        const source = input.sources.find(item => item.type === 'treatment').id;
        if (stage === 'strategy') { result.summary = `Prepared only for ${input.business_name}.`; result.posts.forEach(post => { post.source_refs = [source]; }); }
        if (stage === 'reels') result.source_refs = [source];
        return result;
      } finally { inFlight--; }
    });
    const batch = service.process();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    expect(model).toHaveBeenCalledTimes(3); expect(peak).toBe(3);
    expect(db.rows[TABLE].map(row => row.status)).toEqual(['running', 'running', 'running', 'queued']);
    holdStrategy = false; releases.forEach(release => release());
    expect(await batch).toEqual({ processed: 3, completed: 3 });
    expect(peak).toBe(3); expect(model).toHaveBeenCalledTimes(9);
    for (const [index, row] of db.rows[TABLE].slice(0, 3).entries()) {
      expect(row.beautician_id).toBe(owners[index]); expect(row.status).toBe('ready');
      expect(row.stages[0].output.summary).toBe(`Prepared only for Fictional salon ${index + 1}.`);
      const treatment = db.rows.treatments.find(item => item.beautician_id === row.beautician_id);
      expect(row.stages[1].output.posts.every(post => post.source_refs[0] === `treatment:${treatment.id}`)).toBe(true);
    }
    expect(db.rows[TABLE][3].status).toBe('queued'); expect(db.rows[TABLE][3].stages.every(stage => stage.attempts === 0)).toBe(true);
    expect(await service.process()).toEqual({ processed: 1, completed: 1 });
    expect(model).toHaveBeenCalledTimes(12); expect(peak).toBe(3);
    expect(db.operations.filter(op => op.action !== 'read').every(op => op.table === TABLE)).toBe(true);
  });
  it('retries only the failed stage and preserves earlier stable outputs', async () => {
    const saved = await service.enqueue(OWNER, body()); let fail = true;
    model.mockImplementation((stage, input) => { if (stage === 'writing' && fail) { fail = false; throw new Error('secret provider diagnostics'); } return response(stage, input); });
    await service.process(); const failed = (await service.get(OWNER)).run;
    expect(failed).toMatchObject({ status: 'failed', retryable: true }); expect(failed.error).not.toContain('secret');
    const completed = failed.stages[0].output;
    const retried = await service.retry(OWNER, saved.id); expect(retried.stages[0].output).toEqual(completed); expect(retried.status).toBe('queued');
    await service.process(); expect((await service.get(OWNER)).run.status).toBe('ready');
    expect(model.mock.calls.filter(call => call[0] === 'strategy')).toHaveLength(1); expect(model.mock.calls.filter(call => call[0] === 'writing')).toHaveLength(2);
  });
  it('keeps an older retried run visible ahead of newer completed work', async () => {
    const old = await service.enqueue(OWNER, body()); model.mockRejectedValueOnce(new Error('Temporary failure'));
    await service.process();
    clock = new Date(+clock + 60000);
    await service.enqueue(OWNER, body({ request_id: SECOND })); await service.process();
    expect((await service.get(OWNER)).run.id).not.toBe(old.id);
    await service.retry(OWNER, old.id); expect((await service.get(OWNER)).run).toMatchObject({ id: old.id, status: 'queued' });
  });
  it('keeps older full outputs reachable while history stays bounded, ordered and owner-only', async () => {
    const saved = await service.enqueue(OWNER, body()); await service.process();
    const template = copy(db.rows[TABLE][0]);
    for (let i = 1; i <= 22; i++) db.rows[TABLE].push({ ...copy(template), id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`, request_id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`, created_at: '2026-10-16T12:00:00Z' });
    db.rows[TABLE].push({ ...copy(template), id: OTHER, beautician_id: OTHER, brief: { focus: 'PRIVATE_OTHER_BRIEF' } });
    const result = await service.get(OWNER);
    expect(result.recent_runs).toHaveLength(20); expect(result.has_more).toBe(true); expect(result.next_offset).toBe(20);
    expect(result.recent_runs[0].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-000000000022');
    expect(result.recent_runs[19].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-000000000003');
    const older = await service.list(OWNER, { offset: '20', limit: '20' });
    expect(older.runs.map(run => run.id)).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', saved.id]);
    expect(older).toMatchObject({ has_more: false, next_offset: null });
    expect(JSON.stringify(result.recent_runs)).not.toMatch(/PRIVATE_OTHER_BRIEF|source_snapshot|stages|lease/);
    expect((await service.read(OWNER, saved.id)).stages[1].output.posts).toHaveLength(3);
    await expect(service.read(OTHER, saved.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.read(OWNER, 'not-a-run')).rejects.toMatchObject({ status: 400 });
    expect(model).toHaveBeenCalledTimes(3);
  });
  it('redacts status-bearing model provider errors from durable saved work', async () => {
    await service.enqueue(OWNER, body());
    model.mockRejectedValue(Object.assign(new Error('PRIVATE_PROVIDER_DETAILS'), { status: 401, code: 'PRIVATE_PROVIDER_CODE' }));
    await service.process();
    expect(JSON.stringify(await service.get(OWNER))).not.toMatch(/PRIVATE_PROVIDER/);
    expect(db.rows[TABLE][0].failure_code).toBe('generation_failed');
    expect((await service.get(OWNER)).run.retryable).toBe(true);
  });
  it('does not overwrite a completed stage when its save response is lost', async () => {
    await service.enqueue(OWNER, body());
    db.loseUpdateResponse = payload => payload.stages?.[0].status === 'complete';
    await service.process(); expect((await service.get(OWNER)).run.status).toBe('ready'); expect(model).toHaveBeenCalledTimes(3);
  });
  it('recovers an expired lease after restart without repeating a completed stage', async () => {
    const saved = await service.enqueue(OWNER, body());
    const row = db.rows[TABLE][0]; row.status = 'running'; row.lease_expires_at = new Date(+clock - 1).toISOString(); row.lease_token = SECOND;
    row.stages[0] = { id: 'strategy', status: 'complete', attempts: 1, output: validateTeamOutput('strategy', response('strategy', {}), { runId: saved.id, sourceIds: new Set([`treatment:${TREATMENT}`]) }) };
    await service.process(); expect(row.status).toBe('ready'); expect(model.mock.calls.map(call => call[0])).toEqual(['writing', 'reels']);
  });
  it('does not run an unexpired lease', async () => {
    await service.enqueue(OWNER, body()); Object.assign(db.rows[TABLE][0], { status: 'running', lease_expires_at: new Date(+clock + 10000).toISOString() });
    expect((await service.process()).processed).toBe(0); expect(model).not.toHaveBeenCalled();
  });
  it('stops if a treatment changes during generation, without saving the stale output', async () => {
    const saved = await service.enqueue(OWNER, body());
    model.mockImplementation((stage, input) => { db.rows.treatments[0].description = 'Different facts now.'; return response(stage, input); });
    await service.process(); const failed = (await service.get(OWNER)).run;
    expect(failed).toMatchObject({ status: 'failed', retryable: false }); expect(failed.stages[0].output).toBeNull();
    await expect(service.retry(OWNER, saved.id)).rejects.toMatchObject({ code: 'not_retryable' });
  });
  it('rechecks the subscription before saving model output and before the next stage', async () => {
    await service.enqueue(OWNER, body());
    model.mockImplementation((stage, input) => { db.rows.beauticians[0].subscription_status = 'cancelled'; return response(stage, input); });
    await service.process(); expect(model).toHaveBeenCalledOnce(); expect((await service.get(OWNER)).run).toMatchObject({ status: 'failed', retryable: false });
  });
  it('stops old workers from saving after their claim is replaced', async () => {
    await service.enqueue(OWNER, body());
    model.mockImplementation((stage, input) => { db.rows[TABLE][0].lease_token = SECOND; return response(stage, input); });
    await service.process(); expect(db.rows[TABLE][0].stages[0].output).toBeNull(); expect(db.rows[TABLE][0].lease_token).toBe(SECOND);
  });
  it('caps explicitly requested retries, without repeating completed stages or auto-retrying failed work', async () => {
    const saved = await service.enqueue(OWNER, body()); model.mockRejectedValue(new Error('Provider failed'));
    for (let i = 0; i < 3; i++) { if (i) await service.retry(OWNER, saved.id); await service.process(); }
    expect(model).toHaveBeenCalledTimes(3); expect((await service.get(OWNER)).run.retryable).toBe(false);
    await expect(service.retry(OWNER, saved.id)).rejects.toMatchObject({ code: 'not_retryable' });
    await service.process(); expect(model).toHaveBeenCalledTimes(3);
  });
  it('reports a missing migration without breaking the read or starting work', async () => {
    db.missing = true; expect(await service.get(OWNER)).toMatchObject({ available: false, run: null, reason: expect.stringContaining('being set up') });
    await expect(service.enqueue(OWNER, body())).rejects.toMatchObject({ status: 503, code: 'setup_required' });
    expect(await service.process()).toEqual({ processed: 0, unavailable: true }); expect(model).not.toHaveBeenCalled();
  });
  it('does not report a failed database read as empty ready work', async () => {
    db.failRead = true; expect((await service.get(OWNER)).available).toBe(false);
    await expect(service.enqueue(OWNER, body())).rejects.toMatchObject({ status: 503 }); expect(model).not.toHaveBeenCalled();
  });
});

describe('Content Team input and output boundary', () => {
  it.each([null, [], {}, body({ beautician_id: OTHER }), body({ request_id: 'not-uuid' }), body({ goal: 'virality' }), body({ focus: 'x'.repeat(601) }), body({ treatment_id: 'other' })])('rejects an invalid request before work: %j', value => expect(() => contentTeamRequest(value)).toThrow());
  it('rejects unknown output source references and unplanned caption ids', () => {
    const value = response('strategy', {}); value.posts[0].source_refs = ['client:private'];
    expect(() => validateTeamOutput('strategy', value, { runId: REQUEST, sourceIds: new Set(['brief']) })).toThrow('source');
    expect(() => validateTeamOutput('writing', { posts: Array(3).fill({ id: OTHER, caption: 'Test', format: 'feed' }), hooks: ['Test'] }, { strategy: { posts: [] } })).toThrow('match');
  });
  it('does not expose internal source snapshots, attempts or leases', () => {
    const value = publicTeamRun({ id: REQUEST, status: 'queued', stages: emptyTeamStages(), source_snapshot: { token: 'PRIVATE' }, lease_token: OTHER });
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|lease|attempt/);
  });
  it.each([{ offset: '-1' }, { offset: '1.2' }, { offset: '100001' }, { limit: '0' }, { limit: '51' }, { limit: ['2'] }, { beautician_id: OTHER }, { offset: '' }])('rejects invalid history pagination: %j', value => expect(() => contentTeamPagination(value)).toThrow());
  it('bounds Story text for a visible image while preserving feed caption capacity', () => {
    const strategy = validateTeamOutput('strategy', response('strategy', {}), { runId: REQUEST, sourceIds: new Set([`treatment:${TREATMENT}`]) });
    const writing = response('writing', { strategy });
    writing.posts[0].caption = 'f'.repeat(2200); writing.posts[1].caption = 's'.repeat(240);
    expect(validateTeamOutput('writing', writing, { strategy }).posts[1].caption).toHaveLength(240);
    writing.posts[1].caption += 's';
    expect(() => validateTeamOutput('writing', writing, { strategy })).toThrow('caption');
  });
  it.each([
    ['writing', 'Filming plan: walk through the treatment.'],
    ['writing', 'A little about your visit.\nAsset needed: filmed footage.'],
    ['writing', 'A little about your visit.\n- **Shot list:** film your chair.'],
    ['reels', 'Filming plan: walk through the treatment.'],
    ['reels', 'A little about your visit.\nAssets needed: salon footage.'],
    ['reels', 'A little about your visit.\nShot list: film the setup.'],
  ])('rejects owner production instructions in a %s caption: %s', (stage, caption) => {
    const context = { runId: REQUEST, sourceIds: new Set([`treatment:${TREATMENT}`]) };
    context.strategy = validateTeamOutput('strategy', response('strategy', {}), context);
    const output = response(stage, context);
    if (stage === 'writing') output.posts[2].caption = caption;
    else output.caption = caption;
    expect(() => validateTeamOutput(stage, output, context)).toThrow('filming instructions');
  });
  it.each([
    ['writing', 'caption', 'Check the link in bio.'],
    ['writing', 'hooks', 'Choose your visit through our bio link.'],
    ['reels', 'caption', 'Visit the link in our profile.'],
    ['reels', 'hook', 'See the link in my bio.'],
    ['reels', 'spoken', 'You can book using the profile link.'],
    ['reels', 'on_screen', 'Link in bio'],
  ])('rejects an unverified profile link in %s %s', (stage, field, value) => {
    const context = { runId: REQUEST, sourceIds: new Set([`treatment:${TREATMENT}`]) };
    context.strategy = validateTeamOutput('strategy', response('strategy', {}), context);
    const output = response(stage, context);
    if (stage === 'writing' && field === 'caption') output.posts[0].caption = value;
    else if (field === 'hooks') output.hooks = [value];
    else if (field === 'spoken' || field === 'on_screen') output.shots[0][field] = value;
    else output[field] = value;
    expect(() => validateTeamOutput(stage, output, context)).toThrow('booking link in your profile');
  });
  it('keeps normal client-facing filming copy and supplied booking URLs while allowing production notes in owner-only fields', () => {
    const context = { runId: REQUEST, sourceIds: new Set([`treatment:${TREATMENT}`]) };
    context.strategy = validateTeamOutput('strategy', response('strategy', {}), context);
    const writing = response('writing', context);
    writing.posts[2].caption = 'We enjoyed filming a little look around the salon. Check https://florrie.ai/book/fictional for your next visit.';
    const result = validateTeamOutput('writing', writing, context);
    expect(result.posts[2].caption).toBe(writing.posts[2].caption);
    const reels = response('reels', context);
    reels.caption = 'Here is a little look around the salon. Check the booking page for your next visit.';
    reels.shots[0].shot = 'Filming plan: film the clean treatment setup.';
    reels.needs = ['Asset needed: your own salon footage.'];
    reels.shots[1].on_screen = 'https://florrie.ai/book/fictional';
    const plan = validateTeamOutput('reels', reels, context);
    expect(plan.caption).toBe(reels.caption); expect(plan.needs).toContain(reels.needs[0]);
    expect(plan.shots[0].shot).toBe(reels.shots[0].shot);
  });
});
