import { describe, expect, it } from 'vitest';
import { isTreatmentAnswer, treatmentBookingContinuation } from '../../src/lib/booking-continuation.js';
import { hasNamedTreatmentDetail } from '../../src/lib/booking-rules.js';
import { INSTAGRAM_STORY_UNAVAILABLE_MARKER } from '../../src/lib/instagram-story-context.js';

const now = Date.parse('2026-10-01T17:00:00Z');
const at = minutes => new Date(now + minutes * 60000).toISOString();
const treatments = [
  { id: 'hybrid', name: 'Hybrid stain' },
  { id: 'lamination', name: 'Brow Lamination & Hybrid stain' },
  { id: 'maintenance', name: 'Brow lamination maintenance - Hybrid stain' },
  { id: 'lip-wax', name: 'Lip wax' },
];
const request = (extra = {}) => ({ id: 'request', direction: 'inbound', channel: 'instagram',
  content: 'Can I book in on 7 December at 4pm please?', created_at: at(-2), ...extra });
const prompt = (extra = {}) => ({ id: 'question', direction: 'outbound', channel: 'instagram',
  content: 'Which treatment would you like?', authored_by: 'ai', ai_handled: true,
  digital_employee: 'front_desk', created_at: at(-1), ...extra });
const incoming = (content = 'Hybrid stain please', extra = {}) => ({ id: 'current', direction: 'inbound', channel: 'instagram', content, created_at: at(0), ...extra });
const recover = (extra = {}) => treatmentBookingContinuation({
  message: 'Hybrid stain please', messageId: 'current', channel: 'instagram',
  conversation: [request(), prompt(), incoming()], treatments, ownerName: 'Mara', now, ...extra,
});

describe('a named treatment answer can continue a real sent booking question', () => {
  it.each(['Hybrid stain', 'Brow lami + hybrid dye xx', 'Brow lamination and hybrid dye please if possible xx', 'Hybrid stain please'])('recognises a choice without demanding a second booking request: %s', message => {
    expect(isTreatmentAnswer(message, treatments)).toBe(true);
    expect(recover({ message, conversation: [request(), prompt(), incoming(message)] })).toEqual({
      request: request().content, requestedAt: request().created_at, questionMessageId: 'question',
    });
  });
  it.each([undefined, null, 'sent', 'delivered', 'read'])('accepts real sent provenance with legacy or successful status %s', send_status => {
    expect(recover({ conversation: [request(), prompt({ send_status }), incoming()] })).not.toBeNull();
  });
  it('permits disambiguation of a product name without choosing an arbitrary treatment', () => {
    expect(isTreatmentAnswer('Hybrid please', treatments)).toBe(true);
  });
  it('uses the menu aliases for real product detail while excluding body-only choices', () => {
    expect(hasNamedTreatmentDetail('Brows please', treatments)).toBe(false);
    expect(hasNamedTreatmentDetail('Lami + dye', treatments)).toBe(true);
    expect(hasNamedTreatmentDetail('Lash lift please', treatments)).toBe(false);
    expect(isTreatmentAnswer('Lip wax please', treatments)).toBe(true);
  });
  it('retains the original request across one repeated treatment question', () => {
    const message = 'Brow lamination and hybrid stain please';
    const conversation = [request({ created_at: at(-4) }), prompt({ created_at: at(-3) }),
      incoming('Hybrid please', { id: 'partial', created_at: at(-2) }),
      prompt({ id: 'clarifying', content: 'Did you mean Hybrid stain or Brow Lamination & Hybrid stain?' }), incoming(message)];
    expect(recover({ message, conversation })).toMatchObject({ request: request().content, questionMessageId: 'clarifying' });
  });
});

describe('mentioning a treatment does not choose it', () => {
  it.each([
    'brows', 'Brows please', 'The usual', 'Yes please', 'The second one', 'not hybrid',
    'I had hybrid last week', 'How long does lamination last?', 'Is hybrid stain safe while pregnant?',
    'I love your brow lamination results', 'Hybrid stain sounds nice but I am only looking',
    'I am not ready to book hybrid stain', 'Can I get a receipt for my hybrid stain?',
    'I need a refund for my brow lamination', 'Hybrid stain gave me a rash',
    'Can I speak to Mara about hybrid stain please',
  ])('does not invent treatment-selection evidence from: %s', message => {
    expect(recover({ message, conversation: [request(), prompt(), incoming(message)] })).toBeNull();
  });
});

