/**
 * Asking about consultation forms by voice.
 *
 * The test that matters most is the last group: the answers a client gave
 * must never appear in the string the model is handed, because that string is
 * what gets spoken out loud in a room Florrie cannot see. Everything else
 * here is about not reassuring her wrongly.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  consultationStatusForClient,
  consultationsOutstanding,
  patchTestStatusForClient,
  patchTestsOutstanding,
  resolveSendableForm,
} from '../../src/services/voice-consultation.js';

const BID = 'b-1';
const client = { id: 'c-1', first_name: 'Megan', last_name: 'Doyle' };

/**
 * A Supabase stub that answers per table and actually honours the filters.
 *
 * It has to honour them: patch_tests is queried twice in one function, once
 * with `.is('confirmed_at', null)` and once without, and a stub that ignores
 * the filter makes a confirmed patch test look outstanding. That is the exact
 * bug the tool is meant to catch, so the stub cannot be the thing that hides it.
 */
function db(tables) {
  return {
    from(table) {
      const spec = tables[table];
      const filters = [];
      const rows = () => {
        if (spec === undefined) return { data: [], error: null };
        if (spec.error) return spec;
        const kept = (spec.data || []).filter(r => filters.every(f => f(r)));
        return { data: kept, error: null };
      };
      const chain = {
        select() { return chain; },
        eq(col, val) { filters.push(r => !(col in r) || r[col] === val); return chain; },
        in(col, vals) { filters.push(r => !(col in r) || vals.includes(r[col])); return chain; },
        is(col, val) { filters.push(r => (r[col] ?? null) === val); return chain; },
        not() { return chain; },
        gte() { return chain; },
        lte() { return chain; },
        order() { return chain; },
        maybeSingle() {
          const out = rows();
          return Promise.resolve(out.error ? out : { data: (out.data || [])[0] || null, error: null });
        },
        limit(n) {
          const out = rows();
          if (out.error) return Promise.resolve(out);
          // Honour it. The code under test asks for one row and relies on the
          // exact count for "she has N on file", so a stub that returns
          // everything would pass a test production fails.
          return Promise.resolve({ data: (out.data || []).slice(0, n), error: null, count: (out.data || []).length });
        },
        then(res, rej) { return Promise.resolve(rows()).then(res, rej); },
      };
      return chain;
    },
  };
}

const FORM = {
  name: 'Lash consultation',
  consent_text: null,
  consultation_form_fields: [
    { id: 'q1', type: 'text', label: 'Do you have any known allergies?', options: [], sort_order: 0 },
    { id: 'q2', type: 'yes_no', label: 'Are you pregnant or breastfeeding?', options: [], sort_order: 1 },
  ],
};

const RESPONSE = {
  id: 'r-1',
  form_id: 'f-1',
  client_id: 'c-1',
  appointment_id: null,
  status: 'completed',
  completed_at: '2026-07-14T09:00:00+00:00',
  created_at: '2026-07-14T09:00:00+00:00',
  answers: { q1: 'Latex and nut oils', q2: 'No' },
  signature_data: null,
  consultation_forms: FORM,
};

