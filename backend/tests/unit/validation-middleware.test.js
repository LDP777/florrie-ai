import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { validate } from '../../src/middleware/validate.js';
import { bookingSchema, waitlistSchema, updateClientSchema } from '../../src/lib/schemas.js';

function run(schema, body) {
  const req = { body };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  validate(schema)(req, res, next);
  return { req, res, next };
}

describe('validation after the security dependency update', () => {
  it('returns a useful 400 instead of passing a Zod error to the server error handler', () => {
    const { res, next } = run(waitlistSchema, { email: 'salon@example.com', marketingConsent: false });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Validation failed', details: [
      'marketingConsent: Please agree to receive Florrie launch news and product updates.',
    ] });
    expect(next).not.toHaveBeenCalled();
  });

  it('preserves booking defaults, optional blanks and the anti-bot token', () => {
    const { req, res, next } = run(bookingSchema, {
      treatment_id: '11111111-1111-4111-8111-111111111111',
      starts_at: '2026-11-20T14:00:00', client_name: 'Test Client',
      client_phone: '07700900123', client_email: '', notes: '',
      'cf-turnstile-response': 'synthetic-token', unexpected: 'strip-me',
    });
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.body).toMatchObject({ client_email: null, notes: null, consultation: null,
      payment_type: 'deposit', payment_method: 'card', marketing_opt_in: false,
      photo_consent: false, extra_treatment_ids: [], 'cf-turnstile-response': 'synthetic-token' });
    expect(req.body).not.toHaveProperty('unexpected');
  });

  it('does not turn a partial client update into permission changes', () => {
    const { req, next } = run(updateClientSchema, { notes: 'Synthetic note' });
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ notes: 'Synthetic note' });
  });

  it('rejects an oversized constrained collection without validating every element', () => {
    const element = vi.fn(() => true);
    const schema = z.array(z.string().refine(element)).max(10);
    const result = schema.safeParse(Array(10000).fill('synthetic'));
    expect(result.success).toBe(false);
    expect(result.error.issues).toHaveLength(1);
    expect(element).not.toHaveBeenCalled();
  });
});
