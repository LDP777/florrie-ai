/**
 * The consultation answer renderer, tested against the shapes the public form
 * actually writes rather than the ones a schema comment implies.
 *
 * Two things matter here. First, the pairing: answers are keyed by field id,
 * so a mismatch shows Ellie a wall of uuids or, worse, the wrong answer under
 * the wrong question on a medical form. Second, the flagging: it has to catch
 * a real allergy and stay silent on a "no", because a chip that fires on
 * every row is a chip she stops reading.
 */
import { describe, it, expect } from 'vitest';
import {
  isRiskQuestion,
  isFollowUpQuestion,
  isNegativeAnswer,
  formatAnswer,
  isWorthKnowing,
  worthKnowingNote,
  renderResponse,
  shapeResponse,
} from '../../src/lib/consultation-answers.js';

const field = (over = {}) => ({
  id: 'f1', type: 'text', label: 'Question', options: [], sort_order: 0, ...over,
});

describe('formatAnswer: the real stored shapes', () => {
  it('reads short text straight through', () => {
    expect(formatAnswer(field({ type: 'text' }), 'Nut oils')).toBe('Nut oils');
  });

  it('trims a long text answer without truncating it', () => {
    const long = 'I had a reaction to a lash lift in 2023, my eyes swelled for two days   ';
    expect(formatAnswer(field({ type: 'text' }), long)).toBe(long.trim());
  });

  it('yes_no arrives as the STRING Yes or No, not a boolean', () => {
    expect(formatAnswer(field({ type: 'yes_no' }), 'Yes')).toBe('Yes');
    expect(formatAnswer(field({ type: 'yes_no' }), 'No')).toBe('No');
  });

  it('a checkbox is a boolean, and false is an answer not a blank', () => {
    expect(formatAnswer(field({ type: 'checkbox' }), true)).toBe('Ticked');
    expect(formatAnswer(field({ type: 'checkbox' }), false)).toBe('Not ticked');
    expect(formatAnswer(field({ type: 'checkbox' }), undefined)).toBeNull();
  });

  it('single_select is one string', () => {
    expect(formatAnswer(field({ type: 'single_select' }), 'Sensitive')).toBe('Sensitive');
  });

  it('multi_select is an array, joined for reading', () => {
    expect(formatAnswer(field({ type: 'multi_select' }), ['Nuts', 'Latex'])).toBe('Nuts, Latex');
  });

  it('an empty multi_select counts as not answered', () => {
    expect(formatAnswer(field({ type: 'multi_select' }), [])).toBeNull();
  });

  it('an empty string counts as not answered', () => {
    expect(formatAnswer(field({ type: 'text' }), '   ')).toBeNull();
  });
});

describe('isRiskQuestion', () => {
  it('catches the questions that carry clinical weight', () => {
    for (const label of [
      'Do you have any allergies?',
      'Are you taking any medication?',
      'Any medical conditions we should know about?',
      'Are you pregnant or breastfeeding?',
      'Have you ever had a reaction to lash glue?',
      'Do you have eczema or psoriasis?',
      'Have you had a patch test before?',
      'Is your skin sensitive?',
    ]) {
      expect(isRiskQuestion(label), label).toBe(true);
    }
  });

  it('leaves routine questions alone', () => {
    for (const label of [
      'What is your preferred lash length?',
      'How did you hear about us?',
      'Would you like to join the mailing list?',
      'Preferred appointment day',
    ]) {
      expect(isRiskQuestion(label), label).toBe(false);
    }
  });

  it('does not treat a terms and conditions tick as medical', () => {
    // /condition/ matched this, which turned every consent form into a flag.
    expect(isRiskQuestion('I agree to the terms and conditions')).toBe(false);
    expect(isRiskQuestion('I have read the cancellation policy')).toBe(false);
  });
});

describe('isFollowUpQuestion: the detail box under the real question', () => {
  it('recognises the wordings real forms use', () => {
    for (const label of [
      'If yes, please list them',
      'If so, give details',
      'Please list any medication',
      'Details',
      'If applicable, describe the reaction',
    ]) {
      expect(isFollowUpQuestion(label), label).toBe(true);
    }
  });

  it('does not treat an ordinary question as a follow-up', () => {
    expect(isFollowUpQuestion('What is your preferred lash length?')).toBe(false);
  });
});