describe('consultationStatusForClient', () => {
  it('says when it was filled in and how many things are flagged', async () => {
    const supabase = db({ consultation_responses: { data: [RESPONSE], error: null } });
    const { result, data } = await consultationStatusForClient({ supabase, beauticianId: BID, client });

    expect(result).toContain('Megan Doyle');
    expect(result).toContain('14 July');
    expect(result).toContain('1 thing worth knowing');
    expect(data.consultation.worth_knowing).toHaveLength(1);
  });

  it('says nothing is flagged when nothing is', async () => {
    const clean = { ...RESPONSE, answers: { q1: 'No', q2: 'No' } };
    const supabase = db({ consultation_responses: { data: [clean], error: null } });
    const { result } = await consultationStatusForClient({ supabase, beauticianId: BID, client });
    expect(result).toContain('Nothing flagged');
  });

  it('speaks the real number on file, not the page size', async () => {
    const many = [1, 2, 3, 4, 5, 6].map(n => ({ ...RESPONSE, id: `r-${n}` }));
    const supabase = db({ consultation_responses: { data: many, error: null } });
    const { result, data } = await consultationStatusForClient({ supabase, beauticianId: BID, client });
    expect(result).toContain('6 on file');
    expect(data.count).toBe(6);
    // And only the one she asked about travels, not six medical records.
    expect(data.history).toBeUndefined();
  });

  it('offers to send one when there is nothing on file', async () => {
    const supabase = db({ consultation_responses: { data: [], error: null } });
    const { result, data } = await consultationStatusForClient({ supabase, beauticianId: BID, client });
    expect(result).toContain('Nothing on file');
    expect(data.consultation).toBeNull();
  });

  // A read failure that reads as "nothing on file" is the worst answer this
  // tool can give: it reassures her about a client who has an allergy on record.
  it('refuses rather than reassures when the lookup fails', async () => {
    const supabase = db({ consultation_responses: { data: null, error: { message: 'boom' } } });
    const { result, data } = await consultationStatusForClient({ supabase, beauticianId: BID, client });
    expect(result).toContain('could not read');
    expect(result).not.toContain('Nothing on file');
    expect(data.failed).toBe(true);
  });
});

describe('consultationsOutstanding', () => {
  const appt = (over = {}) => ({
    id: 'a-1', starts_at: '2026-08-07T10:00:00+00:00', client_id: 'c-1',
    treatment_id: 't-1', extra_treatment_ids: null,
    clients: { id: 'c-1', first_name: 'Megan', last_name: 'Doyle' }, ...over,
  });

  it('names who is booked with no form on file', async () => {
    const supabase = db({
      appointments: { data: [appt()], error: null },
      treatments: { data: [{ id: 't-1', requires_consultation: true }], error: null },
      consultation_responses: { data: [], error: null },
    });
    const { result, data } = await consultationsOutstanding({
      supabase, beauticianId: BID, start_date: '2026-08-03', end_date: '2026-08-09',
    });
    expect(result).toContain('Megan Doyle');
    expect(data.needed).toHaveLength(1);
  });

  it('leaves out anyone who has already done one', async () => {
    const supabase = db({
      appointments: { data: [appt()], error: null },
      treatments: { data: [{ id: 't-1', requires_consultation: true }], error: null },
      consultation_responses: { data: [{ client_id: 'c-1' }], error: null },
    });
    const { result, data } = await consultationsOutstanding({ supabase, beauticianId: BID });
    expect(data.needed).toHaveLength(0);
    expect(result).toContain('already done one');
  });

  // A brow tint added on the day can be the treatment that needs the form,
  // and it lives in extra_treatment_ids, not treatment_id.
  it('counts treatments added to an existing booking', async () => {
    const supabase = db({
      appointments: { data: [appt({ treatment_id: 't-plain', extra_treatment_ids: ['t-tint'] })], error: null },
      treatments: { data: [
        { id: 't-plain', requires_consultation: false },
        { id: 't-tint', requires_consultation: true },
      ], error: null },
      consultation_responses: { data: [], error: null },
    });
    const { data } = await consultationsOutstanding({ supabase, beauticianId: BID });
    expect(data.needed).toHaveLength(1);
  });

  it('says it could not check rather than saying nobody needs one', async () => {
    const supabase = db({
      appointments: { data: [appt()], error: null },
      treatments: { data: null, error: { message: 'boom' } },
    });
    const { result, data } = await consultationsOutstanding({ supabase, beauticianId: BID });
    expect(result).toContain('could not check');
    expect(data.failed).toBe(true);
  });

  // The client in the chair right now is exactly who she is asking about.
  it('counts the appointment that is in progress', async () => {
    const supabase = db({
      appointments: { data: [appt({ status: 'in_progress' })], error: null },
      treatments: { data: [{ id: 't-1', requires_consultation: true }], error: null },
      consultation_responses: { data: [], error: null },
    });
    const { data } = await consultationsOutstanding({ supabase, beauticianId: BID });
    expect(data.needed).toHaveLength(1);
  });

  it('lists one line per person, not per booking', async () => {
    const supabase = db({
      appointments: { data: [appt(), appt({ id: 'a-2', starts_at: '2026-08-08T10:00:00+00:00' })], error: null },
      treatments: { data: [{ id: 't-1', requires_consultation: true }], error: null },
      consultation_responses: { data: [], error: null },
    });
    const { data } = await consultationsOutstanding({ supabase, beauticianId: BID });
    expect(data.needed).toHaveLength(1);
  });
});

