/** Insert once per provider payment. The receipt-key registry is the concurrency guard;
 * the read below only verifies that a conflicting receipt is the SAME money.
 * Never treat an unrelated constraint error or mismatched owner as success. */
export async function insertPaymentReceipt(db, row) {
  const result = await db.from('transactions').insert(row);
  if (!result.error || result.error.code !== '23505' || !row.stripe_payment_intent_id) return result;
  const prior = await db.from('transactions')
    .select('beautician_id,appointment_id,client_id,amount_cents,type')
    .eq('stripe_payment_intent_id', row.stripe_payment_intent_id)
    .in('type', ['deposit', 'full_payment', 'payment_link', 'payment', 'no_show_fee', 'late_cancel_fee']);
  const match = !prior.error && prior.data?.length > 0 && prior.data.every(receipt => [
    'beautician_id', 'appointment_id', 'client_id', 'amount_cents', 'type',
  ].every(key => (receipt[key] ?? null) === (row[key] ?? null)));
  return match ? { data: prior.data, error: null, duplicate: true } : result;
}
