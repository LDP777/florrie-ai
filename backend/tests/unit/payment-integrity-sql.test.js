import { it } from 'vitest';
it('runs payment integrity migrations and transaction regressions in disposable PostgreSQL', async () => {
  await import('../payment-integrity-sql.mjs');
}, 30_000);