describe('the preceding message must prove a sent AI booking question', () => {
  it.each([
    { authored_by: 'human' }, { authored_by: 'ai_edited' }, { authored_by: 'unknown' },
    { authored_by: undefined }, { ai_handled: false }, { digital_employee: 'content' },
    { direction: 'inbound', ai_response: 'Which treatment would you like?' },
    { content: 'Your appointment is confirmed.' }, { send_status: 'failed' },
    { send_status: 'undelivered' }, { send_status: 'pending' }, { escalated: true },
    { channel: 'whatsapp' }, { created_at: at(-1441) }, { created_at: at(1) },
    { created_at: 'invalid' }, { created_at: undefined },
  ])('refuses uncertain or unrelated prompt provenance: %j', override => {
    expect(recover({ conversation: [request(), prompt(override), incoming()] })).toBeNull();
  });
  it.each([
    'Keeping an eye out on December 7th xx',
    'When are December dates released? Need to book soon!',
    `Can I book that?\n${INSTAGRAM_STORY_UNAVAILABLE_MARKER}`,
    'Can I book hybrid stain? The verification email never arrived.',
    'Can I book a brow lamination training course?',
    'I already booked my appointment for Friday',
    'Thanks lovely xx',
  ])('does not legitimise an old mistaken treatment question after: %s', content => {
    expect(recover({ conversation: [request({ content }), prompt(), incoming()] })).toBeNull();
  });
  it('does not borrow the initiating request from a different channel', () => {
    expect(recover({ conversation: [request({ channel: 'whatsapp' }), prompt(), incoming()] })).toBeNull();
  });
  it('stops when a human has replied after the AI question', () => {
    expect(recover({ conversation: [request(), prompt(), prompt({ id: 'owner', authored_by: 'human', content: 'I will check that for you.' }), incoming()] })).toBeNull();
  });
  it('stops at an intervening unrelated client turn', () => {
    expect(recover({ conversation: [request(), prompt(), incoming('I will just watch for December', { id: 'aside' }), incoming()] })).toBeNull();
  });
});

describe('recovery respects message order and current-message boundaries', () => {
  it('ignores messages that arrived after the current message', () => {
    const message = 'Hybrid stain please';
    expect(recover({ message, conversation: [incoming(message), request(), prompt()] })).toBeNull();
  });
  it('does not recover from later messages when the requested current row is absent', () => {
    expect(recover({ messageId: 'missing-current', conversation: [request(), prompt()] })).toBeNull();
  });
  it.each([
    { direction: 'outbound' }, { channel: 'whatsapp' }, { content: 'I am only looking' },
    { created_at: 'invalid' }, { created_at: at(1) },
  ])('rejects a current-message row that does not belong to this answer: %j', override => {
    expect(recover({ conversation: [request(), prompt(), incoming('Hybrid stain please', override)] })).toBeNull();
  });
  it('rejects a question timestamped after the current answer even when array order looks valid', () => {
    expect(recover({ conversation: [request(), prompt(), incoming('Hybrid stain please', { created_at: at(-1.5) })] })).toBeNull();
  });
  it('rejects an older clarification chain whose question is newer than its answer', () => {
    expect(recover({ conversation: [request({ created_at: at(-5) }), prompt({ created_at: at(-2.5) }),
      incoming('Hybrid please', { id: 'partial', created_at: at(-3) }), prompt(), incoming()] })).toBeNull();
  });
  it('rejects an out-of-order request newer than its treatment question', () => {
    expect(recover({ conversation: [request({ created_at: at(-0.5) }), prompt(), incoming()] })).toBeNull();
  });
  it('does not let an old opening become current because a fresh question repeats it', () => {
    expect(recover({ conversation: [request({ created_at: at(-1441) }), prompt(), incoming()] })).toBeNull();
  });
  it('allows direct helper callers without an id to exclude their supplied final inbound row', () => {
    expect(recover({ messageId: null })).not.toBeNull();
  });
});