describe('isNegativeAnswer', () => {
  it('treats the many ways of saying no as nothing to report', () => {
    for (const v of ['No', 'none', 'N/A', 'n/a', 'nil', 'None of the above',
      'none that I know of', 'No known allergies', 'nothing', '-', '']) {
      expect(isNegativeAnswer(v), v).toBe(true);
    }
  });

  it('ignores trailing punctuation', () => {
    expect(isNegativeAnswer('None.')).toBe(true);
  });

  it('does not swallow a real answer that merely starts with no', () => {
    expect(isNegativeAnswer('Nothing except nut oils')).toBe(false);
    expect(isNegativeAnswer('No, but I react to latex')).toBe(false);
  });
});

describe('isWorthKnowing', () => {
  it('flags a yes to a risk question', () => {
    expect(isWorthKnowing({ type: 'yes_no', question: 'Do you have any allergies?', answer: 'Yes' })).toBe(true);
  });

  it('does NOT flag a no to a risk question', () => {
    expect(isWorthKnowing({ type: 'yes_no', question: 'Do you have any allergies?', answer: 'No' })).toBe(false);
  });

  it('does not flag a yes to a question that is not about risk', () => {
    expect(isWorthKnowing({ type: 'yes_no', question: 'Would you like a hot drink?', answer: 'Yes' })).toBe(false);
  });

  it('flags free text under a risk question when it says something', () => {
    expect(isWorthKnowing({ type: 'text', question: 'Any allergies?', answer: 'Nut oils' })).toBe(true);
    expect(isWorthKnowing({ type: 'text', question: 'Any allergies?', answer: 'None' })).toBe(false);
  });

  it('flags a multi_select once anything real is picked', () => {
    expect(isWorthKnowing({ type: 'multi_select', question: 'Any medical conditions?', answer: 'Diabetes, Asthma' })).toBe(true);
    expect(isWorthKnowing({ type: 'multi_select', question: 'Any medical conditions?', answer: 'None of the above' })).toBe(false);
  });

  it('flags a ticked risk checkbox and not an unticked one', () => {
    expect(isWorthKnowing({ type: 'checkbox', question: 'I have a skin condition', answer: 'Ticked' })).toBe(true);
    expect(isWorthKnowing({ type: 'checkbox', question: 'I have a skin condition', answer: 'Not ticked' })).toBe(false);
  });

  it('flags a detail box only when it belongs to a flagged question', () => {
    const detail = { type: 'text', question: 'If yes, please list them', answer: 'Nut oils' };
    expect(isWorthKnowing(detail)).toBe(false);
    expect(isWorthKnowing(detail, { inheritsRisk: true })).toBe(true);
  });

  it('never flags an unanswered question', () => {
    expect(isWorthKnowing({ type: 'text', question: 'Any allergies?', answer: null })).toBe(false);
  });
});

describe('worthKnowingNote: neutral wording, no medical judgement', () => {
  it('reports a yes as a yes', () => {
    expect(worthKnowingNote({ type: 'yes_no', question: 'any allergies?', answer: 'Yes' }))
      .toBe('She answered yes to: any allergies?');
  });

  it('reports a tick as a tick', () => {
    expect(worthKnowingNote({ type: 'checkbox', question: 'I have a skin condition', answer: 'Ticked' }))
      .toBe('She ticked: I have a skin condition');
  });

  it('quotes what the client actually wrote', () => {
    expect(worthKnowingNote({ type: 'text', question: 'Any allergies?', answer: 'Nut oils' }))
      .toBe('She answered "Nut oils" to: Any allergies?');
  });

  it('shortens a very long answer for the one line summary', () => {
    const note = worthKnowingNote({ type: 'text', question: 'Any allergies?', answer: 'x'.repeat(400) });
    expect(note.length).toBeLessThan(200);
    expect(note.endsWith('to: Any allergies?')).toBe(true);
  });
});

