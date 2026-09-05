import { APPOINTMENTS, fetchStubSource, sessionSeedSource } from './fixtures.mjs';

// For browser tests and local previews only. No request reaches a live API.
export function todayFixtureSource(supabaseUrl, scenario = 'populated') {
  return `${fetchStubSource()}
    ${sessionSeedSource(supabaseUrl)}
    (() => {
      const RealDate = Date;
      window.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : ['2026-08-08T09:00:00Z'])); }
        static now() { return new RealDate('2026-08-08T09:00:00Z').getTime(); }
      };
      const scenario = ${JSON.stringify(scenario)};
      const appointments = ${JSON.stringify(APPOINTMENTS)};
      const baseFetch = window.fetch;
      window.fetch = async (input, options) => {
        const url = String(typeof input === 'string' ? input : input.url);
        if (scenario === 'error' && ['/api/appointments', '/api/outbound/pending', '/api/escalations'].some(path => url.includes(path))) {
          return new Response('{}', { status: 503 });
        }
        let body;
        if (url.includes('/api/appointments')) body = { data: scenario === 'empty' ? [] :
          scenario === 'finished' ? appointments.map(a => ({ ...a, status: 'completed' })) : appointments };
        if (url.includes('/api/outbound/pending')) body = { pending: scenario === 'empty' ? [] : [{
          id: 'p1', clients: { first_name: 'Sarah', last_name: 'Miller' },
          body: 'Hi Sarah, I have Thursday at 2pm free for your usual brows. Would that work for you?',
          hold_reason: 'training_mode', created_at: '2026-08-08T08:30:00Z',
        }] };
        if (url.includes('/api/escalations')) body = { escalations: [] };
        if (url.includes('/api/activity/feed')) body = { rows: scenario === 'empty' ? [] : [
          { id: 'r1', type: 'booking_created', summary: 'Booked Priya for a lash lift on Thursday', created_at: '2026-08-08T08:45:00Z', link_to: '/calendar/week' },
          { id: 'r2', type: 'gap_fill', summary: 'Offered Tuesday at 2pm to three clients', created_at: '2026-08-08T08:20:00Z', link_to: '/waitlist' },
          { id: 'r3', type: 'rebook_nudge', summary: 'Sent Jo a reminder to rebook', created_at: '2026-08-08T08:00:00Z', link_to: '/rebook' },
          { id: 'r4', type: 'reply_sent', summary: 'Answered a question about patch tests', created_at: '2026-08-08T07:00:00Z', link_to: '/inbox' },
        ] };
        if (url.includes('/api/usage/value-receipt')) body = { total_pence: 18500,
          parts: { gap_fill_pence: 9000, rebook_pence: 9500, deposits_protected_pence: 6000 } };
        if (url.includes('/api/usage/voice')) body = { pct: 92, total: 25 };
        if (body !== undefined) return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        return baseFetch(input, options);
      };
    })();`;
}
