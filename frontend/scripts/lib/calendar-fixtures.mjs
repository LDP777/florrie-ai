import { todayFixtureSource } from './today-fixtures.mjs';
import { APPOINTMENTS, TREATMENTS } from './fixtures.mjs';

export function calendarFixtureSource(supabaseUrl, scenario = 'populated') {
  const appointments = APPOINTMENTS.map((a, index) => ({ ...a,
    client_id: `c${index + 1}`, beautician_id: 'b1', treatment_id: a.treatments.id,
    duration_minutes: a.treatments.duration_minutes,
    ends_at: new Date(new Date(a.starts_at).getTime() + a.treatments.duration_minutes * 60000).toISOString(),
    payment_type: index === 0 ? 'full' : null,
    ai_booked: index === 1,
  }));
  if (scenario === 'overlap') appointments.push({ ...appointments[1], id: 'overlap',
    clients: { first_name: 'Alexandra', last_name: 'Whitfield-Barrowman' },
    starts_at: '2026-08-08T11:30:00Z', ends_at: '2026-08-08T12:15:00Z',
    duration_minutes: 45, treatments: TREATMENTS[2], treatment_id: 't3', price_cents: 3500,
  });
  return `${todayFixtureSource(supabaseUrl, scenario)}
    (() => {
      const baseFetch = window.fetch;
      const appointments = ${JSON.stringify(appointments)};
      window.fetch = async (input, options) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (url.pathname === '/rest/v1/appointments') {
          if (${JSON.stringify(scenario)} === 'error') return respond({ message: 'Sample connection failure' }, 503);
          if (${JSON.stringify(scenario)} === 'empty') return respond([]);
          const bounds = url.searchParams.getAll('starts_at');
          return respond(appointments.filter(a => bounds.every(b => b.startsWith('gte.') ? a.starts_at >= b.slice(4) : b.startsWith('lte.') ? a.starts_at <= b.slice(4) : true)));
        }
        if (url.pathname === '/rest/v1/treatments') return respond(${JSON.stringify(TREATMENTS)});
        if (url.pathname === '/api/treatments') return respond({ treatments: ${JSON.stringify(TREATMENTS)} });
        return baseFetch(input, options);
      };
    })();`;
}
