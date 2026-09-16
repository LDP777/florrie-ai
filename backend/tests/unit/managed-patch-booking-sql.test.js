import { it } from 'vitest';

it('commits managed patch visits with their evidence and recovers retries', async () => {
  await import('../integration/managed-patch-booking.mjs');
}, 30000);
