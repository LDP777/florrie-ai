import { it } from 'vitest';
it('isolates mailbox state, imports and approved sends in PostgreSQL', async () => { await import('../email-connections-sql.mjs'); }, 30000);
