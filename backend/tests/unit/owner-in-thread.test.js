/**
 * The 1 September Instagram thread, as a test.
 *
 *   Client  Can I change my appointment on 24th ... to full lami please girl xxx
 *   Ellie   Yes of course girl, could you get to me for 12.15 though? Xxx
 *   Client  Yes no problem!! Xxx
 *   Florrie hey lovely, i'll just check if you need a patch test ...
 *
 * Every dial said Florrie could send. None of them asked whether Ellie was
 * already answering.
 */
import { describe, it, expect } from 'vitest';
import { ownerIsInThread, OWNER_PRESENT_WINDOW_MS } from '../../src/lib/owner-in-thread.js';
import { mayFlorrieSend } from '../../src/services/ai-front-desk.js';

const NOW = new Date('2026-09-01T14:30:00Z').getTime();
const agoMs = ms => new Date(NOW - ms).toISOString();
const mins = n => n * 60 * 1000;
const hours = n => n * 60 * 60 * 1000;

const her = (ago, content = 'Yes of course girl, could you get to me for 12.15 though? Xxx') =>
  ({ id: 'm-ellie', direction: 'outbound', authored_by: 'human', content, created_at: agoMs(ago) });
const florrie = (ago, content = 'Your appointment is Thursday at 12.15 xx') =>
  ({ id: 'm-florrie', direction: 'outbound', authored_by: 'ai', content, created_at: agoMs(ago) });
const client = (ago, content = 'Yes no problem!! Xxx') =>
  ({ id: 'm-client', direction: 'inbound', authored_by: 'client', content, created_at: agoMs(ago) });

const check = conversation => ownerIsInThread({ conversation, now: NOW });

describe('ownerIsInThread', () => {
  it('the actual incident: Ellie answered, the client agreed, Florrie must stay out', () => {
    const result = check([client(mins(40)), her(mins(35)), client(mins(30))]);
    expect(result.present).toBe(true);
    expect(result.reason).toBe('owner_is_in_this_thread');
  });

  it('does not fire on a thread only Florrie has been answering', () => {
    expect(check([client(mins(40)), florrie(mins(38)), client(mins(2))]).present).toBe(false);
  });

  it('does not fire on a brand new thread with no history', () => {
    expect(check([]).present).toBe(false);
    expect(check([client(mins(1))]).present).toBe(false);
  });

  it('lets go once she has been out of the thread for longer than the window', () => {
    expect(check([her(hours(5))]).present).toBe(true);
    expect(check([her(hours(7))]).present).toBe(false);
    expect(check([her(OWNER_PRESENT_WINDOW_MS + 1000)]).reason).toBe('owner_last_spoke_too_long_ago');
  });

  it('counts a draft she edited before sending: she is at her phone, in this thread', () => {
    const edited = { id: 'm-e', direction: 'outbound', authored_by: 'ai_edited', created_at: agoMs(mins(5)) };
    expect(check([edited]).present).toBe(true);
  });

  it('ignores pre-migration rows rather than treating unknown as her', () => {
    // Every outbound row before 5 August carries 'unknown'. Reading those as
    // the owner would mute Florrie on every thread with any history at all.
    const old = { id: 'm-u', direction: 'outbound', authored_by: 'unknown', created_at: agoMs(mins(5)) };
    expect(check([old]).present).toBe(false);
  });

  it('never reads a client message as the owner, whatever it is labelled', () => {
    const mislabelled = { id: 'm-x', direction: 'inbound', authored_by: 'human', created_at: agoMs(mins(1)) };
    expect(check([mislabelled]).present).toBe(false);
  });

  it('excludes the message being answered, so a thread cannot mute itself', () => {
    const conversation = [{ id: 'current', direction: 'outbound', authored_by: 'human', created_at: agoMs(0) }];
    expect(ownerIsInThread({ conversation, now: NOW, currentMessageId: 'current' }).present).toBe(false);
  });

  it('takes the most recent of several messages from her', () => {
    expect(check([her(hours(20)), her(mins(10))]).present).toBe(true);
    expect(check([her(hours(20)), her(hours(19))]).present).toBe(false);
  });

  it('survives rows with no timestamp or a broken one', () => {
    const broken = { id: 'b', direction: 'outbound', authored_by: 'human', created_at: 'not a date' };
    expect(check([broken]).present).toBe(false);
    expect(check([broken, her(mins(5))]).present).toBe(true);
  });

  it('is unaffected by the order rows arrive in', () => {
    const rows = [client(mins(30)), her(mins(35)), client(mins(40))];
    expect(check(rows).present).toBe(true);
    expect(check([...rows].reverse()).present).toBe(true);
  });

  it('treats a missing conversation as no evidence, not as her being present', () => {
    expect(ownerIsInThread({ conversation: null, now: NOW }).present).toBe(false);
    expect(ownerIsInThread({ conversation: undefined, now: NOW }).present).toBe(false);
  });
});

describe('mayFlorrieSend with the owner in the thread', () => {
  // The dials that all said yes on 1 September.
  const wideOpen = {
    classification: { intent: 'general_question', confidence: 0.99 },
    groundedDecision: { grounded: true, reason: 'grounded' },
    known: true,
    autonomyOverride: 'florrie',
    threshold: 0.5,
    message: 'Yes no problem!! Xxx',
    arrivalNote: 'Ring the bell and I will come down.',
  };

  it('sends when nobody else is in the thread', () => {
    expect(mayFlorrieSend({ ...wideOpen, ownerPresent: { present: false } })).toBe(true);
  });

  it('outranks every dial, including the one that says yes', () => {
    expect(mayFlorrieSend({ ...wideOpen, ownerPresent: { present: true, reason: 'owner_is_in_this_thread' } }))
      .toBe(false);
  });

  it('behaves exactly as before when the caller passes nothing', () => {
    // Nothing else in the codebase should change shape because of this rule.
    expect(mayFlorrieSend(wideOpen)).toBe(true);
  });
});

describe('a thread Florrie cannot read', () => {
  it('is treated as somebody already handling it, not as an empty thread', () => {
    // gatherContext returns conversationReadable:false when the select errors.
    // An empty array and a failed read look identical at the call site, and
    // mean opposite things: new client versus Florrie about to answer a
    // conversation she cannot see. This is the 1 September incident arriving
    // by a different route.
    const unreadable = { present: true, at: null, reason: 'thread_unreadable' };
    expect(mayFlorrieSend({
      classification: { intent: 'price_enquiry', confidence: 0.99 },
      groundedDecision: { grounded: true },
      known: false,
      autonomyOverride: null,
      threshold: 0.5,
      message: 'how much is a lash lift',
      ownerPresent: unreadable,
    })).toBe(false);
  });
});
