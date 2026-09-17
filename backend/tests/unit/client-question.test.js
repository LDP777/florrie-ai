import { describe, it, expect, vi } from 'vitest';
import { clientQuestionScenario, diaryReleaseAnswer, renderClientHistory } from '../../src/lib/client-question.js';
import { answerClientQuestion } from '../../src/services/client-answers.js';
import { asksForHuman, isGroundedReply } from '../../src/lib/grounded-reply.js';

const owner = { id: 'salon', first_name: 'Mara', timezone: 'Europe/London', booking_policy: { max_advance_days: 60 } };
const now = new Date('2026-09-17T12:00:00Z');
const note = { id: 'guidance', category: 'treatment', title: 'Lamination interval', content: 'For full brow lamination, leave at least eight weeks between treatments. For earlier visits, ask about maintenance without repeating lamination.' };
const model = (over = {}) => vi.fn(async () => ({ content: [{ text: JSON.stringify({ covered: true, reply: 'For full brow lamination, leave at least eight weeks between treatments.', evidence: [{ id: 'guidance', quote: note.content }], ...over }) }] }));
const answer = (over = {}) => answerClientQuestion({ message: 'Is it too early for a lami again in 2 weeks?', scenario: { kind: 'treatment_guidance' }, context: { knowledge: [note] }, beautician: owner, askModel: model(), now, ...over });

describe('questions before bookings', () => {
  it.each([
    'Is it too early to book for a lami again in 2 weeks? Xx',
    'I just wanted to know if its too early to get a brow lamination and hybrid stain on 8th October xx',
    'How long between full brow laminations?',
    'I would like to get my brows done before going abroad, it would have been 4 weeks so that would be a maintenance I need right?',
  ])('keeps the treatment question out of the booking flow: %s', text => {
    expect(clientQuestionScenario(text)?.kind).toBe('treatment_guidance');
  });
  it('retains a treatment-date clarification as part of the previous question', () => {
    const question = 'Is it too early for brow lamination on 8 October?';
    const scenario = clientQuestionScenario('I had an appointment 2nd September xx', [{ direction: 'inbound', content: question }]);
    expect(scenario.kind).toBe('treatment_guidance');
    expect(scenario.question).toContain(question);
    expect(scenario.question).toContain('2nd September');
  });
  it('explains diary release before asking which treatment', () => {
    const question = 'Hey is this because you’re going away or have the dates just not been released yet?';
    expect(clientQuestionScenario(question)?.kind).toBe('diary_release');
    expect(clientQuestionScenario('Im after Wednesday 25th November at 5pm', [{ direction: 'inbound', content: question }])?.kind).toBe('diary_release');
  });
  it.each(['Can I book brow lamination at 4pm Wednesday 23 September?', 'I am going away, can I book brows?', '4pm please'])('does not convert an ordinary booking choice into a question: %s', text => {
    expect(clientQuestionScenario(text)).toBeNull();
  });
  it('does not resurrect old policy questions or hijack an explicit go-ahead', () => {
    const conversation = [{ direction: 'inbound', content: 'When are November dates released?', created_at: '2024-01-01T12:00:00Z' }];
    expect(clientQuestionScenario('I want Wednesday 25 November', conversation)).toBeNull();
    expect(clientQuestionScenario('Please book me 25 November', [{ ...conversation[0], created_at: undefined }])).toBeNull();
  });
  it('honours a human request with the client’s usual sign-off', () => {
    expect(asksForHuman('MARA x', 'Mara')).toBe(true);
    expect(asksForHuman('Mara xxx!', 'Mara')).toBe(true);
    expect(asksForHuman('Hi Mara, how much are brows?', 'Mara')).toBe(false);
  });
  it.each([
    'I am trying to book hybrid dye at 2pm but the verification email won’t come through. Could I manually book?',
    'It will not send me the verification code for my email',
    'I am trying to book but it is not letting me',
  ])('keeps booking failures out of the slot picker: %s', message => {
    expect(clientQuestionScenario(message)?.kind).toBe('booking_problem');
  });
  it('retains the course context for a treatment-named follow-up', () => {
    const prior='Are there any 1-1 training days after 8 October?';
    const result=clientQuestionScenario('I’ll go ahead with lamination, hybrid dye and tinting',[{direction:'inbound',content:prior}]);
    expect(result.kind).toBe('training_enquiry');
    expect(result.question).toContain(prior);
  });
});

