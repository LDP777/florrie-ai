/**
 * The line between a note and a medical answer.
 *
 * Two things are being protected here. The first is that consultation answers
 * end up in consultation_responses, keyed by the field id that produced them,
 * so the surfaces that read a submitted form can read this one too. The second
 * is that nothing derived from client_notes ever leaves Florrie: that column
 * held the raw JSON of a client's allergy and medication answers and was being
 * pasted straight into a Google Calendar event body and an unauthenticated
 * iCal feed.
 *
 * The re-keying gets the most attention on purpose. Filing an answer under the
 * wrong question on a medical form is worse than not showing it, so a key that
 * cannot be matched has to come back unmatched rather than be guessed at.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BOOKING_QUESTIONS,
  splitBookingSubmission,
  groupAnswersByForm,
  splitDefaultAnswers,
  mapDefaultAnswersToFields,
  isStructuredClientNote,
  parseStoredClientNote,
  calendarDescription,
} from '../../src/lib/client-notes.js';

describe('splitBookingSubmission: a note and an answer are not the same thing', () => {
  it('keeps a plain note as plain text and never as JSON', () => {
    const out = splitBookingSubmission({ notes: 'Please can I park round the back', consultation: null });
    expect(out.plainNote).toBe('Please can I park round the back');
    expect(out.answers).toBeNull();
  });

  it('never lets an answer reach the note', () => {
    const out = splitBookingSubmission({
      notes: 'Running five minutes late usually',
      consultation: { f1: 'Latex' },
    });
    expect(out.plainNote).toBe('Running five minutes late usually');
    expect(out.plainNote).not.toContain('Latex');
    expect(out.answers).toEqual({ f1: 'Latex' });
  });

  it('returns answers with no note when only the form was filled in', () => {
    const out = splitBookingSubmission({ notes: null, consultation: { f1: 'Yes' } });
    expect(out.plainNote).toBeNull();
    expect(out.answers).toEqual({ f1: 'Yes' });
  });

  it('treats a whitespace only note as no note', () => {
    expect(splitBookingSubmission({ notes: '   \n ' }).plainNote).toBeNull();
  });

  it('drops untouched boxes so a medical record does not fill with blanks', () => {
    const out = splitBookingSubmission({
      consultation: { f1: '', f2: [], f3: '   ', f4: 'Nut oils' },
    });
    expect(out.answers).toEqual({ f4: 'Nut oils' });
  });

  it('keeps false, because an unticked box is a real answer', () => {
    const out = splitBookingSubmission({ consultation: { f1: false } });
    expect(out.answers).toEqual({ f1: false });
  });

  it('reports nothing at all when the form came back empty', () => {
    expect(splitBookingSubmission({ notes: null, consultation: { f1: '', f2: [] } }).answers).toBeNull();
    expect(splitBookingSubmission({}).answers).toBeNull();
    expect(splitBookingSubmission({ consultation: 'not an object' }).answers).toBeNull();
  });
});

describe('groupAnswersByForm: one row per form, one form per row', () => {
  const brows = { id: 'form-brows', fields: [{ id: 'b1', type: 'text' }, { id: 'b2', type: 'yes_no' }] };
  const lashes = { id: 'form-lashes', fields: [{ id: 'l1', type: 'multi_select' }] };

  it('splits a two form booking into two rows', () => {
    const { groups, unmatched } = groupAnswersByForm({
      forms: [brows, lashes],
      answers: { b1: 'Nut oils', b2: 'Yes', l1: ['Latex'] },
    });
    expect(unmatched).toEqual({});
    expect(groups).toHaveLength(2);
    expect(groups.find(g => g.form_id === 'form-brows').answers).toEqual({ b1: 'Nut oils', b2: 'Yes' });
    expect(groups.find(g => g.form_id === 'form-lashes').answers).toEqual({ l1: ['Latex'] });
  });

  it('lifts a signature out of the answers into its own column', () => {
    const withSig = { id: 'f', fields: [{ id: 'a', type: 'text' }, { id: 's', type: 'signature' }] };
    const { groups } = groupAnswersByForm({
      forms: [withSig],
      answers: { a: 'None', s: 'Sarah Doyle' },
    });
    // renderResponse skips signature fields and reports from signature_data,
    // so a signature left in the blob would never be shown.
    expect(groups[0].answers).toEqual({ a: 'None' });
    expect(groups[0].signature).toBe('Sarah Doyle');
  });

  it('ignores an empty signature rather than storing a blank one', () => {
    const withSig = { id: 'f', fields: [{ id: 's', type: 'signature' }] };
    const { groups } = groupAnswersByForm({ forms: [withSig], answers: { s: '  ' } });
    expect(groups).toHaveLength(0);
  });

  it('never guesses at a key it does not recognise', () => {
    const { groups, unmatched } = groupAnswersByForm({
      forms: [brows],
      answers: { b1: 'Nut oils', mystery: 'Yes' },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].answers).toEqual({ b1: 'Nut oils' });
    expect(unmatched).toEqual({ mystery: 'Yes' });
  });

  it('returns everything unmatched when no form was linked', () => {
    const { groups, unmatched } = groupAnswersByForm({ forms: [], answers: { allergies: 'Latex' } });
    expect(groups).toEqual([]);
    expect(unmatched).toEqual({ allergies: 'Latex' });
  });
});

describe('the booking page built in questions', () => {
  it('separates the known keys from anything else', () => {
    const { defaults, leftover } = splitDefaultAnswers({ allergies: 'Latex', wat: 'x' });
    expect(defaults).toEqual({ allergies: 'Latex' });
    expect(leftover).toEqual({ wat: 'x' });
  });

  it('re-keys onto the backing form by label', () => {
    const fields = DEFAULT_BOOKING_QUESTIONS.map((q, i) => ({ id: `fid-${i}`, label: q.label }));
    const { answers, unmapped } = mapDefaultAnswersToFields({
      answers: { allergies: 'Latex', pregnant: 'Yes' },
      fields,
    });
    expect(answers).toEqual({ 'fid-0': 'Latex', 'fid-3': 'Yes' });
    expect(unmapped).toEqual({});
  });

  it('matches a label that differs only in spacing', () => {
    const fields = [{ id: 'x', label: `  ${DEFAULT_BOOKING_QUESTIONS[0].label}  ` }];
    const { answers } = mapDefaultAnswersToFields({ answers: { allergies: 'Latex' }, fields });
    expect(answers).toEqual({ x: 'Latex' });
  });

  it('leaves an answer unmapped rather than filing it under the wrong question', () => {
    // She edited the form and deleted the allergy question. Position based
    // matching would put the allergy answer under "patch test in 6 months".
    const fields = [
      { id: 'kept-1', label: DEFAULT_BOOKING_QUESTIONS[1].label },
      { id: 'kept-2', label: DEFAULT_BOOKING_QUESTIONS[2].label },
    ];
    const { answers, unmapped } = mapDefaultAnswersToFields({
      answers: { allergies: 'Latex', patch_test: 'No' },
      fields,
    });
    expect(answers).toEqual({ 'kept-1': 'No' });
    expect(unmapped).toEqual({ allergies: 'Latex' });
  });
});

describe('reading back what the old booking path stored', () => {
  const legacy = JSON.stringify({
    notes: 'Park round the back please',
    consultation: { allergies: 'Latex', pregnant: 'Yes' },
  });

  it('knows the legacy blob is not a note', () => {
    expect(isStructuredClientNote(legacy)).toBe(true);
    expect(isStructuredClientNote('Park round the back please')).toBe(false);
    expect(isStructuredClientNote('')).toBe(false);
    expect(isStructuredClientNote(null)).toBe(false);
  });

  it('treats a truncated blob as structured, because the column caps at 2000', () => {
    expect(isStructuredClientNote('{"notes":"","consultation":{"allergies":"Lat')).toBe(true);
  });

  it('pulls the note and the answers back apart', () => {
    const out = parseStoredClientNote(legacy);
    expect(out.structured).toBe(true);
    expect(out.parseFailed).toBe(false);
    expect(out.plainNote).toBe('Park round the back please');
    expect(out.answers).toEqual({ allergies: 'Latex', pregnant: 'Yes' });
  });

  it('reports no note when the client only filled in the form', () => {
    const out = parseStoredClientNote(JSON.stringify({ notes: '', consultation: { allergies: 'None' } }));
    expect(out.plainNote).toBeNull();
    expect(out.answers).toEqual({ allergies: 'None' });
  });

  it('hands a plain note straight back', () => {
    const out = parseStoredClientNote('Imported from Timely. Staff: Ellie');
    expect(out.structured).toBe(false);
    expect(out.plainNote).toBe('Imported from Timely. Staff: Ellie');
    expect(out.answers).toBeNull();
  });

  it('keeps a blob it cannot parse exactly as it is, and files nothing', () => {
    const broken = '{"notes":"hi","consultation":{"allergies":"Lat';
    const out = parseStoredClientNote(broken);
    expect(out.parseFailed).toBe(true);
    expect(out.answers).toBeNull();
    expect(out.plainNote).toBe(broken);
  });

  it('refuses JSON that is not the shape the booking page wrote', () => {
    const out = parseStoredClientNote('{"something":"else"}');
    expect(out.parseFailed).toBe(true);
    expect(out.answers).toBeNull();
    expect(out.plainNote).toBe('{"something":"else"}');
  });

  it('says nothing about an empty column', () => {
    expect(parseStoredClientNote(null)).toEqual({
      plainNote: null, answers: null, structured: false, parseFailed: false,
    });
  });
});

describe('calendarDescription: what a third party is allowed to be told', () => {
  const answers = 'Latex allergy, on antibiotics';

  it('carries the treatment, the length, a reference and the way back', () => {
    const body = calendarDescription({
      treatmentName: 'Classic lash set',
      durationMinutes: 90,
      appointmentId: 'abcdef12-3456-7890-abcd-ef1234567890',
      appUrl: 'https://app.florrie.ai/calendar',
    });
    expect(body).toContain('Booked via Florrie');
    expect(body).toContain('Classic lash set');
    expect(body).toContain('90 minutes');
    expect(body).toContain('Ref abcdef12');
    expect(body).toContain('https://app.florrie.ai/calendar');
  });

  it('takes no note argument at all, so no note can be passed by accident', () => {
    // The whole guarantee: this builder has no input a note could arrive on.
    const body = calendarDescription({
      treatmentName: 'Brow lamination',
      durationMinutes: 45,
      appointmentId: 'id',
      appUrl: 'https://app.florrie.ai/calendar',
      client_notes: answers,
      note: answers,
      description: answers,
    });
    expect(body).not.toContain('Latex');
    expect(body).not.toContain('antibiotics');
  });

  it('still reads as something when nothing is known about the booking', () => {
    const body = calendarDescription({});
    expect(body).toBe('Booked via Florrie\nNotes and consultation answers stay in Florrie.');
  });

  it('leaves out a duration that makes no sense', () => {
    expect(calendarDescription({ durationMinutes: 0 })).not.toContain('minutes');
    expect(calendarDescription({ durationMinutes: null })).not.toContain('minutes');
  });
});
