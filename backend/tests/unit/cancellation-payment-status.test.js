import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
import { cancellationPaymentStatus as status, collectedFeeText, readCancellationPaymentStatus } from '../../src/services/cancellation-payment-status.js';
const base = { id: 'booking', beautician_id: 'owner' };
const collected = { ...base, policy_fee_charged_at: '2026-11-09T20:20:24Z', policy_fee_amount_cents: 2400, policy_fee_payment_intent_id: 'pi_saved' };
const action = (outcome, result = {}) => ({ beautician_id: 'owner', appointment_id: 'booking', action_type: 'client_cancellation_fee', outcome,
  details: { fee_cents: 2400, result, request: { params: { customer: 'SECRET_CUSTOMER', payment_method: 'SECRET_CARD' } } } });
describe('cancellation payment display evidence', () => {
  it('shows the prior collection date despite an old misleading awaiting-confirmation action', () => {
    const result = status(collected, action('success', { reason: 'already_charged', charged: false }));
    expect(result).toMatchObject({ status: 'collected', amountCents: 2400, collectedAt: collected.policy_fee_charged_at });
    expect(collectedFeeText(result)).toContain('already collected on 9 November 2026');
  });
  it.each(['policy_fee_charged_at', 'policy_fee_amount_cents', 'policy_fee_payment_intent_id'])('never asserts collected without %s', field => {
    expect(status({ ...collected, [field]: null }, action('success', { reason: 'already_charged' })).status).toBe('needs_attention');
  });
  it('keeps provider processing and incomplete local recording pending', () => {
    expect(status(base, action('pending', { pending: true })).status).toBe('pending');
    expect(status(base, action('pending', { charged: true, recorded: false })).status).toBe('pending');
    expect(status({ ...base, policy_fee_payment_intent_id: 'pi_processing' }).status).toBe('pending');
  });
  it.each(['no_card_on_file', 'card_declined', 'authentication_required', 'idempotency_expired'])('explains owner review for %s', reason => {
    const result = status(base, action('escalated', { reason }));
    expect(result.status).toBe('needs_attention');
    expect(JSON.stringify(result)).not.toMatch(/SECRET|payment_method|customer|pi_saved/);
  });
  it('does not count zero fees, missing records or foreign actions as paid', () => {
    expect(status(base)).toBeNull();
    expect(status(base, { ...action('success'), beautician_id: 'other-owner' })).toBeNull();
    expect(status(base, { ...action('success'), appointment_id: 'other-booking' })).toBeNull();
    expect(status(base, action('success', { reason: 'no_fee_configured' })).status).toBe('not_due');
  });
  it('flags a matched settled refund, without treating an unrelated or pending refund as a reversal', () => {
    const refund = { type: 'refund', status: 'completed', amount_cents: -2400, stripe_payment_intent_id: 'pi_saved' };
    expect(status(collected, null, [refund]).status).toBe('needs_attention');
    expect(status(collected, null, [{ ...refund, status: 'pending' }]).status).toBe('collected');
    expect(status(collected, null, [{ ...refund, stripe_payment_intent_id: 'pi_other' }]).status).toBe('collected');
  });
  it('reads only owner-scoped records and fails explicitly when the records cannot be read', async () => {
    const reads = [];
    const db = { from(table) { const filters = []; reads.push({ table, filters });
      const b = { select(){return b;}, eq(k,v){filters.push([k,v]);return b;}, in(){return b;}, order(){return b;}, limit(){return b;}, then(resolve){return Promise.resolve({data:[],error:null}).then(resolve);} }; return b;
    } };
    expect((await readCancellationPaymentStatus(collected, { db })).status).toBe('collected');
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(read.filters).toEqual(expect.arrayContaining([['beautician_id','owner'],['appointment_id','booking']]));
    const bad = { from(){ const b = { select(){return b;},eq(){return b;},in(){return b;},order(){return b;},limit(){return b;},then(resolve){return Promise.resolve({error:{message:'provider secret'}}).then(resolve);} };return b;} };
    await expect(readCancellationPaymentStatus(collected,{db:bad})).rejects.toThrow('Could not check');
  });
});
