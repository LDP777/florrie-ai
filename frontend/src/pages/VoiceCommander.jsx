import { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useBeautician, supabase, fetchRows } from '../lib/supabase.js'
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import { deDash } from '../lib/text.js';
import { bloom } from '../lib/bloom.js';
import Icon, { iconName } from '../components/ui/Icon';
/**
 * Voice Commander - Talk to florrie.ai.
 *
 * Real Web Speech API for voice transcription in-browser.
 * Text or transcript is sent to POST /api/voice/command which uses
 * Claude to classify intent and execute actions (bookings, schedule
 * checks, messages, notes, time blocks).
 *
 * Falls back to text-only input when Speech API is unavailable.
 */
// Each agent gets a clean material symbol (no emoji) and a brand-aligned hue.
// 'general' has no icon, so the Florrie petal renders instead.
const AGENT_ROUTES = {
  calendar: { label: 'Calendar', icon: 'calendar_month', color: '#7C6EAF' },
  clients: { label: 'Clients', icon: 'person', color: '#C76B8A' }, // literal: this colour is alpha-concatenated (color + '18'), so must stay hex
  campaigns: { label: 'Campaigns', icon: 'mail', color: '#B0628A' },
  money: { label: 'Money', icon: 'payments', color: '#5BA67F' },
  content: { label: 'Content', icon: 'photo_camera', color: '#C9A05A' },
  settings: { label: 'Settings', icon: 'settings', color: 'var(--text-muted)' },
  general: { label: 'Florrie', icon: null, color: 'var(--accent, #92405e)' }, // uses petal SVG
};
function FloriePetal({ size = 28, spinning = false, white = false }) {
  const colour = white ? '#fff' : 'var(--accent-rose)';
  const gold = white ? 'rgba(255,255,255,0.6)' : '#C9A96E';
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={{ display: 'block',
        flexShrink: 0,
        animation: spinning ? 'petalSpin 4s linear infinite' : 'none',
      }}
    >
      <ellipse cx="50" cy="30" rx="16" ry="24" fill={colour} opacity="0.85" transform="rotate(0 50 50)" />
      <ellipse cx="50" cy="30" rx="16" ry="24" fill={colour} opacity="0.70" transform="rotate(72 50 50)" />
      <ellipse cx="50" cy="30" rx="16" ry="24" fill={colour} opacity="0.60" transform="rotate(144 50 50)" />
      <ellipse cx="50" cy="30" rx="16" ry="24" fill={colour} opacity="0.60" transform="rotate(216 50 50)" />
      <ellipse cx="50" cy="30" rx="16" ry="24" fill={colour} opacity="0.70" transform="rotate(288 50 50)" />
      <circle cx="50" cy="50" r="8" fill={gold} />
    </svg>
  );
}
// Map tool names → which agent "handled" it (for avatar/colour display)
/**
 * Visual confirm card: a spoken command with consequences renders THIS instead
 * of executing. Shows exactly what will happen; nothing runs until the tap.
 */
