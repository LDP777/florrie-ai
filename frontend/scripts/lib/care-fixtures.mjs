import { todayFixtureSource } from './today-fixtures.mjs';

// Synthetic records only; every fetch is intercepted by the base fixture.
export function careFixtureSource(supabaseUrl, scenario = 'populated') {
  return `${todayFixtureSource(supabaseUrl, scenario)}
  (() => {
    const baseFetch = window.fetch;
    const scenario = ${JSON.stringify(scenario)};
    const people = [
      { id: 'c1', first_name: 'Priya', last_name: 'Kapoor', email: 'priya@example.test', phone: '07700900002' },
      { id: 'c2', first_name: 'Sarah', last_name: 'Miller', email: 'sarah@example.test', phone: '07700900001' },
      { id: 'c3', first_name: 'Sarah', last_name: 'Whitfield-Barrowman', email: 'sarah.w@example.test', phone: '07700900003' },
    ];
    const forms = [{ id: 'form1', name: 'Brow & lash consultation', is_default: true, consent_text: 'I confirm these answers are accurate.', consultation_form_fields: [{ count: 4 }] }, { id: 'form2', name: 'Photo permission', is_default: false, consultation_form_fields: [{ count: 3 }] }];
    let records = [{ id: 'patch1', client_id: 'c1', clients: people[0], test_date: '2026-08-02', status: 'recorded_by_owner', result: 'pending', treatments: { name: 'Lash lift & tint' }, reaction_notes: 'Recorded after the salon visit.' }, { id: 'patch2', client_id: 'c2', clients: people[1], test_date: '2026-07-15', status: 'recorded_by_owner', result: 'pass', treatments: { name: 'Signature brows' } }];
    let alerts = [{ client_id: 'c2', client_name: 'Sarah Miller', appointment_id: 'a1', appointment_date: '2026-08-10', treatment: 'Brow lamination', reason: 'been_in_but_nothing_on_record', bookings: 1, prior_visits: 4 }, { client_id: 'c3', client_name: 'Sarah Whitfield-Barrowman', appointment_id: 'a2', appointment_date: '2026-08-12', treatment: 'Lash lift & tint', reason: 'reaction_on_record', bookings: 1 }];
    let photos = [{ id: 'photo1', client_id: 'c1', clients: people[0], status: 'granted', permitted_uses: ['portfolio', 'instagram'], granted_at: '2026-08-01T12:00:00Z', created_at: '2026-08-01T12:00:00Z', expires_at: '2027-08-01T12:00:00Z', notes: 'Client agreed to portfolio and Instagram use.' }, { id: 'photo2', client_id: 'c2', clients: people[1], status: 'pending', permitted_uses: ['booking-page'], created_at: '2026-08-06T12:00:00Z', notes: 'Waiting for a signed response.' }];
    window.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = options.method || 'GET';
      const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      const carePath = /patch-test|consultation-form|photo-consent|api\\/clients/.test(url.pathname);
      if (scenario === 'error' && carePath) return respond({ error: 'Sample connection failure' }, 503);
      if (url.pathname === '/api/appointments/patch-test-alerts') return respond({ alerts: scenario === 'empty' ? [] : alerts, expiryMonths: 6, checkedUntil: '2026-08-29' });
      if (url.pathname === '/api/appointments/patch-test-records' && method === 'POST') {
        const row = JSON.parse(options.body); records.unshift({ ...row, id: 'patch-new', clients: people.find(p => p.id === row.client_id), status: 'recorded_by_owner', result: row.result || 'pending' }); alerts = alerts.filter(a => a.client_id !== row.client_id); return respond({ record: records[0] }, 201);
      }
      if (url.pathname === '/rest/v1/patch_tests') return respond(scenario === 'empty' ? [] : records);
      if (url.pathname === '/api/notifications/send-reminder') return respond({ success: true, channel: 'sms' });
      if (url.pathname === '/api/clients') {
        const found = people.filter(p => (p.first_name + ' ' + p.last_name + ' ' + p.email).toLowerCase().includes((url.searchParams.get('search') || '').toLowerCase()));
        return respond({ data: scenario === 'empty' ? [] : found, pagination: { page: 1, per_page: 8, total: found.length, total_pages: 1 } });
      }
      if (/^\\/api\\/clients\\/c[123]$/.test(url.pathname)) return respond({ client: people.find(p => p.id === url.pathname.split('/').pop()), appointments: [], messages: [] });
      if (url.pathname === '/api/consultation-forms') return respond({ forms: scenario === 'empty' ? [] : forms });
      if (url.pathname === '/api/photo-consent' && method === 'POST') { const row = JSON.parse(options.body); const saved = { ...row, id: 'photo-new', status: 'pending', clients: people.find(p => p.id === row.client_id), created_at: new Date().toISOString() }; photos.unshift(saved); return respond({ data: saved }, 201); }
      if (url.pathname === '/api/photo-consent') return respond({ data: scenario === 'empty' ? [] : photos });
      if (/^\\/api\\/photo-consent\\/[^/]+\\/revoke$/.test(url.pathname)) { const row = photos.find(p => p.id === url.pathname.split('/')[3]); row.status = 'declined'; row.revoked_at = new Date().toISOString(); return respond({ data: row }); }
      return baseFetch(input, options);
    };
  })();`;
}