describe('answers from saved facts', () => {
  it('flags booking support without guessing a fix or sending another email', async () => {
    const askModel=model();
    const result=await answer({scenario:{kind:'booking_problem'},askModel});
    expect(result).toMatchObject({canAnswer:false,reason:'booking_support:booking_problem'});
    expect(result.reply).toContain('verification codes or payment details hidden');
    expect(askModel).not.toHaveBeenCalled();
  });
  it('answers the rolling-window question without a model or invented holiday', async () => {
    const askModel = model();
    const result = await answer({ message: 'Have the diary dates been released yet?', scenario: { kind: 'diary_release' }, context: { knowledge: [] }, askModel });
    expect(result.canAnswer).toBe(true);
    expect(result.reply).toContain('60 days');
    expect(result.reply).not.toMatch(/away|holiday|which treatment/i);
    expect(askModel).not.toHaveBeenCalled();
  });
  it('gives the release date for the requested November date, without promising a slot', () => {
    const result = diaryReleaseAnswer({ message: 'Wednesday25thNovemberat5pm', beautician: owner, now });
    expect(result.reply).toContain('25 November');
    expect(result.reply).toContain('26 September');
    expect(result.reply).not.toMatch(/reserved|booked|away|holiday/);
  });
  it('requires the real configured booking window', () => {
    expect(diaryReleaseAnswer({ message: 'When do dates open?', beautician: { booking_policy: {} }, now })).toBeNull();
    expect(diaryReleaseAnswer({ message: 'When do dates open?', beautician: { booking_policy: { max_advance_days: 0 } }, now })).toBeNull();
  });
  it('returns the approved answer and its source', async () => {
    const result = await answer();
    expect(result).toMatchObject({ canAnswer: true, reason: 'approved_salon_answer', sources: [{ id: 'guidance' }] });
    expect(result.reply).not.toMatch(/which one|deposit|patch test|slot/i);
  });
  it('selects the full approved treatment note without asking the model to rewrite its rule', async () => {
    const askModel=vi.fn(async()=>({content:[{type:'tool_use',name:'select_treatment_guidance',input:{covered:true,guidance_ids:[note.id]}}]}));
    const result=await answer({askModel});
    expect(result.reply).toBe(note.content);
    expect(result.canAnswer).toBe(true);
    expect(askModel.mock.calls[0][0].tool_choice.name).toBe('select_treatment_guidance');
  });
  it.each([{covered:true,guidance_ids:['other-salon']},{covered:true,guidance_ids:[]},{covered:false,guidance_ids:[]},{covered:'yes',guidance_ids:[note.id]}])('refuses invalid or empty treatment selections: %j',async input=>{
    const result=await answer({askModel:async()=>({content:[{type:'tool_use',name:'select_treatment_guidance',input}]})});
    expect(result.canAnswer).toBe(false);
  });
  it('needs a saved rule instead of inventing a treatment interval', async () => {
    const askModel = model();
    const result = await answer({ context: { knowledge: [] }, askModel });
    expect(result.canAnswer).toBe(false);
    expect(result.reason).toBe('training:no_approved_answer');
    expect(result.reply).not.toMatch(/\d|weeks|free|book you/i);
    expect(askModel).not.toHaveBeenCalled();
  });
  it.each([
    { covered: false },
    { evidence: [] },
    { evidence: [{ id: 'other-owner-note', quote: note.content }] },
    { evidence: [{ id: 'guidance', quote: 'Six weeks is always suitable.' }] },
    { reply: 'I have booked you for 4pm.' },
    { reply: "I'll get Mara to call you." },
  ])('holds unsupported or action-claim answers: %j', async over => {
    expect((await answer({ scenario: { kind: 'general_question' }, askModel: model(over) })).canAnswer).toBe(false);
  });
  it('holds malformed model output', async () => {
    expect((await answer({ askModel: async () => ({ content: [{ text: 'sounds fine, book online' }] }) })).canAnswer).toBe(false);
  });
  it.each([
    'Your last lamination was 2 September, so you can come back on 27 October.',
    'Your last treatment was a full lamination. Leave eight weeks.',
    'That would be 36 days, so it is too soon.',
    'You are safe for another lamination after eight weeks.',
  ])('does not turn a saved interval into an invented personal conclusion: %s', async reply => {
    const result = await answer({askModel:model({reply})});
    expect(result.canAnswer).toBe(true);
    expect(result.reply).toBe(note.content);
    expect(result.reply).not.toBe(reply);
  });
  it('shares the approved rule without fabricating missing last-treatment details', async () => {
    const reply='You may have maintenance sooner, but leave at least 8 weeks between full laminations. Was your last appointment a full lamination?';
    expect((await answer({askModel:model({reply})})).canAnswer).toBe(true);
  });
  it('supplies completed treatment dates without promoting client claims to records', async () => {
    const askModel = model();
    const context = { knowledge: [note], clientHistory: [
      { status: 'completed', starts_at: '2026-09-02T12:00:00Z', treatments: { name: 'Full brow lamination' } },
      { status: 'pending', starts_at: '2026-09-09T12:00:00Z', treatments: { name: 'Cancelled example' } },
    ] };
    await answer({ context, askModel, scenario: { kind: 'general_question' } });
    expect(askModel.mock.calls[0][0].system).toContain('2026-09-02: Full brow lamination');
    expect(askModel.mock.calls[0][0].system).not.toContain('Cancelled example');
    expect(renderClientHistory({ clientHistory: [] })).toContain('none available');
  });
  it('keeps policy replies separate from claims of a booked appointment', async () => {
    const questionAnswer = await answer({ message: 'When are diary dates released?', scenario: { kind: 'diary_release' } });
    const check = over => isGroundedReply({ intent: 'general_question', message: 'When do dates open?', context: { questionAnswer }, reply: questionAnswer.reply, beauticianFirstName: 'Mara', ...over });
    expect(check().grounded).toBe(true);
    expect(check({ reply: 'You are booked on Wednesday.' }).grounded).toBe(false);
    expect(check({ message: 'Mara x' }).grounded).toBe(false);
  });
});
