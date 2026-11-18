import { z } from 'zod';

export const offlineReceiptSchema = z.object({
  payment_method: z.enum(['cash', 'bank_transfer', 'card_terminal']),
  received_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }),
  expected_amount_cents: z.number().int().positive().max(100000000),
}).strict();

export async function recordOfflineReceipt(db, owner, transactionId, body) {
  if (!z.string().uuid().safeParse(transactionId).success) return { status: 400, error: 'Choose a valid payment record.' };
  const parsed = offlineReceiptSchema.safeParse(body);
  if (!parsed.success) return { status: 400, error: 'Choose a payment method and a valid received date.' };
  const { data, error } = await db.rpc('confirm_offline_receipt', {
    p_owner: owner, p_transaction: transactionId, p_method: parsed.data.payment_method,
    p_received_on: parsed.data.received_on, p_expected_cents: parsed.data.expected_amount_cents,
  });
  if (error?.code === 'P0002') return { status: 404, error: 'Payment record not found.' };
  if (['22023', '22008', '22007'].includes(error?.code)) return { status: 400, error: 'Choose a payment method and a valid received date, no later than today.' };
  if (error?.code === 'P0001') return { status: 409, error: 'This booking has other payment details or has changed. Refresh your payments and check the appointment before recording it.' };
  if (error || data?.id !== transactionId || data?.beautician_id !== owner) return { status: 503, error: 'Save not confirmed. Refresh your payments before trying again.' };
  return { status: 200, transaction: data };
}