describe('patch tests: only what the data knows', () => {
  // confirmed_at is written when the CLIENT BOOKS THE SLOT, alongside
  // status: 'pending' // awaiting result. All 22 production rows say pending
  // for both status and result, so a pass has never been recorded and may
  // never be claimed.
  const pt = (over = {}) => ({
    id: 'p-1', test_date: '2026-07-01', confirmed_at: null,
    appointment_id: null, appointments: null, ...over,
  });

  it('says a slot still needs booking', async () => {
    const supabase = db({ patch_tests: { data: [pt()], error: null } });
    const { result, data } = await patchTestStatusForClient({ supabase, beauticianId: BID, client });
    expect(data.patch_test_state).toBe('unbooked');
    expect(result).toContain('no slot booked');
  });

  it('a booked slot is booked, not done', async () => {
    const supabase = db({ patch_tests: { data: [pt({
      confirmed_at: '2026-08-01T09:00:00+00:00',
      appointments: { starts_at: '2026-08-11T10:00:00+00:00', status: 'confirmed' },
    })], error: null } });
    const { result, data } = await patchTestStatusForClient({ supabase, beauticianId: BID, client });
    expect(data.patch_test_state).toBe('booked');
    expect(result).toContain('booked');
    expect(result).toContain('11 August');
    expect(result).toContain('not been marked as done');
  });

  it('a completed appointment means she came in, and nothing more', async () => {
    const supabase = db({ patch_tests: { data: [pt({
      confirmed_at: '2026-07-01T09:00:00+00:00',
      appointments: { starts_at: '2026-07-04T10:00:00+00:00', status: 'completed' },
    })], error: null } });
    const { result, data } = await patchTestStatusForClient({ supabase, beauticianId: BID, client });
    expect(data.patch_test_state).toBe('attended');
    expect(result).toContain('came in for her patch test');
    expect(result).toContain('4 July');
  });

  it('never says passed, cleared, valid or expired, in any state', async () => {
    const states = [
      [],
      [pt()],
      [pt({ confirmed_at: '2026-08-01T09:00:00+00:00', appointments: { starts_at: '2026-08-11T10:00:00+00:00', status: 'confirmed' } })],
      [pt({ confirmed_at: '2026-07-01T09:00:00+00:00', appointments: { starts_at: '2026-07-04T10:00:00+00:00', status: 'completed' } })],
    ];
    for (const data of states) {
      const supabase = db({ patch_tests: { data, error: null } });
      const { result } = await patchTestStatusForClient({ supabase, beauticianId: BID, client });
      expect(result).not.toMatch(/passed|failed|cleared|valid|expired|is patch tested/i);
    }
  });

  it('says there is nothing on record rather than implying she is sorted', async () => {
    const supabase = db({ patch_tests: { data: [], error: null } });
    const { result } = await patchTestStatusForClient({ supabase, beauticianId: BID, client });
    expect(result).toContain('no patch test on record');
  });

  // The reassuring answer must never be the one a broken query produces.
  it('refuses rather than reassures when the lookup fails', async () => {
    const supabase = db({ patch_tests: { data: null, error: { message: 'boom' } } });
    const { result, data } = await patchTestStatusForClient({ supabase, beauticianId: BID, client });
    expect(result).toContain('could not check');
    expect(data.failed).toBe(true);
  });

  it('the weekly list says it could not check rather than everyone is fine', async () => {
    const supabase = db({
      appointments: { data: [{ id: 'a-1', starts_at: '2026-08-07T10:00:00+00:00', client_id: 'c-1', clients: client }], error: null },
      patch_tests: { data: null, error: { message: 'boom' } },
    });
    const { result, data } = await patchTestsOutstanding({ supabase, beauticianId: BID });
    expect(result).toContain('could not check');
    expect(data.failed).toBe(true);
  });

  it('an empty weekly list does not claim everyone is patch tested', async () => {
    const supabase = db({
      appointments: { data: [{ id: 'a-1', starts_at: '2026-08-07T10:00:00+00:00', client_id: 'c-1', clients: client }], error: null },
      patch_tests: { data: [], error: null },
    });
    const { result } = await patchTestsOutstanding({ supabase, beauticianId: BID });
    expect(result).not.toMatch(/patch tested|passed|cleared/i);
    expect(result).toContain('waiting to be booked');
  });
});