describe('renderResponse', () => {
  const fields = [
    field({ id: 'a', type: 'text_block', label: 'Please answer honestly.', sort_order: 0 }),
    field({ id: 'b', type: 'yes_no', label: 'Do you have any allergies?', sort_order: 1 }),
    field({ id: 'c', type: 'text', label: 'If yes, please list them', sort_order: 2 }),
    field({ id: 'd', type: 'multi_select', label: 'Preferred lash style', options: ['Classic', 'Hybrid'], sort_order: 3 }),
    field({ id: 'e', type: 'checkbox', label: 'I agree to the terms and conditions', sort_order: 4 }),
    field({ id: 'f', type: 'signature', label: 'Signature', sort_order: 5 }),
  ];

  it('pairs every answer back to its question', () => {
    const { pairs } = renderResponse({
      fields,
      answers: { b: 'Yes', c: 'Nut oils', d: ['Hybrid'], e: true },
    });
    const byId = Object.fromEntries(pairs.map(p => [p.field_id, p]));
    expect(byId.b.answer).toBe('Yes');
    expect(byId.c.answer).toBe('Nut oils');
    expect(byId.d.answer).toBe('Hybrid');
    expect(byId.e.answer).toBe('Ticked');
  });

  it('drops text blocks: they are paragraphs, not questions', () => {
    const { pairs } = renderResponse({ fields, answers: { b: 'No' } });
    expect(pairs.some(p => p.field_id === 'a')).toBe(false);
  });

  it('keeps the builder order, because a consent form read out of order says something else', () => {
    const shuffled = [fields[3], fields[1], fields[2]];
    const { pairs } = renderResponse({ fields: shuffled, answers: {} });
    expect(pairs.map(p => p.field_id)).toEqual(['b', 'c', 'd']);
  });

  it('marks an unanswered optional question rather than showing a blank', () => {
    const { pairs } = renderResponse({ fields, answers: { b: 'No' } });
    const c = pairs.find(p => p.field_id === 'c');
    expect(c.answered).toBe(false);
    expect(c.answer).toBeNull();
  });

  it('reports the signature from its own column, not from the answers blob', () => {
    const withSig = renderResponse({ fields, answers: { b: 'No' }, hasSignature: true });
    expect(withSig.pairs.at(-1)).toMatchObject({ type: 'signature', answer: 'Signed by the client' });

    const withoutSig = renderResponse({ fields, answers: { b: 'No' }, hasSignature: false });
    expect(withoutSig.pairs.some(p => p.type === 'signature')).toBe(false);
  });

  it('surfaces only the answers worth knowing', () => {
    const { worth_knowing } = renderResponse({
      fields,
      answers: { b: 'Yes', c: 'Nut oils', d: ['Hybrid'], e: true },
    });
    expect(worth_knowing).toEqual([
      'She answered yes to: Do you have any allergies?',
      'She answered "Nut oils" to: If yes, please list them',
    ]);
  });

  it('says nothing when the client answered no to everything', () => {
    const { worth_knowing } = renderResponse({
      fields,
      answers: { b: 'No', c: 'None', d: ['Classic'], e: true },
    });
    expect(worth_knowing).toEqual([]);
  });

  it('survives a missing or malformed answers blob instead of throwing', () => {
    expect(renderResponse({ fields, answers: null }).pairs.length).toBe(4);
    expect(renderResponse({ fields, answers: 'nonsense' }).pairs.length).toBe(4);
    expect(renderResponse({}).pairs).toEqual([]);
  });
});

describe('shapeResponse', () => {
  const row = {
    id: 'r1',
    form_id: 'form1',
    client_id: 'cl1',
    appointment_id: 'ap1',
    completed_at: '2026-07-14T10:30:00Z',
    answers: { q1: 'Yes' },
    signature_data: 'data:image/png;base64,AAA',
    consultation_forms: {
      name: 'Lash Consultation',
      consultation_form_fields: [field({ id: 'q1', type: 'yes_no', label: 'Any allergies?' })],
    },
  };

  it('never lets the signature image into the payload', () => {
    const shaped = shapeResponse(row);
    expect(shaped.has_signature).toBe(true);
    expect(shaped.signature_data).toBeUndefined();
    expect(JSON.stringify(shaped)).not.toContain('base64');
  });

  it('carries the form name and the submitted date', () => {
    const shaped = shapeResponse(row);
    expect(shaped.form_name).toBe('Lash Consultation');
    expect(shaped.completed_at).toBe('2026-07-14T10:30:00Z');
  });

  it('keeps the consent wording with the answers it belongs to', () => {
    const withConsent = shapeResponse({
      ...row,
      consultation_forms: { ...row.consultation_forms, consent_text: 'I confirm the above is accurate.' },
    });
    expect(withConsent.consent_text).toBe('I confirm the above is accurate.');
    expect(shapeResponse(row).consent_text).toBeNull();
  });

  it('falls back to a plain name when the form join came back empty', () => {
    expect(shapeResponse({ ...row, consultation_forms: null }).form_name).toBe('Consultation form');
  });
});
