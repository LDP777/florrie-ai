import { describe, expect, it, vi } from 'vitest';
import { insertPaymentReceipt } from '../../src/lib/payment-receipt.js';
const row = { beautician_id: 'salon', appointment_id: 'appt', client_id: 'client', amount_cents: 1500, type: 'deposit', stripe_payment_intent_id: 'pi_1' };
function db(error, prior, readError = null) {
 const builder = { insert: vi.fn(async () => ({ error })), select: () => builder, eq: () => builder, in: async () => ({ data: prior, error: readError }) };
 return { from: () => builder };
}
describe('concurrent provider receipts', () => {
 it('accepts the matching receipt after the unique index rejects a concurrent insertion', async () => {
   expect(await insertPaymentReceipt(db({ code: '23505' }, [row]), row)).toMatchObject({ error: null, duplicate: true });
 });
 it.each(['beautician_id','appointment_id','client_id','amount_cents','type'])('refuses a conflicting %s', async key => {
   expect((await insertPaymentReceipt(db({ code: '23505' }, [{ ...row, [key]: 'different' }]), row)).error.code).toBe('23505');
 });
 it('does not turn a failed reconciliation read into success', async () => {
   expect((await insertPaymentReceipt(db({ code: '23505' }, null, { message: 'offline' }), row)).error).toBeTruthy();
 });
 it('preserves unrelated failures', async () => {
   expect((await insertPaymentReceipt(db({ code: '23514' }, [row]), row)).error.code).toBe('23514');
 });
});

it('accepts a legacy duplicate group only when every row is the same money',async()=>{
 expect(await insertPaymentReceipt(db({code:'23505'},[row,{...row}]),row)).toMatchObject({duplicate:true,error:null});
 expect((await insertPaymentReceipt(db({code:'23505'},[row,{...row,amount_cents:3000}]),row)).error.code).toBe('23505');
});