describe('resolveSendableForm agrees with the sender', () => {
  it('prefers the treatment linked form', async () => {
    const supabase = db({ treatments: { data: [{ consultation_form_id: 'f-treat' }], error: null } });
    expect(await resolveSendableForm({ supabase, beauticianId: BID, treatmentId: 't-1' }))
      .toEqual({ formId: 'f-treat', via: 'treatment' });
  });

  // Ellie has three ACTIVE forms and no DEFAULT one. "Any active form" would
  // say yes here and then the send would fail after she tapped confirm.
  it('returns nothing when there are active forms but no default one', async () => {
    const supabase = db({
      treatments: { data: [{ consultation_form_id: null }], error: null },
      consultation_forms: { data: [], error: null },
    });
    expect(await resolveSendableForm({ supabase, beauticianId: BID, treatmentId: 't-1' }))
      .toEqual({ formId: null, via: null });
  });
});

/**
 * THE GUARD.
 *
 * The orchestrator hands `result` to the model and shows `data` only to the
 * app. So an answer that never appears in `result` cannot be spoken, whatever
 * the prompt says, whoever edits it, and whichever model is behind it.
 */
describe('answers never reach the spoken string', () => {
  const SECRETS = ['Latex', 'nut oils', 'antibiotics', 'warfarin'];

  it('keeps the answer text out of result and in data', async () => {
    const loaded = {
      ...RESPONSE,
      answers: { q1: 'Latex and nut oils, plus antibiotics and warfarin', q2: 'Yes' },
    };
    const supabase = db({ consultation_responses: { data: [loaded], error: null } });
    const { result, data } = await consultationStatusForClient({ supabase, beauticianId: BID, client });

    for (const secret of SECRETS) {
      expect(result.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    // And it really is there for the screen, so this is a routing rule and
    // not just an empty payload.
    expect(JSON.stringify(data).toLowerCase()).toContain('latex');
  });

  it('does not read a flagged question back either', async () => {
    const supabase = db({ consultation_responses: { data: [RESPONSE], error: null } });
    const { result } = await consultationStatusForClient({ supabase, beauticianId: BID, client });
    expect(result.toLowerCase()).not.toContain('allerg');
    expect(result).toContain('worth knowing');
  });

  it('a who-needs-one list carries names and times only', async () => {
    const supabase = db({
      appointments: { data: [{
        id: 'a-1', starts_at: '2026-08-07T10:00:00+00:00', client_id: 'c-1',
        treatment_id: 't-1', extra_treatment_ids: null, clients: client,
      }], error: null },
      treatments: { data: [{ id: 't-1', requires_consultation: true }], error: null },
      consultation_responses: { data: [], error: null },
    });
    const { result } = await consultationsOutstanding({ supabase, beauticianId: BID });
    expect(result).toContain('Megan Doyle');
    for (const secret of SECRETS) {
      expect(result.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });
});
