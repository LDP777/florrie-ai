import {it} from 'vitest';
it('isolates salon inboxes and approved replies in PostgreSQL',async()=>{await import('../salon-email-sql.mjs');},30000);
