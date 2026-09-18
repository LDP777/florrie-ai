import { it } from 'vitest';

it('isolates owner care-card drafts and preserves them through edit/archive/restore', async () => {
  // Executes the same standalone in-memory PostgreSQL proof in normal CI.
  await import('../aftercare-cards-sql.mjs');
}, 20_000);
