import { FlorrieOrb, EffectFrame } from '../components/ui/FlorrieEffects.jsx';
import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useBeautician, supabase } from '../lib/supabase.js'
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import { sendVoiceCommand } from '../lib/voice-command.js';
import { localDateStr } from '../lib/dates.js';
import { loadVoiceHistory, saveVoiceHistory, clearVoiceHistory } from '../lib/voice-history.js';
import { executeVoiceProposal } from '../lib/voice-execution.js';
import { voiceResultLinks } from '../lib/voice-result-links.js';
import { bloom } from '../lib/bloom.js';
import { isVoiceEnabled, setVoiceEnabled } from '../lib/voicePref.js';
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
function ProposalCard({ prop, onDone, canExecute, onRunningChange }) {
  const mounted = useRef(true);
  const confirming = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [state, setState] = useState('idle'); // idle | running | done | failed
  async function confirm() {
    if (state !== 'idle' || confirming.current || !canExecute()) return;
    confirming.current = true;
    onRunningChange(true);
    setState('running');
    try {
      const data = await executeVoiceProposal({
        auth: supabase.auth, url: `${API_BASE}/api/voice/execute`, tool: prop.tool, input: prop.input,
        canExecute: () => mounted.current && canExecute(),
      });
      if (!mounted.current || !canExecute()) return;
      setState('done');
      bloom();
      onDone && onDone(data.result || 'The request returned no details. Check the relevant page before repeating it.');
    } catch (err) {
      if (!mounted.current || !canExecute()) return;
      setState('failed');
      onDone && onDone(err.message || 'Could not do that. Check the result before trying again.');
    } finally { onRunningChange(false); }
  }
  if (state === 'done' || state === 'dismissed') {
    // "Leave it" used to set this to 'done', so declining a send told her it
    // had happened. Two outcomes, two words.
    return (
      <div style={{ marginTop: 8, padding: '10px 14px', borderRadius: 16, background: 'var(--tone-2, #f6e7dd)', fontSize: 13, fontWeight: 600, color: state === 'done' ? 'var(--accent, #92405e)' : 'var(--text-secondary, #574A42)' }}>
        {state === 'done' ? 'Result received' : 'Left it'}
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
          disabled={state !== 'idle'}
          style={{ flex: 1, minHeight: 42, borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: 'var(--on-accent, #fff)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: state === 'running' ? 0.6 : 1 }}
        >
          {state === 'running' ? 'Doing it…' : state === 'failed' ? 'Check the result before trying again' : 'Yes, do it'}
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
          <span style={{ padding: '2px 8px', borderRadius: 999, background: 'var(--accent, #92405e)', color: 'var(--on-accent, #fff)',
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
// Each suggestion names a complete, supported task. Content opens its own workspace.
const TASK_GROUPS = [
  { id: 'day', label: 'My day', icon: 'calendar', title: 'A little head start', tasks: [
    { title: 'Brief me on today', detail: 'Your diary and anything needing attention', icon: 'sparkles', prompt: 'What is my schedule today, and what needs my attention?' },
    { title: 'Check client care', detail: 'Patch tests and consultation forms due this week', icon: 'shield', prompt: 'Who needs a patch test or consultation form this week?' },
    { title: 'Find my busiest day', detail: 'See how the week is shaping up', icon: 'calendar', prompt: "What's my busiest day this week?" },
  ] },
  { id: 'clients', label: 'Clients', icon: 'heart', title: 'Keep the little things covered', tasks: [
    { title: 'Find a client', detail: 'Visit history, bookings and notes', icon: 'search', draft: 'Tell me about ', hint: 'Add the client’s name, then send.' },
    { title: 'See who is due a rebook', detail: 'Find clients you have not seen recently', icon: 'heart', prompt: "Who haven't I seen in two months?" },
    { title: 'Prepare a client message', detail: 'Review the recipient and wording before sending', icon: 'message', draft: 'Prepare a message to ', hint: 'Add a client’s name and what you want to say.' },
  ] },
  { id: 'business', label: 'Business', icon: 'chart', title: 'Know where you stand', tasks: [
    { title: 'How was my week?', detail: 'Income, appointments and the bigger picture', icon: 'chart', prompt: 'Summarise my revenue and appointments this week.' },
    { title: 'Check outstanding payments', detail: 'See which payments still need attention', icon: 'pound', prompt: 'Which payments are still outstanding?' },
    { title: 'Review how Florrie is set up', detail: 'Check your current messaging settings', icon: 'settings', prompt: 'How are you set up at the moment?' },
  ] },
  { id: 'create', label: 'Create', icon: 'camera', title: 'Put your work out there', tasks: [
    { title: 'Plan content that brings bookings', detail: 'Open Content Studio to plan, create and track posts', icon: 'camera', path: '/content' },
    { title: 'Continue a content draft', detail: 'Pick up where you left off', icon: 'edit', path: '/content', state: { showDrafts: true } },
    { title: 'Work with your reviews', detail: 'Review replies and feedback permissions', icon: 'star', path: '/reviews' },
  ] },
];
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
  const autoListenedRef = useRef(null);
  const [messages, setMessages] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [executions, setExecutions] = useState(0);
  const processingRef = useRef(false);
  const [textInput, setTextInput] = useState(() => typeof location.state?.prompt === 'string' ? location.state.prompt.slice(0, 1000) : '');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [speechSupported, setSpeechSupported] = useState(!!SpeechRecognition);
  const [voiceEnabled, setVoiceOn] = useState(isVoiceEnabled);
  const [taskGroup, setTaskGroup] = useState('day');
  const [draftHint, setDraftHint] = useState('');
  const [daySummary, setDaySummary] = useState({ status: 'loading', count: null });
  const [dayRefresh, setDayRefresh] = useState(0);
  const historyStorage = (() => { try { return window.localStorage; } catch { return null; } })();
  const [historyOwner, setHistoryOwner] = useState(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [micStarting, setMicStarting] = useState(false);
  const [showIdeas, setShowIdeas] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const recognitionRef = useRef(null);
  const generationRef = useRef(0);
  const loadedOwnerRef = useRef(null);
  const ownerRef = useRef(beautician?.id);
  ownerRef.current = beautician?.id;

  useEffect(() => {
    const sync = () => setVoiceOn(isVoiceEnabled());
    window.addEventListener('florrie:voice-pref', sync);
    return () => window.removeEventListener('florrie:voice-pref', sync);
  }, []);

  // One small diary read. A failed or partial query must never imply an empty day.
  const today = localDateStr();
  useEffect(() => {
    if (!beautician?.id || bLoading) return;
    const controller = new AbortController();
    let cancelled = false;
    setDaySummary({ status: 'loading', count: null });
    const timer = setTimeout(() => {
      controller.abort();
      if (!cancelled) setDaySummary({ status: 'error', count: null });
    }, 8000);
    (async () => {
      try {
        const { count, error } = await supabase.from('appointments')
          .select('id', { count: 'exact', head: true })
          .eq('beautician_id', beautician.id)
          .gte('starts_at', `${today}T00:00:00Z`)
          .lte('starts_at', `${today}T23:59:59Z`)
          .not('status', 'in', '(cancelled,cancelled_by_client,cancelled_by_beautician,no_show)')
          .abortSignal(controller.signal);
        if (cancelled || controller.signal.aborted) return;
        if (error || !Number.isInteger(count) || count < 0) throw new Error('Diary count unavailable');
        setDaySummary({ status: 'ready', count });
      } catch {
        if (!cancelled) setDaySummary({ status: 'error', count: null });
      } finally { clearTimeout(timer); }
    })();
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [beautician?.id, bLoading, today, dayRefresh]);

  useEffect(() => {
    if (bLoading) return;
    generationRef.current++;
    cancelRecording();
    if (loadedOwnerRef.current && loadedOwnerRef.current !== beautician?.id) setTextInput('');
    loadedOwnerRef.current = beautician?.id || null;
    processingRef.current = false;
    setIsProcessing(false);
    setExecutions(0);
    setDraftHint('');
    setConfirmNew(false);
    setHistoryOwner(null);
    setMessages(beautician?.id ? loadVoiceHistory(historyStorage, beautician.id) : []);
    setHistoryOwner(beautician?.id || null);
  }, [beautician?.id, bLoading]);
  // Auto-scroll on new messages
  useEffect(() => {
    if (messages.some(m => m.role === 'user')) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages]);
  useEffect(() => {
    if (historyOwner && historyOwner === beautician?.id) saveVoiceHistory(historyStorage, historyOwner, messages);
  }, [messages, historyOwner, beautician?.id]);
  // Consume each deliberate hold once, including another hold on this page.
  // Clearing the route flag also prevents Back/Forward replaying a recording.
  useEffect(() => {
    if (location.state?.autoListen !== true || autoListenedRef.current === location.key || bLoading || !beautician?.id || historyOwner !== beautician.id) return;
    // Cancel before starting if this mount is discarded (including StrictMode's
    // development remount), instead of consuming a hold and aborting its mic.
    const timer = setTimeout(() => {
      autoListenedRef.current = location.key;
      navigate(location.pathname, { replace: true, state: { ...location.state, autoListen: false } });
      if (isVoiceEnabled() && !isProcessing) startRecording();
    }, 0);
    return () => clearTimeout(timer);
  }, [location.key, location.state, speechSupported, isProcessing, bLoading, beautician?.id, historyOwner]);

  useEffect(() => () => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
      try { recognition.abort(); } catch { /* already ended */ }
    }
  }, []);

  function startRecording() {
    if (recognitionRef.current || processingRef.current || executions > 0 || !isVoiceEnabled() || !beautician?.id) return;
    if (!SpeechRecognition || !speechSupported) {
      inputRef.current?.focus();
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-GB';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    setMicStarting(true);
    recognition.onstart = () => {
      if (recognitionRef.current !== recognition) return;
      setMicStarting(false);
      setIsRecording(true);
      setInterimTranscript('');
    };
    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return;
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
        recognitionRef.current = null;
        setIsRecording(false);
        setMicStarting(false);
        try { recognition.stop(); } catch {}
        processMessage(final, true);
      } else {
        setInterimTranscript(interim);
      }
    };
    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setMicStarting(false);
      logger.error('Speech recognition error:', event.error);
      setIsRecording(false);
      setInterimTranscript('');
      if (event.error === 'not-allowed') {
        addSystemMessage(MIC_DENIED_MSG);
        setSpeechSupported(false);
      } else if (event.error === 'no-speech') {
        addSystemMessage("I didn't catch that. Try again or type your message.");
      } else if (event.error !== 'aborted') {
        addSystemMessage("Voice lost its connection. Try again or type your message.");
      }
    };
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setMicStarting(false);
      setIsRecording(false);
      setInterimTranscript('');
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (error) {
      recognitionRef.current = null;
      setMicStarting(false);
      setIsRecording(false);
      addSystemMessage(error.name === 'NotAllowedError' ? MIC_DENIED_MSG : "Voice couldn't start. Try again or type your message.");
    }
  }
  function stopRecording() {
    // Keep controls busy until the final transcript or end event arrives.
    try { recognitionRef.current?.stop(); } catch { cancelRecording(); }
  }
  function cancelRecording() {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
      try { recognition.abort(); } catch {}
    }
    setMicStarting(false);
    setIsRecording(false);
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
    if (!text.trim() || processingRef.current || executions > 0 || !beautician?.id || ownerRef.current !== beautician.id || historyOwner !== beautician.id) return;
    const requestOwner = beautician.id;
    const requestGeneration = generationRef.current;
    const isCurrent = () => ownerRef.current === requestOwner && generationRef.current === requestGeneration;
    processingRef.current = true;
    setDraftHint('');
    setShowIdeas(false);
    setConfirmNew(false);
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
      const data = await sendVoiceCommand({ auth: supabase.auth, url: `${API_BASE}/api/voice/command`, text: text.trim(), canSend: isCurrent });
      if (!isCurrent()) return;
      // Determine agent from which tools were called
      const toolsUsed = (data.actions || []).map(a => a.tool);
      const primaryTool = toolsUsed[0];
      const agent = TOOL_TO_AGENT[primaryTool] || 'general';
      // Offer the relevant workspace for each returned result.
      const actions = voiceResultLinks(data.actions || []);
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
        text: data.reply || 'Review the proposed action below.',
        agent,
        actions,
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
      if (!isCurrent()) return;
      logger.error('Voice command failed:', err);
      // Never show raw error details to users - use the backend's friendly message if available
      const friendly = typeof err.message === 'string' && !err.message.includes('{') && err.message.length < 120
        ? err.message
        : "Something went wrong. Try again in a moment.";
      addSystemMessage(friendly);
    } finally {
      if (isCurrent()) {
        processingRef.current = false;
        setIsProcessing(false);
      }
    }
  }
  function handleTextSubmit(e) {
    e.preventDefault();
    if (textInput.trim()) processMessage(textInput, false);
  }
  function handleActionClick(path, state) {
    // In-app SPA navigation. window.location.href forced a full reload that
    // dropped the user (and the chat) instead of opening the calendar.
    if (path) navigate(path, { state });
  }
  const visibleMessages = historyOwner === beautician?.id ? messages : [];
  const hasConversation = visibleMessages.some(m => m.id !== '0');
  const busy = isProcessing || executions > 0 || isRecording || micStarting || bLoading || !beautician?.id || historyOwner !== beautician?.id;
  const currentGroup = TASK_GROUPS.find(group => group.id === taskGroup) || TASK_GROUPS[0];
  function chooseTask(task) {
    if (busy) return;
    if (task.path) { navigate(task.path, { state: task.state }); return; }
    if (task.prompt) { processMessage(task.prompt); return; }
    setTextInput(task.draft);
    setDraftHint(task.hint || 'Add the details, then send.');
    setShowIdeas(false);
    inputRef.current?.focus();
  }
  const renderedGeneration = generationRef.current;
  const renderedOwner = beautician?.id;
  const isCurrentConversation = () => renderedGeneration === generationRef.current && renderedOwner === ownerRef.current;
  function newConversation() {
    if (busy) return;
    generationRef.current++;
    clearVoiceHistory(historyStorage, beautician?.id);
    setMessages([]);
    setTextInput('');
    setDraftHint('');
    setConfirmNew(false);
    setShowIdeas(false);
  }
  const taskPicker = (
    <section className="fl-command-discover" aria-label="Things Florrie can help with">
      <div className="fl-command-categories" role="group" aria-label="Choose a topic">
        {TASK_GROUPS.map(group => <button type="button" key={group.id}
          aria-pressed={taskGroup === group.id} disabled={busy}
          onClick={() => setTaskGroup(group.id)}>{group.label}</button>)}
      </div>
      <div className="fl-command-discover-heading">
        <h2>{currentGroup.title}</h2>
        <span>{taskGroup === 'create' ? 'Open a workspace' : 'Tap to ask'}</span>
      </div>
      <div className="fl-command-tasks">
        {currentGroup.tasks.map(task => <button type="button" key={task.title} disabled={busy} onClick={() => chooseTask(task)}>
          <span className="fl-command-task-icon"><Icon name={task.icon} size={19} /></span>
          <span><strong>{task.title}</strong><small>{task.detail}</small></span>
          <Icon name={task.path ? 'arrow-up-right' : task.draft ? 'edit' : 'arrow-right'} size={17} />
        </button>)}
      </div>
    </section>
  );
  const composer = (
    <div className="fl-voice-composer">
      <EffectFrame focus active={isProcessing || isRecording}>
        <form className={`fl-command-input ${busy ? 'is-active' : ''}`} onSubmit={handleTextSubmit} aria-label="Ask Florrie">
          <label className="fl-command-input-label" htmlFor="fl-command-message">
            {isRecording ? 'Listening to you' : micStarting ? 'Opening the microphone' : isProcessing ? 'Working on your request' : hasConversation ? 'What else can I help with?' : 'A question, a plan, a little help…'}
          </label>
          <textarea id="fl-command-message" ref={inputRef} rows={2} aria-label="Message Florrie" value={isRecording ? interimTranscript : textInput}
            onChange={e => { setTextInput(e.target.value); setDraftHint(''); }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!busy) handleTextSubmit(e); } }}
            placeholder={isRecording ? 'Go on, I’m listening…' : 'What can I help with?'}
            disabled={busy} autoComplete="off" maxLength={2000} />
          <div className="fl-command-toolbar">
            <button type="button" className="fl-command-tool fl-command-explore" aria-label="More ways to ask"
              aria-expanded={showIdeas} aria-controls="fl-command-ideas" disabled={busy}
              onClick={() => setShowIdeas(value => !value)}><Icon name={showIdeas ? 'x' : 'plus'} size={18} />Ideas</button>
            <div className="fl-command-submit">
              {isRecording || micStarting ? <>
                <button type="button" className="fl-command-cancel" onClick={cancelRecording}>Cancel recording</button>
                <button className="fl-command-petal is-listening" type="button" aria-label="Stop listening" onClick={stopRecording}>
                  <span className="fl-command-wave" aria-hidden="true"><i /><i /><i /><i /></span>
                </button>
              </> : textInput.trim() ? (
                <button className="fl-command-send" type="submit" aria-label="Send message" disabled={busy}>
                  <Icon name="arrow-up" size={22} />
                </button>
              ) : speechSupported ? (
                <button className="fl-command-talk" type="button"
                  aria-label={voiceEnabled ? 'Tap to speak' : 'Turn on voice'}
                  disabled={busy} onContextMenu={event => event.preventDefault()}
                  onClick={() => { if (!voiceEnabled) setVoiceEnabled(true); handleRecord(); }}>
                  <span>{voiceEnabled ? 'Talk to Florrie' : 'Turn on voice'}</span><span className="fl-command-petal"><FloriePetal size={29} white /></span>
                </button>
              ) : <span className="fl-command-text-only">Type to ask<Icon name="edit" size={17} /></span>}
            </div>
          </div>
        </form>
      </EffectFrame>
      {draftHint && <p className="fl-command-draft-hint" role="status">{draftHint}</p>}
      <div id="fl-command-ideas" className="fl-command-ideas" hidden={!showIdeas}>{taskPicker}</div>
    </div>
  );
  return (
    <div className={`fl-voice-workspace fl-command-workspace ${hasConversation ? 'has-conversation' : 'is-welcome'}`} style={styles.page}>
      <section className={`fl-command-stage ${isRecording ? 'is-listening' : isProcessing ? 'is-thinking' : ''}`} aria-label="Florrie voice commander">
      <header className={`fl-voice-hero ${hasConversation ? 'is-conversation' : ''}`}>
        <div className="fl-voice-emblem" aria-hidden="true"><FloriePetal size={44} /><span /><span /></div>
        <span className="fl-workspace-eyebrow">Your salon. A little lighter.</span>
        <h1>Ask <em>Florrie.</em></h1>
        {!hasConversation && <p>Let’s take something off your list.</p>}
      </header>
      {hasConversation && <div className="fl-command-conversation-tools">
        {confirmNew ? <div role="group" aria-label="Start a new conversation">
          <span>Clear this chat and its pending proposals?</span>
          <button type="button" onClick={newConversation}>Start fresh</button>
          <button type="button" onClick={() => setConfirmNew(false)}>Keep chat</button>
        </div> : <button type="button" disabled={busy} onClick={() => setConfirmNew(true)}><Icon name="plus" size={16} />New conversation</button>}
      </div>}
      {!hasConversation && <div className="fl-command-stack">
        {composer}
        <div className="fl-command-day-line">
          <Icon name="calendar" size={15} />
          <Link to={`/calendar/week?view=day&date=${today}`}>{daySummary.status === 'ready'
            ? `${daySummary.count} ${daySummary.count === 1 ? 'appointment' : 'appointments'} in your diary today`
            : daySummary.status === 'loading' ? 'Checking today’s diary…' : 'Today’s diary is unavailable'}</Link>
          {daySummary.status === 'error' && <button type="button" aria-label="Retry diary summary" onClick={() => setDayRefresh(value => value + 1)}>Retry</button>}
        </div>
        {!showIdeas && taskPicker}
        <nav className="fl-command-shortcuts" aria-label="Your salon shortcuts">
          <span>Jump to</span>
          {[
            ['Inbox', '/inbox'], ['Calendar', '/calendar/week'], ['Money', '/money'],
          ].map(([label, path]) => <Link key={path} to={path}>{label}<Icon name="arrow-up-right" size={13} /></Link>)}
        </nav>
      </div>}
      {/* Messages */}
      <div className="fl-voice-messages" style={styles.messagesContainer} aria-live="polite">
        {visibleMessages.filter(msg => msg.id !== '0').map(msg => (
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
                <span className="fl-command-agent-tag" style={{ ...styles.agentTag,
                  color: AGENT_ROUTES[msg.agent]?.color,
                  background: AGENT_ROUTES[msg.agent]?.color + '15',
                }}>
                  {AGENT_ROUTES[msg.agent]?.label}
                </span>
              )}
              <p style={styles.msgText}>{msg.text}</p>
              {msg.historyNote && <p className="fl-command-history-note">{msg.historyNote}</p>}
              {msg.isVoice && msg.role === 'user' && (
                <span style={styles.voiceBadge}>
                  <Icon name={iconName('mic')} size={11} inline /> Voice
                </span>
              )}
              {msg.multiStep && msg.role === 'assistant' && (
                <span style={styles.multiStepBadge}>
                  {msg.toolCount} steps
                </span>
              )}
              <div className="fl-command-result-links">
                {(msg.actions || (msg.action ? [msg.action] : [])).map(action => <button type="button" key={`${action.path}:${action.state?.clientId || ''}`}
                  style={{ ...styles.actionBtn, display: 'inline-flex' }} onClick={() => handleActionClick(action.path, action.state)}>{action.label}<Icon name="arrow-right" size={15} /></button>)}
              </div>
              {(msg.consultation || []).map((c, ci) => (
                <ConsultationCard key={ci} consultation={c.consultation} count={c.count} clientName={c.clientName} />
              ))}
              {(msg.needed || []).length > 0 && (
                <NeededList needed={msg.needed} label={msg.neededLabel} />
              )}
              {(msg.proposals || []).map((prop, pi) => (
                <ProposalCard key={pi} prop={prop} canExecute={isCurrentConversation} onRunningChange={running => {
                  if (isCurrentConversation()) setExecutions(count => Math.max(0, count + (running ? 1 : -1)));
                }} onDone={(resultText) => {
                  if (!isCurrentConversation()) return;
                  setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', text: resultText, agent: 'general', timestamp: new Date().toISOString() }]);
                }} />
              ))}
            </div>
          </div>
        ))}
        {isProcessing && <div className="fl-voice-processing" role="status"><FlorrieOrb state="working" size={40} /><span>Thinking it through…</span></div>}
        <div ref={messagesEndRef} />
      </div>
      {hasConversation && composer}
      <p className="fl-command-hint" role="status">
        {isRecording ? 'Listening. Tap the wave to stop.' : isProcessing ? 'Thinking it through…'
          : speechSupported ? voiceEnabled ? 'You can also hold the petal in the bottom bar to talk.' : 'Voice is optional. You can always type to Florrie.'
          : 'Type above to ask Florrie. Voice is unavailable in this browser.'}
      </p>
      </section>
    </div>
  );
}
const styles = {
  page: {
    display: 'flex', flexDirection: 'column',
    background: 'var(--bg)', fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)",
    maxWidth: 820, margin: '0 auto', color: 'var(--text-primary)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  header: { padding: '28px 20px 20px', flexShrink: 0, background: 'var(--tone-1)', borderRadius: 24, margin: '12px 16px 16px', border: '1px solid var(--border)' },
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
    color: 'var(--on-accent)', borderBottomRightRadius: 6,
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
  msgText: { overflowWrap: 'anywhere', fontSize: 15, lineHeight: 1.65, margin: 0, whiteSpace: 'pre-wrap' },
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
    flex: 1, minWidth: 0, padding: '15px 16px', minHeight: 52, borderRadius: 18,
    border: 'none', fontSize: 16, fontFamily: 'inherit',
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
