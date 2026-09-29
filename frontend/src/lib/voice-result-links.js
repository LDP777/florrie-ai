// Destinations come from our route catalogue, never from model-written text
// or a URL in a tool payload. These are navigation links, not success claims.
const DESTINATIONS = {
  book_appointment: { label: 'View Calendar', path: '/calendar' },
  reschedule_appointment: { label: 'View Calendar', path: '/calendar' },
  cancel_appointment: { label: 'View Calendar', path: '/calendar' },
  check_schedule: { label: 'Open Calendar', path: '/calendar' },
  get_upcoming_appointments: { label: 'Open Calendar', path: '/calendar' },
  block_date: { label: 'View Calendar', path: '/calendar' },
  block_date_range: { label: 'View Calendar', path: '/calendar' },
  clear_block: { label: 'View Calendar', path: '/calendar' },
  send_message: { label: 'View Inbox', path: '/inbox' },
  send_bulk_message: { label: 'View Inbox', path: '/inbox' },
  send_rebook_reminder: { label: 'View Inbox', path: '/inbox' },
  send_payment_link: { label: 'Open Money', path: '/money' },
  get_revenue_summary: { label: 'Open Money', path: '/money' },
  get_outstanding_payments: { label: 'Open Money', path: '/money' },
  get_revenue_by_treatment: { label: 'Open Money', path: '/money' },
  create_expense: { label: 'Open Money', path: '/money' },
  get_client_info: { label: 'View Clients', path: '/clients' },
  get_lapsed_clients: { label: 'View Clients', path: '/clients' },
  get_top_clients: { label: 'View Clients', path: '/clients' },
  add_client_note: { label: 'View Clients', path: '/clients' },
  check_consultation_form: { label: 'View Clients', path: '/clients' },
  get_consultations_needed: { label: 'Open consultation forms', path: '/consultation-forms' },
  send_consultation_form: { label: 'Open consultation forms', path: '/consultation-forms' },
  check_patch_test: { label: 'Open patch tests', path: '/patch-tests' },
  get_patch_tests_needed: { label: 'Open patch tests', path: '/patch-tests' },
  get_florrie_brief: { label: 'Open Florrie’s brief', path: '/insights' },
  get_busiest_days: { label: 'Open Calendar', path: '/calendar' },
  get_settings: { label: 'Open Settings', path: '/settings' },
  change_setting: { label: 'Open Settings', path: '/settings' },
  add_note: { label: 'View Checklist', path: '/checklist' },
};

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function failed(value) {
  return isRecord(value) && (Boolean(value.error) || value.success === false || value.ok === false
    || ['error', 'failed', 'failure'].includes(value.status));
}

/** Up to three distinct destinations from returned tool actions, in order. */
export function voiceResultLinks(actions) {
  if (!Array.isArray(actions)) return [];
  const links = [];
  const seen = new Set();

  for (const action of actions) {
    if (!isRecord(action) || typeof action.tool !== 'string'
      || !Object.hasOwn(DESTINATIONS, action.tool)
      || failed(action) || failed(action.data) || failed(action.result)) continue;

    let destination = { ...DESTINATIONS[action.tool] };
    if (action.tool === 'check_schedule' && isCalendarDate(action.data?.date)) {
      destination = { label: 'Open this day', path: `/calendar/week?date=${action.data.date}&view=day` };
    } else if (action.tool === 'get_client_info' && isUuid(action.data?.client?.id)) {
      destination = { label: 'View client', path: '/clients', state: { clientId: action.data.client.id.toLowerCase() } };
    }

    const key = `${destination.path}|${destination.state?.clientId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(destination);
    if (links.length === 3) break;
  }
  return links;
}
