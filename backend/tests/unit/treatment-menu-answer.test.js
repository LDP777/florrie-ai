import { describe, it, expect, vi } from 'vitest';
import { clientQuestionScenario } from '../../src/lib/client-question.js';
import { answerClientQuestion } from '../../src/services/client-answers.js';

const full = { id: 'full', name: 'Full brow lamination', price_cents: 4250, duration_minutes: 55 };
const upkeep = { id: 'upkeep', name: 'Brow lamination maintenance', price_cents: 2250, duration_minutes: 25 };
const select = (input = { covered: true, treatment_ids: ['full'] }) => vi.fn(async () => ({ content: [{ type: 'tool_use', name: 'select_menu_treatments', input }] }));
const answer = (message, over = {}) => answerClientQuestion({ message, scenario: clientQuestionScenario(message), context: { knowledge: [], treatments: [full, upkeep] }, beautician: {}, askModel: select(), ...over });

describe('menu questions without duplicated training notes', () => {
  it.each([
    'How long does brow lamination take?',
    'How much is full brow lamination?',
    'Do you offer brow lamination?',
    'What treatments do you offer?',
  ])('recognises a menu question: %s', message => expect(clientQuestionScenario(message)?.kind).toBe('treatment_menu'));
  it('uses the actual duration, not a repeat interval or result longevity', async () => {
    const result = await answer('How long does brow lamination take?');
    expect(result).toMatchObject({ canAnswer: true, reason: 'salon_treatment_menu', reply: 'Full brow lamination: 55 minutes for the appointment.', sources: [{ id: 'treatment:full' }] });
  });
  it('renders the exact saved price and duration, ignoring invented model prose', async () => {
    const askModel = select({ covered: true, treatment_ids: ['full'], reply: 'It is free and lasts eight weeks.' });
    const result = await answer('How much is brow lamination and how long does it take?', { askModel });
    expect(result.reply).toBe('Full brow lamination: £42.50, 55 minutes for the appointment.');
    expect(askModel.mock.calls[0][0].system).toContain('Never substitute maintenance');
  });
  it('answers a service-availability question without offering appointment availability', async () => {
    expect((await answer('Do you offer brow lamination?')).reply).toBe('Full brow lamination is on the treatment menu.');
  });
  it.each(['How long does a lash lift take, and can you book me in at 4pm?', 'Do you do brow lamination on Thursday?', 'How much is a lash lift and have you got any slots?'])('leaves mixed booking questions in the appointment flow: %s', message => {
    expect(clientQuestionScenario(message)).toBeNull();
  });
  it.each([
    'How long does brow lamination last?',
    'How long before I can have brow lamination again?',
    'How much is brow lamination and is it safe while pregnant?',
    'How do I get mascara off after a lash lift?',
    'How much is brow lamination maintenance and is that right for me?',
  ])('still needs approved guidance for advice: %s', async message => {
    const askModel = select();
    const result = await answer(message, { askModel });
    expect(result.canAnswer).toBe(false);
    expect(askModel).not.toHaveBeenCalled();
  });
  it.each([null, '', '45', -1, Infinity, 0])('never presents an unknown/invalid duration as a fact: %s', async duration_minutes => {
    expect((await answer('How long does brow lamination take?', { context: { treatments: [{ ...full, duration_minutes }] } })).canAnswer).toBe(false);
  });
  it.each([null, '', '4250', -1, 5.5, Infinity])('never converts a missing or malformed price into a free treatment: %s', async price_cents => {
    expect((await answer('How much is brow lamination?', { context: { treatments: [{ ...full, price_cents }] } })).canAnswer).toBe(false);
  });
  it('allows a genuine zero price', async () => {
    expect((await answer('How much is brow lamination?', { context: { treatments: [{ ...full, price_cents: 0 }] } })).reply).toContain('£0.00');
  });
  it('cannot substitute a cheaper maintenance treatment for the full service', async () => {
    expect((await answer('How much is full brow lamination?', { askModel: select({ covered: true, treatment_ids: ['upkeep'] }) })).canAnswer).toBe(false);
  });
  it.each([{ covered: false, treatment_ids: [] }, { covered: true, treatment_ids: ['other-salon'] }, { covered: true, treatment_ids: [] }, { covered: 'yes', treatment_ids: ['full'] }])('does not use unsupported selections: %j', async input => {
    expect((await answer('How long does brow lamination take?', { askModel: select(input) })).canAnswer).toBe(false);
  });
  it('rejects inactive services and unreadable menus before asking the model', async () => {
    for (const context of [{ treatments: [{ ...full, is_active: false }] }, { treatments: [{ ...full, booking_enabled: false }] }, { treatments: [full], treatmentsError: true }]) {
      const askModel = select();
      expect((await answer('Do you offer brow lamination?', { context, askModel })).canAnswer).toBe(false);
      expect(askModel).not.toHaveBeenCalled();
    }
  });
});