function ProposalCard({ prop, onDone }) {
  const [state, setState] = useState('idle'); // idle | running | done | failed
  async function confirm() {
    if (state !== 'idle') return;
    setState('running');
    try {
      const token = (await supabase?.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ tool: prop.tool, input: prop.input }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not do that.');
      setState('done');
      bloom();
      onDone && onDone(data.result || 'Done.');
    } catch (err) {
      setState('failed');
      onDone && onDone(err.message || 'Could not do that. Try again.');
    }
  }
  if (state === 'done' || state === 'dismissed') {
    // "Leave it" used to set this to 'done', so declining a send told her it
    // had happened. Two outcomes, two words.
    return (
      <div style={{ marginTop: 8, padding: '10px 14px', borderRadius: 16, background: 'var(--tone-2, #f6e7dd)', fontSize: 13, fontWeight: 600, color: state === 'done' ? 'var(--accent, #92405e)' : 'var(--text-secondary, #574A42)' }}>
        {state === 'done' ? 'Done ✓' : 'Left it'}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8, padding: '12px 14px', borderRadius: 16, background: 'var(--tone-1, #fbf1ea)', border: '1.5px solid var(--accent, #92405e)' }}>
      <p style={{ margin: 0, fontSize: 11, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--accent, #92405e)' }}>Confirm to make it happen</p>
      <p style={{ margin: '6px 0 10px', fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #241B17)', lineHeight: 1.45 }}>{proposalSummary(prop.tool, prop.input)}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="fl-tap"
          onClick={confirm}
          disabled={state === 'running'}
          style={{ flex: 1, minHeight: 42, borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: state === 'running' ? 0.6 : 1 }}
        >
          {state === 'running' ? 'Doing it…' : 'Yes, do it'}
        </button>
        {state === 'idle' && (
          <button className="fl-tap"
            onClick={() => setState('dismissed')}
            style={{ minHeight: 42, padding: '0 16px', borderRadius: 10, border: 'none', background: 'var(--tone-2, #f6e7dd)', color: 'var(--text-secondary, #574A42)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Leave it
          </button>
        )}
      </div>
    </div>
  );
}


/**
 * The consultation answers, on screen, because they are never said out loud.
 *
 * Voice tells her the status and how many things are worth knowing. This is
 * where the actual answers live, silent, for her to read herself. She is
 * usually holding a client when she asks, so a speaker is the wrong place for
 * someone's medical history.
 *
 * Collapsed by default and opened on a tap: a phone lying face up on the
 * trolley should not be showing a client's allergies to whoever walks past.
 */
function ConsultationCard({ consultation, count = 1, clientName }) {
  const [open, setOpen] = useState(false);
  if (!consultation) return null;

  const flagged = consultation.worth_knowing || [];
  // completed_at is a real instant, not the wall-time-in-a-UTC-slot that
  // appointments.starts_at holds, so it is NOT forced to UTC. Forcing it shows
  // a form submitted at 00.30 as the day before, and disagrees with the same
  // date on the client profile.
  const when = consultation.completed_at
    ? new Date(consultation.completed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  return (
    <div style={{ marginTop: 8, borderRadius: 16, background: 'var(--tone-1, #fbf1ea)', border: '1px solid var(--tone-2, #f6e7dd)', overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', minHeight: 44, padding: '10px 14px', border: 'none', background: 'transparent',
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
        }}
      >
        <Icon name={iconName('clinical_notes')} size={18} inline style={{ color: 'var(--accent, #92405e)' }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary, #241B17)' }}>
            {/* Whose. Without it, two lookups in one breath leave her reading
                somebody's allergies with no idea whose they are. */}
            {clientName ? `${clientName} · ` : ''}{consultation.form_name || 'Consultation form'}
          </span>
          <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-secondary, #574A42)' }}>
            {when ? `Submitted ${when}` : 'Submitted'}
            {count > 1 ? ` · ${count} on file` : ''}
          </span>
        </span>
        {flagged.length > 0 && (
          <span style={{ padding: '2px 8px', borderRadius: 999, background: 'var(--accent, #92405e)', color: '#fff',
            fontSize: 10.5, fontWeight: 800, letterSpacing: '0.03em', whiteSpace: 'nowrap',
          }}>
            {flagged.length} worth knowing
          </span>
        )}
        <Icon name={iconName(open ? 'expand_less' : 'expand_more')} size={20} inline style={{ color: 'var(--text-secondary, #574A42)' }} />
      </button>

      {open && (
        <div style={{ padding: '0 14px 12px' }}>
          {/* The flagged answers are NOT listed separately above the form. They
              are already in `pairs`, and printing the worth_knowing note as
              well put the one thing she most needs to read on screen twice,
              worded two different ways, three lines apart. pair.worth_knowing
              carries the emphasis instead. */}
          {(consultation.pairs || []).map(pair => (
            <div key={pair.field_id} style={{ padding: pair.worth_knowing ? '7px 10px' : '7px 0',
              borderTop: '1px solid var(--tone-2, #f6e7dd)',
              ...(pair.worth_knowing ? {
                background: 'var(--tone-2, #f6e7dd)',
                borderLeft: '3px solid var(--accent, #92405e)',
                borderRadius: 10,
                marginTop: 4,
              } : {}),
            }}>
              <p style={{ margin: 0, fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary, #574A42)', lineHeight: 1.4 }}>
                {pair.question}
              </p>
              <p style={{ margin: '2px 0 0', fontSize: 13, lineHeight: 1.45,
                color: pair.answered ? 'var(--text-primary, #241B17)' : 'var(--text-secondary, #574A42)',
                fontStyle: pair.answered ? 'normal' : 'italic',
                fontWeight: pair.worth_knowing ? 700 : 400,
              }}>
                {pair.answered ? pair.answer : 'Not answered'}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The people a "who still needs one" answer named. Names and times only, so
 * there is nothing here that has to stay off a speaker: it is a list, not a
 * medical record.
 */
function NeededList({ needed = [], label }) {
  if (!needed.length) return null;
  return (
    <div style={{ marginTop: 8, borderRadius: 16, background: 'var(--tone-1, #fbf1ea)', border: '1px solid var(--tone-2, #f6e7dd)', padding: '10px 14px' }}>
      <p style={{ margin: '0 0 6px', fontSize: 10.5, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--accent, #92405e)' }}>{label}</p>
      {needed.map(n => (
        <div key={n.client_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #241B17)' }}>{n.name}</span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary, #574A42)', whiteSpace: 'nowrap' }}>{n.when}</span>
        </div>
      ))}
    </div>
  );
}

/** Human line for a proposed tool call on the confirm card. */
/**
 * The settings a voice command can change, phrased for the confirm card.
 *
 * Kept in step with backend/src/lib/app-settings.js by id. Anything not listed
 * still renders — as its id, tidied — so a new backend setting degrades to
 * something readable rather than to nothing.
 */
const SETTING_LABELS = {
  florrie_answers_easy_ones: {
    on: 'Let Florrie answer the easy questions herself, signed as Florrie',
    off: 'Send every client message to you first, before anything goes out',
  },
  pause_all_messages: {
    on: 'Stop Florrie replying to clients (confirmations and reminders carry on)',
    off: 'Let Florrie answer clients again',
  },
  // booking_confirmations and confirmation_emails removed 1 September 2026:
  // confirmations, reminders and the calendar link are always on. See the note
  // in backend/src/lib/app-settings.js.
  promos_in_offers: {
    on: 'Let Florrie add a live promo code to gap offers',
    off: 'Keep promo codes out of gap offers',
  },
  auto_reply: {
    on: 'Let Florrie answer people who have never booked with you',
    off: 'Send new enquiries to you instead',
  },
};

function settingSummary(input = {}) {
  const id = String(input.setting_id || '');
  const raw = input.value;
  const on = raw === true || raw === 'true' || raw === 'on' || raw === 'yes';
  const off = raw === false || raw === 'false' || raw === 'off' || raw === 'no';

  const known = SETTING_LABELS[id];
  if (known && (on || off)) return known[on ? 'on' : 'off'];

  if (id === 'message_channel') {
    return raw === 'sms' ? 'Message clients by text instead of WhatsApp' : 'Message clients on WhatsApp';
  }
  if (id === 'known_client_min_visits') {
    return `Treat somebody as your own client after ${raw} visit${Number(raw) === 1 ? '' : 's'}`;
  }
  const pretty = id.replace(/_/g, ' ') || 'a setting';
  return `Change ${pretty} to ${String(raw)}`;
}

function proposalSummary(tool, input = {}) {
  const when = [input.date, input.time].filter(Boolean).join(' at ');
  switch (tool) {
    case 'book_appointment': return `Book ${input.client_name || 'a client'} in${(input.treatment || input.treatment_name) ? ` for ${input.treatment || input.treatment_name}` : ''}${when ? ` on ${when}` : ''}`;
    case 'reschedule_appointment': return `Move ${input.client_name || 'the appointment'}${input.appointment_date ? `'s ${input.appointment_date} appointment` : ''}${input.new_date ? ` to ${input.new_date}` : ''}${input.new_time ? ` at ${input.new_time}` : ''}`;
    case 'cancel_appointment': return `Cancel ${input.client_name || 'the appointment'}${input.appointment_date ? ` on ${input.appointment_date}` : ''}${input.notify_client === false ? '' : ' and let them know'}`;
    case 'block_date': return `Block ${input.date || 'the day'}${input.start_time ? ` from ${input.start_time}${input.end_time ? ` to ${input.end_time}` : ''}` : ' all day'}`;
    case 'block_date_range': return `Block ${input.from_date} to ${input.to_date}${input.skip_weekends ? ', keeping weekends open' : ''}`;
    case 'clear_block': return `Unblock ${input.date}`;
    case 'send_message': return `Message ${input.client_name || 'a client'}: "${(input.message || '').slice(0, 80)}"`;
    case 'send_bulk_message': return `Message ${input.client_names?.length || 'several'} clients`;
    case 'send_payment_link': return `Send ${input.client_name || 'a client'} a payment link${input.amount ? ` for £${input.amount}` : ''}`;
    case 'send_rebook_reminder': return `Send ${input.client_name || 'a client'} a rebook nudge`;
    case 'create_expense': return `Log a £${input.amount || '?'} expense${input.description ? ` (${input.description})` : ''}`;
    case 'send_consultation_form': return `Text ${input.client_name || 'a client'} her consultation form`;
    // A setting card has to read as the thing it does, not as its id. "Change
    // florrie_answers_easy_ones to false" is not something anybody can confirm
    // with any confidence, and this card is the ONLY thing standing between a
    // misheard word and Florrie going silent on every client.
    case 'change_setting': return settingSummary(input);
    default: return tool.replace(/_/g, ' ');
  }
}

const TOOL_TO_AGENT = {
  check_schedule: 'calendar',
  get_upcoming_appointments: 'calendar',
  book_appointment: 'calendar',
  reschedule_appointment: 'calendar',
  cancel_appointment: 'calendar',
  block_date: 'calendar',
  block_date_range: 'calendar',
  clear_block: 'calendar',
  send_message: 'campaigns',
  send_bulk_message: 'campaigns',
  send_payment_link: 'money',
  send_rebook_reminder: 'campaigns',
  get_revenue_summary: 'money',
  get_outstanding_payments: 'money',
  create_expense: 'money',
  get_top_clients: 'clients',
  get_client_info: 'clients',
  get_lapsed_clients: 'clients',
  add_client_note: 'clients',
  get_busiest_days: 'calendar',
  get_revenue_by_treatment: 'money',
  add_note: 'general',
  check_consultation_form: 'clients',
  get_consultations_needed: 'clients',
  check_patch_test: 'clients',
  get_patch_tests_needed: 'clients',
  send_consultation_form: 'clients',
  get_settings: 'general',
  change_setting: 'general',
};
// Map tool names → a quick-action button to show after the response
const TOOL_TO_ACTION = {
  book_appointment: { label: 'View Calendar', path: '/calendar' },
  reschedule_appointment: { label: 'View Calendar', path: '/calendar' },
  check_schedule: { label: 'Open Calendar', path: '/calendar' },
  get_upcoming_appointments: { label: 'Open Calendar', path: '/calendar' },
  block_date: { label: 'View Calendar', path: '/calendar' },
  block_date_range: { label: 'View Calendar', path: '/calendar' },
  send_message: { label: 'View Inbox', path: '/inbox' },
  send_bulk_message: { label: 'View Inbox', path: '/inbox' },
  get_revenue_summary: { label: 'Open Money', path: '/money' },
  get_outstanding_payments: { label: 'Open Money', path: '/money' },
  get_client_info: { label: 'View Clients', path: '/clients' },
  get_lapsed_clients: { label: 'View Clients', path: '/clients' },
  get_top_clients: { label: 'View Clients', path: '/clients' },
  add_note: { label: 'View Checklist', path: '/checklist' },
  check_consultation_form: { label: 'View Clients', path: '/clients' },
  get_consultations_needed: { label: 'Open Calendar', path: '/calendar' },
  check_patch_test: { label: 'View Clients', path: '/clients' },
  get_patch_tests_needed: { label: 'Open Calendar', path: '/calendar' },
};
// Fallback prompts shown before real data loads
const FALLBACK_PROMPTS = [
  "What's my schedule today?",
  "What did I earn this week?",
  "Who's overdue for a rebook?",
  "Block tomorrow afternoon off",
  "What's my busiest day this week?",
  "Show me my top clients",
  "Does anyone this week still need a consultation form?",
  "Who needs a patch test this week?",
  "How are you set up at the moment?",
];

// Build contextual suggestions from live data
function buildLiveSuggestions({ todayAppts, upcomingAppts, recentClients, dormantClients }) {
  const pool = [];
  const now = new Date();
  const dayName = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const tomorrowName = new Date(now.getTime() + 86400000).toLocaleDateString('en-GB', { weekday: 'long' });

  // Schedule-based
  if (todayAppts.length > 0) {
    pool.push(`What's my schedule today?`);
    // starts_at is salon wall time in the UTC slot, so "upcoming" must compare wall-to-wall
    const nowWallMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
    const nextAppt = todayAppts.find(a => new Date(a.starts_at).getTime() > nowWallMs);
    if (nextAppt) {
      const clientName = nextAppt.clients
        ? `${nextAppt.clients.first_name || ''} ${nextAppt.clients.last_name || ''}`.trim()
        : null;
      if (clientName) pool.push(`What time is ${clientName} in today?`);
    }
  } else {
    pool.push(`Any bookings coming up this week?`);
  }

  if (todayAppts.length > 0) {
    pool.push(`How many appointments do I have today?`);
  }

  // Tomorrow context
  if (upcomingAppts.length > 0) {
    pool.push(`What does ${tomorrowName} look like?`);
    pool.push(`Message everyone booked for ${tomorrowName}`);
  }

  // Client-name suggestions - use real recent clients
  if (recentClients.length > 0) {
    const pick = recentClients[Math.floor(Math.random() * recentClients.length)];
    pool.push(`When is ${pick} next booked in?`);
  }
  if (recentClients.length > 1) {
    const pick = recentClients[Math.floor(Math.random() * recentClients.length)];
    pool.push(`Add a note on ${pick}'s file`);
  }

  // Dormant / rebook
  if (dormantClients.length > 0) {
    pool.push(`Who haven't I seen in 2 months?`);
    if (dormantClients.length >= 3) {
      pool.push(`Send a comeback message to my ${dormantClients.length} dormant clients`);
    }
    const pick = dormantClients[Math.floor(Math.random() * dormantClients.length)];
    pool.push(`Send ${pick} a rebook nudge`);
  }

  // Revenue - always relevant
  pool.push(`What did I earn this week?`);
  pool.push(`How's this month compared to last?`);

  // Power features
  pool.push(`What's my busiest day this week?`);
  pool.push(`Block ${tomorrowName} afternoon off`);
  pool.push(`Show me my top 5 clients by spend`);

  // Setting the app up by talking to it. Here rather than buried, because a
  // feature nobody is told about does not exist — and the setting this is
  // mostly for (whether Florrie answers clients herself) is the one Ellie
  // would otherwise have to go four taps deep into Settings to find, which is
  // the whole thing she was complaining about.
  pool.push(`How are you set up at the moment?`);
  pool.push(`Stop answering my clients yourself`);

  // Deduplicate and pick 6
  const unique = [...new Set(pool)];
  const shuffled = unique.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 6);
}
// Check Web Speech API support
const SpeechRecognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;
// Inside the native iOS/Android app the "browser settings" advice is wrong;
// the mic toggle lives in the OS Settings app under Florrie.
const IS_NATIVE_APP = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
const MIC_DENIED_MSG = IS_NATIVE_APP
  ? 'Mic access is off. Enable it in Settings, Florrie, Microphone. Or type your message instead.'
  : 'Microphone access denied. Check your browser settings, or type your message instead.';
export default function VoiceCommander() {
  const { beautician, loading: bLoading } = useBeautician();
  const navigate = useNavigate();
  const location = useLocation();
  const autoListenedRef = useRef(false);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [pulseAnim, setPulseAnim] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [speechSupported, setSpeechSupported] = useState(!!SpeechRecognition);
  const [suggestions, setSuggestions] = useState(FALLBACK_PROMPTS);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const recognitionRef = useRef(null);
  const suggestionsDataRef = useRef(null);

  // Fetch live data for suggestions
  useEffect(() => {
    if (!beautician || bLoading) return;
    let cancelled = false;

    async function fetchSuggestionData() {
      try {
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const tomorrowStr = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
        const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000).toISOString().slice(0, 10);

        // Fetch today's appointments, tomorrow's, recent clients, and all clients for dormant check
        const [todayRes, tomorrowRes, clientsRes] = await Promise.all([
          supabase.from('appointments')
            .select('starts_at, clients(first_name, last_name)')
            .eq('beautician_id', beautician.id)
            .gte('starts_at', `${todayStr}T00:00:00Z`)
            .lte('starts_at', `${todayStr}T23:59:59Z`)
            .order('starts_at'),
          supabase.from('appointments')
            .select('starts_at, clients(first_name, last_name)')
            .eq('beautician_id', beautician.id)
            .gte('starts_at', `${tomorrowStr}T00:00:00Z`)
            .lte('starts_at', `${tomorrowStr}T23:59:59Z`)
            .order('starts_at'),
          supabase.from('clients')
            .select('first_name, last_name, appointments(created_at)')
            .eq('beautician_id', beautician.id)
            .order('created_at', { ascending: false })
            .limit(50),
        ]);

        if (cancelled) return;

        const todayAppts = todayRes.data || [];
        const upcomingAppts = tomorrowRes.data || [];

        // Recent clients = anyone with an appointment in the last 30 days
        const clients = clientsRes.data || [];
        const recentClients = [];
        const dormantClients = [];

        clients.forEach(c => {
          const name = `${c.first_name || ''} ${c.last_name || ''}`.trim();
          if (!name) return;
          const appts = (c.appointments || [])
            .map(a => new Date(a.created_at))
            .filter(d => !isNaN(d))
            .sort((a, b) => b - a);
          const lastVisit = appts[0];
          if (!lastVisit) return;
          const daysSince = Math.floor((now - lastVisit) / 86400000);
          if (daysSince <= 30) recentClients.push(name);
          if (daysSince >= 60) dormantClients.push(name);
        });

        const data = { todayAppts, upcomingAppts, recentClients, dormantClients };
        suggestionsDataRef.current = data;
        setSuggestions(buildLiveSuggestions(data));
      } catch (err) {
        logger.error('Suggestion data fetch error:', err);
      }
    }

    fetchSuggestionData();

    // Reshuffle suggestions every 45 seconds so they feel alive
    const interval = setInterval(() => {
      if (suggestionsDataRef.current) {
        setSuggestions(buildLiveSuggestions(suggestionsDataRef.current));
      }
    }, 45000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [beautician, bLoading]);

  // Init greeting + load history
  useEffect(() => {
    if (!bLoading) loadHistory();
  }, [beautician, bLoading]);
  async function loadHistory() {
    setLoading(true);
    try {
      // Restore the recent conversation so leaving and coming back to Florrie
      // does not wipe the chat (Ellie: "doesn't remember the chat").
      const saved = (() => {
        try { return JSON.parse(localStorage.getItem('florrie_voice_chat') || 'null'); }
        catch { return null; }
      })();
      if (Array.isArray(saved) && saved.length) {
        setMessages(saved);
        setLoading(false);
        return;
      }
      const greeting = {
        id: '0', role: 'assistant',
        text: speechSupported
          ? "Hey lovely! Tap the mic and talk to me, or type below. I'll handle everything."
          : "Hey lovely! Type anything below and I'll take care of it. Voice isn't supported in this browser, but I've got you covered.",
        agent: 'general',
        timestamp: new Date().toISOString(),
      };
      // Open clean: just the greeting. Florrie's activity log lives on the Hub
      // ("What Florrie did") - replaying it here as chat history cluttered the
      // page and hid the "Try saying" prompts. The voice screen is for asking,
      // not for re-reading what she already did.
      setMessages([greeting]);
    } catch (err) {
      logger.error('Load action history error:', err);
      setMessages([{
        id: '0', role: 'assistant',
        text: "Hey lovely! I'm here whenever you need me.",
        agent: 'general', timestamp: new Date().toISOString(),
      }]);
    } finally {
      setLoading(false);
    }
  }
  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
  // Persist the conversation (last 40 messages) so it survives navigating away.
  //
  // The consultation payload is stripped on the way out. This store is
  // unencrypted, survives sign out, and is readable by anything on the origin,
  // so writing a client's allergies into it would be a longer lived disclosure
  // than the speaker this whole feature was built to keep them off. The card
  // is worth a scroll back, not a permanent copy of a medical record.
  useEffect(() => {
    if (!messages.length) return;
    try {
      const safe = messages.slice(-40).map(({ consultation, needed, ...rest }) => rest);
      localStorage.setItem('florrie_voice_chat', JSON.stringify(safe));
    } catch {}
  }, [messages]);
  // Auto-start listening when arrived via a hold gesture on the nav petal.
  // Fires once, and only if speech is supported.
  useEffect(() => {
    if (autoListenedRef.current) return;
    if (location.state?.autoListen === true && speechSupported && !isRecording && !isProcessing) {
      autoListenedRef.current = true;
      startRecording();
    }
  }, [location.state, speechSupported]);
  function startRecording() {
    if (!SpeechRecognition) {
      inputRef.current?.focus();
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-GB';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      setIsRecording(true);
      setPulseAnim(true);
      setInterimTranscript('');
    };
    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }
      if (final) {
        setInterimTranscript('');
        processMessage(final, true);
      } else {
        setInterimTranscript(interim);
      }
    };
    recognition.onerror = (event) => {
      logger.error('Speech recognition error:', event.error);
      setIsRecording(false);
      setPulseAnim(false);
      setInterimTranscript('');
      if (event.error === 'not-allowed') {
        addSystemMessage(MIC_DENIED_MSG);
        setSpeechSupported(false);
      } else if (event.error === 'no-speech') {
        addSystemMessage("I didn't catch that. Try again or type your message.");
      }
    };
    recognition.onend = () => {
      setIsRecording(false);
      setPulseAnim(false);
      setInterimTranscript('');
    };
    recognitionRef.current = recognition;
    recognition.start();
  }
  function stopRecording() {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsRecording(false);
    setPulseAnim(false);
    setInterimTranscript('');
  }
  function handleRecord() {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }
  function addSystemMessage(text) {
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: 'assistant',
      text,
      agent: 'general',
      timestamp: new Date().toISOString(),
    }]);
  }
  async function processMessage(text, isVoice = false) {
    if (!text.trim()) return;
    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user',
      text: text.trim(),
      isVoice,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setTextInput('');
    setIsProcessing(true);
    try {
      const token = (await supabase?.auth.getSession())?.data?.session?.access_token;
      if (!token) {
        // Dev mode fallback - local keyword matching
        await new Promise(r => setTimeout(r, 800));
        const response = generateDevResponse(text.trim());
        setMessages(prev => [...prev, response]);
        setIsProcessing(false);
        return;
      }
      // Real backend call
      const res = await fetch(`${API_BASE}/api/voice/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ text: text.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error ${res.status}`);
      }
      const data = await res.json();
      // Determine agent from which tools were called
      const toolsUsed = (data.actions || []).map(a => a.tool);
      const primaryTool = toolsUsed[0];
      const agent = TOOL_TO_AGENT[primaryTool] || 'general';
      // Quick-action button - use first tool that has one
      const action = toolsUsed.reduce((found, t) => found || TOOL_TO_ACTION[t] || null, null);
      // Show tool count badge for multi-step commands
      const multiStep = toolsUsed.length > 1;
      // What voice deliberately did not say. The backend keeps consultation
      // answers out of the spoken string and puts them here instead, so this
      // is the only place they appear.
      // One card per lookup, not the first one. "Has Megan or Sarah done hers?"
      // is two tool calls, and a single unlabelled card of somebody's allergies
      // is worse than none.
      const consultationCards = (data.actions || [])
        .filter(a => a.tool === 'check_consultation_form' && a.data?.consultation)
        .map(a => ({
          consultation: a.data.consultation,
          count: a.data.count || 1,
          clientName: [a.data.client?.first_name, a.data.client?.last_name].filter(Boolean).join(' '),
        }));
      const neededAction = (data.actions || []).find(
        a => (a.tool === 'get_consultations_needed' || a.tool === 'get_patch_tests_needed') && (a.data?.needed || []).length > 0,
      );
      const aiMsg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: data.reply || "Done.",
        agent,
        action,
        multiStep,
        toolCount: toolsUsed.length,
        // Consequential actions come back as proposals: nothing has happened
        // yet, the confirm card below is what makes it real.
        proposals: Array.isArray(data.proposals) ? data.proposals : [],
        consultation: consultationCards,
        needed: neededAction?.data?.needed || [],
        neededLabel: neededAction?.tool === 'get_patch_tests_needed' ? 'Patch test still to book' : 'Still need a consultation form',
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => [...prev, aiMsg]);
    } catch (err) {
      logger.error('Voice command failed:', err);
      // Never show raw error details to users - use the backend's friendly message if available
      const friendly = typeof err.message === 'string' && !err.message.includes('{') && err.message.length < 120
        ? err.message
        : "Something went wrong. Try again in a moment.";
      addSystemMessage(friendly);
    } finally {
      setIsProcessing(false);
    }
  }
  // Dev mode fallback
  function generateDevResponse(input) {
    const lower = input.toLowerCase();
    let agent = 'general';
    let text = '';
    let action = null;
    if (lower.includes('move') || lower.includes('reschedule') || lower.includes('appointment') || lower.includes('block') || lower.includes('book')) {
      agent = 'calendar';
      text = "I'd move that for you but I'm in demo mode right now. Once you're logged in, voice commands hit the real backend and I'll handle bookings, rescheduling, and time blocks.";
      action = { label: 'View Calendar', path: '/calendar' };
    } else if (lower.includes('earn') || lower.includes('revenue') || lower.includes('money') || lower.includes('paid') || lower.includes('week')) {
      agent = 'money';
      text = "In demo mode I can't pull real numbers, but once live I'll fetch your earnings, breakdowns, and comparisons instantly.";
      action = { label: 'View Money', path: '/money' };
    } else if (lower.includes('comeback') || lower.includes('dormant') || lower.includes('send') || lower.includes('message') || lower.includes('campaign')) {
      agent = 'campaigns';
      text = "Campaign commands work when you're logged in. I'll find dormant clients, draft messages in your voice, and queue them for your approval.";
      action = { label: 'View Inbox', path: '/inbox' };
    } else if (lower.includes('post') || lower.includes('instagram') || lower.includes('content') || lower.includes('draft')) {
      agent = 'content';
      text = "Content drafting is live when connected. I generate captions, hashtags, and schedule posts. Type or say what you want and I'll draft it.";
      action = { label: 'View Content', path: '/content' };
    } else if (lower.includes('schedule') || lower.includes('today') || lower.includes('tomorrow')) {
      agent = 'calendar';
      text = "Once you're logged in I'll pull your real schedule. In demo mode I can't see your bookings.";
      action = { label: 'View Calendar', path: '/calendar' };
    } else if (lower.includes('loyal') || lower.includes('client') || lower.includes('who')) {
      agent = 'clients';
      text = "Client lookups need your real data. Log in and ask me again. I'll tell you visit counts, spend totals, and when they're due back.";
      action = { label: 'View Clients', path: '/clients' };
    } else {
      text = "I'm in demo mode so I can't take real actions yet. Once you're logged in, I handle bookings, schedule, messages, notes, and more. Just speak naturally.";
    }
    return {
      id: crypto.randomUUID(),
      role: 'assistant',
      text,
      agent,
      action,
      timestamp: new Date().toISOString(),
    };
  }
  function handleTextSubmit(e) {
    e.preventDefault();
    if (textInput.trim()) processMessage(textInput, false);
  }
  function handleActionClick(path) {
    // In-app SPA navigation. window.location.href forced a full reload that
    // dropped the user (and the chat) instead of opening the calendar.
    if (path) navigate(path);
  }
  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerTitleRow}>
          <FloriePetal size={22} />
          <h1 style={styles.title}>Ask Florrie</h1>
        </div>
        <p style={styles.subtitle}>
          {speechSupported ? 'Tap the petal or type, I handle the rest.' : 'Type anything, I handle the rest.'}
        </p>
      </div>
      {/* Messages */}
      <div style={styles.messagesContainer}>
        {messages.map(msg => (
          <div
            key={msg.id}
            style={{ ...styles.msgRow,
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            {msg.role === 'assistant' && (
              <div style={{ ...styles.agentAvatar,
                background: msg.agent === 'general' || !AGENT_ROUTES[msg.agent]?.icon
                  ? 'var(--accent-light)'
                  : AGENT_ROUTES[msg.agent].color + '18',
              }}>
                {msg.agent === 'general' || !AGENT_ROUTES[msg.agent]?.icon
                  ? <FloriePetal size={17} />
                  : <Icon name={iconName(AGENT_ROUTES[msg.agent].icon)} size={16} inline style={{ color: AGENT_ROUTES[msg.agent].color, }} />
                }
              </div>
            )}
            <div style={{ ...styles.bubble,
              ...(msg.role === 'user' ? styles.userBubble : styles.aiBubble),
            }}>
              {msg.role === 'assistant' && msg.agent !== 'general' && (
                <span style={{ ...styles.agentTag,
                  color: AGENT_ROUTES[msg.agent]?.color,
                  background: AGENT_ROUTES[msg.agent]?.color + '15',
                }}>
                  {AGENT_ROUTES[msg.agent]?.label}
                </span>
              )}
              <p style={styles.msgText}>{msg.text}</p>
              {msg.isVoice && msg.role === 'user' && (
                <span style={styles.voiceBadge}>
                  <Icon name={iconName('mic')} size={11} inline /> Voice
                </span>
              )}
              {msg.multiStep && msg.role === 'assistant' && (
                <span style={styles.multiStepBadge}>
                  {msg.toolCount} actions
                </span>
              )}
              {msg.action && (
                <button
                  style={styles.actionBtn}
                  onClick={() => handleActionClick(msg.action.path)}
                >
                  {msg.action.label} →
                </button>
              )}
              {(msg.consultation || []).map((c, ci) => (
                <ConsultationCard key={ci} consultation={c.consultation} count={c.count} clientName={c.clientName} />
              ))}
              {(msg.needed || []).length > 0 && (
                <NeededList needed={msg.needed} label={msg.neededLabel} />
              )}
              {(msg.proposals || []).map((prop, pi) => (
                <ProposalCard key={pi} prop={prop} onDone={(resultText) => {
                  setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', text: resultText, agent: 'general', timestamp: new Date().toISOString() }]);
                }} />
              ))}
            </div>
          </div>
        ))}
        {/* Processing indicator */}
        {isProcessing && (
          <div style={styles.msgRow}>
            <div style={styles.agentAvatar}>
              <FloriePetal size={18} spinning />
            </div>
            <div style={{ ...styles.bubble, ...styles.aiBubble }}>
              <div style={styles.typingDots}>
                <span style={{ ...styles.typingDot, animationDelay: '0s' }}>·</span>
                <span style={{ ...styles.typingDot, animationDelay: '0.2s' }}>·</span>
                <span style={{ ...styles.typingDot, animationDelay: '0.4s' }}>·</span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      {/* Example prompts */}
      {messages.length <= 2 && !isProcessing && (
        <div style={styles.promptsSection}>
          <span style={styles.promptsLabel}>Try saying:</span>
          <div style={styles.promptsGrid}>
            {suggestions.map((prompt, i) => (
              <button
                key={prompt}
                onClick={() => processMessage(prompt, false)}
                style={styles.promptChip}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Input area */}
      <div style={styles.inputArea}>
        {/* Insight chips: safe read-only questions, answered instantly */}
        {!isProcessing && !isRecording && (
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 8, scrollbarWidth: 'none' }}>
            {['How was my week?', "Who's gone quiet lately?", 'What does tomorrow look like?', 'Who are my top clients?', 'Which days are busiest?'].map(q => (
              <button className="fl-tap"
                key={q}
                onClick={() => processMessage(q, false)}
                style={{ flex: 'none', padding: '8px 14px', minHeight: 36, borderRadius: 999, border: 'none', background: 'var(--tone-2, #f6e7dd)', color: 'var(--accent, #92405e)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', WebkitTapHighlightColor: 'transparent' }}
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {/* Live transcript preview */}
        {interimTranscript && (
          <div style={styles.interimBar}>
            <span style={styles.interimText}>{interimTranscript}</span>
          </div>
        )}
        {/* Text input row */}
        <form onSubmit={handleTextSubmit} style={styles.inputForm}>
          <input
            ref={inputRef}
            type="text"
            value={textInput}
            onChange={e => setTextInput(e.target.value)}
            placeholder={isRecording ? 'Listening…' : 'Or type a message…'}
            style={styles.textInput}
            disabled={isProcessing || isRecording}
          />
          {textInput.trim() && (
            <button type="submit" style={styles.sendBtn} disabled={isProcessing}>
              ↑
            </button>
          )}
        </form>
        {/* Hold-to-talk hint. The mic now lives on the centre nav petal:
            press and hold it to talk. This line teaches the gesture and
            points down toward the nav. */}
        {speechSupported && !isRecording && (
          <div style={styles.holdHint}>
            <span style={styles.holdHintText}>
              {isProcessing ? 'Thinking…' : 'Hold the petal below to talk to me'}
            </span>
            {!isProcessing && (
              <Icon name={iconName('keyboard_arrow_down')} inline style={styles.holdHintChevron} />
            )}
          </div>
        )}
        {/* Live listening indicator while recording */}
        {isRecording && (
          <div style={styles.holdHint}>
            <span style={styles.holdHintText}>Listening, I'm all ears…</span>
          </div>
        )}
      </div>
    </div>
  );
}
const styles = {
  page: {
    display: 'flex', flexDirection: 'column',
    background: 'var(--bg)', fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)",
    maxWidth: 480, margin: '0 auto', color: 'var(--text-primary)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  header: { padding: '30px 16px 14px', flexShrink: 0 },
  headerTitleRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 },
  title: { fontSize: 27, fontWeight: 700, margin: 0, letterSpacing: '-0.01em', fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  subtitle: { fontSize: 13.5, color: 'var(--text-secondary, #574A42)', margin: 0, fontWeight: 500 },
  messagesContainer: {
    padding: '8px 16px 16px',
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  msgRow: { display: 'flex', gap: 8, alignItems: 'flex-end' },
  agentAvatar: {
    width: 30, height: 30, borderRadius: 16, background: 'var(--accent-light)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  bubble: {
    maxWidth: '82%', borderRadius: 22, padding: '11px 15px',
    animation: 'fadeIn 0.2s ease',
  },
  userBubble: {
    background: 'var(--accent, #92405e)',
    color: '#fff', borderBottomRightRadius: 6,
  },
  aiBubble: {
    background: 'var(--tone-1, #fbf1ea)', color: 'var(--text-primary)',
    borderBottomLeftRadius: 6,
  },
  agentTag: {
    display: 'inline-block', padding: '2px 9px', borderRadius: 999,
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.06em', marginBottom: 6,
  },
  msgText: { fontSize: 14, lineHeight: 1.5, margin: 0, whiteSpace: 'pre-wrap' },
  voiceBadge: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, opacity: 0.7, marginTop: 4 },
  multiStepBadge: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    fontSize: 10, fontWeight: 600, opacity: 0.65, marginTop: 4,
    padding: '2px 6px', borderRadius: 'var(--radius-xs)',
    background: 'var(--accent-light)', color: 'var(--accent)',
  },
  actionBtn: {
    display: 'block', marginTop: 8, padding: '8px 14px', minHeight: 36, borderRadius: 999,
    border: 'none', background: 'var(--tone-2, #f6e7dd)',
    color: 'var(--accent)', fontSize: 12.5, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit', WebkitTapHighlightColor: 'transparent',
  },
  typingDots: { display: 'flex', gap: 2, padding: '4px 0' },
  typingDot: {
    fontSize: 28, lineHeight: '16px', color: 'var(--text-muted)',
    animation: 'pulse 1.2s ease infinite',
  },
  promptsSection: { padding: '0 16px 12px', flexShrink: 0 },
  promptsLabel: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 500 },
  promptsGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  promptChip: {
    padding: '9px 14px', minHeight: 36, borderRadius: 999,
    border: 'none', background: 'var(--tone-2, #f6e7dd)',
    color: 'var(--text-primary, #241B17)', fontSize: 12.5, lineHeight: 1.3, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  },
  inputArea: { flexShrink: 0, padding: '8px 16px 16px', background: 'var(--bg)' },
  inputForm: { display: 'flex', gap: 8, alignItems: 'center' },
  textInput: {
    flex: 1, padding: '13px 18px', minHeight: 48, borderRadius: 999,
    border: 'none', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', background: 'var(--tone-1, #fbf1ea)', boxSizing: 'border-box',
    color: 'var(--text-primary)',
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22, border: 'none',
    background: 'var(--accent)', color: 'var(--bg-card, #FFFCF9)', fontSize: 18, fontWeight: 700,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  // Hold-to-talk hint (sits above the nav, fills the gap left by the old petal button)
  holdHint: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 2, paddingTop: 12, paddingBottom: 2,
  },
  holdHintText: {
    fontSize: 12.5, fontWeight: 600, color: 'var(--accent)',
    letterSpacing: '0.01em', textAlign: 'center', opacity: 0.85,
  },
  holdHintChevron: {
    fontSize: 20, color: 'var(--accent)', opacity: 0.6,
  },
  // Petal button
  petalWrap: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 8, paddingTop: 24, paddingBottom: 8, position: 'relative',
  },
  petalBtn: {
    width: 84, height: 84, borderRadius: 22, border: 'none',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'transform 0.15s ease, box-shadow 0.2s ease',
    WebkitTapHighlightColor: 'transparent',
    position: 'relative',
    zIndex: 1,
    boxShadow: '0 0 0 10px var(--tone-1, #fbf1ea), 0 0 0 20px var(--tone-2, #f6e7dd)',
  },
  recordingRipple: {
    position: 'absolute',
    width: 92, height: 92, borderRadius: 22,
    border: '2px solid rgba(212,96,92,0.4)',
    animation: 'ripple 1.4s ease-out infinite',
    pointerEvents: 'none',
    zIndex: 0,
  },
  petalLabel: {
    fontSize: 12.5, fontWeight: 500, color: 'var(--accent, #92405e)',
    letterSpacing: '0.01em', fontStyle: 'italic',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    marginTop: 10,
  },
  interimBar: {
    padding: '8px 14px', marginBottom: 8, borderRadius: 16,
    background: 'var(--tone-2, #f6e7dd)', fontSize: 13,
    color: 'var(--text-secondary)', fontStyle: 'italic',
  },
  interimText: { opacity: 0.8 },
  recordingBar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px', marginTop: 8, borderRadius: 10,
    background: 'var(--danger-bg)',
  },
  recordingDot: {
    width: 8, height: 8, borderRadius: 'var(--radius-xs)', background: 'var(--danger)',
    animation: 'pulse 1s ease infinite',
  },
  recordingText: { fontSize: 12, fontWeight: 600, color: 'var(--danger)', flex: 1 },
  recordingHint: { fontSize: 11, color: 'var(--text-muted)' },
};
// Inject keyframes
if (typeof document !== 'undefined' && !document.getElementById('voice-keyframes')) {
  const s = document.createElement('style');
  s.id = 'voice-keyframes';
  s.textContent = `
    @keyframes petalSpin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    @keyframes ripple {
      0%   { transform: scale(0.85); opacity: 0.6; }
      100% { transform: scale(1.4);  opacity: 0; }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }
  `;
  document.head.appendChild(s);
}
