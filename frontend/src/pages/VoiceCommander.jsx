import { useState, useRef, useEffect } from 'react';
import { useBeautician, supabase, fetchRows } from '../lib/supabase.js'
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import { deDash } from '../lib/text.js';
/**
 * Voice Commander — Talk to florrie.ai.
 *
 * Real Web Speech API for voice transcription in-browser.
 * Text or transcript is sent to POST /api/voice/command which uses
 * Claude to classify intent and execute actions (bookings, schedule
 * checks, messages, notes, time blocks).
 *
 * Falls back to text-only input when Speech API is unavailable.
 */
const AGENT_ROUTES = {
  calendar: { label: 'Calendar', icon: '📅', color: '#4A90D9' },
  clients: { label: 'Clients', icon: '👤', color: 'var(--accent, #C76B8A)' },
  campaigns: { label: 'Campaigns', icon: '💌', color: '#E57373' },
  money: { label: 'Money', icon: '💰', color: '#4CAF50' },
  content: { label: 'Content', icon: '📸', color: '#F5A623' },
  settings: { label: 'Settings', icon: '⚙️', color: '#6b6560' },
  general: { label: 'florrie.ai', icon: null, color: 'var(--accent, #C76B8A)' }, // uses petal SVG
};
function FloriePetal({ size = 28, spinning = false, white = false }) {
  const colour = white ? '#fff' : '#C76B8A';
  const gold = white ? 'rgba(255,255,255,0.6)' : '#C9A96E';
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={{
        display: 'block',
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
};
// Fallback prompts shown before real data loads
const FALLBACK_PROMPTS = [
  "What's my schedule today?",
  "What did I earn this week?",
  "Who's overdue for a rebook?",
  "Block tomorrow afternoon off",
  "What's my busiest day this week?",
  "Show me my top clients",
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
    const nextAppt = todayAppts.find(a => new Date(a.starts_at) > now);
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

  // Client-name suggestions — use real recent clients
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

  // Revenue — always relevant
  pool.push(`What did I earn this week?`);
  pool.push(`How's this month compared to last?`);

  // Power features
  pool.push(`What's my busiest day this week?`);
  pool.push(`Block ${tomorrowName} afternoon off`);
  pool.push(`Show me my top 5 clients by spend`);

  // Deduplicate and pick 6
  const unique = [...new Set(pool)];
  const shuffled = unique.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 6);
}
// Check Web Speech API support
const SpeechRecognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;
export default function VoiceCommander() {
  const { beautician, loading: bLoading } = useBeautician();
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
      const greeting = {
        id: '0', role: 'assistant',
        text: speechSupported
          ? "Hey lovely! Tap the mic and talk to me, or type below. I'll handle everything."
          : "Hey lovely! Type anything below and I'll take care of it. Voice isn't supported in this browser, but I've got you covered.",
        agent: 'general',
        timestamp: new Date().toISOString(),
      };
      if (!beautician) {
        setMessages([greeting]);
      } else {
        const todayStr = new Date().toISOString().slice(0, 10);
        const data = await fetchRows('ai_actions', beautician.id, {
          order: 'created_at', ascending: false, limit: 20,
          filters: { created_at: `gte.${todayStr}T00:00:00` },
        });
        const BOOKING_TYPES = ['booking_confirmed', 'booking_created', 'appointment_booked', 'booking_reminder'];
        const aiOnly = (data || []).filter(action =>
          !BOOKING_TYPES.includes(action.action_type) &&
          !(action.summary || '').match(/booked .+ for \d/)
        );
        const mapped = aiOnly.map(action => ({
          id: action.id,
          role: 'assistant',
          text: deDash(action.summary || action.notification_text || action.action_type || 'Action completed'),
          agent: action.digital_employee || 'general',
          timestamp: action.created_at,
        }));
        // Dedupe the feed: the heartbeat can log the same summary repeatedly.
        const seen = new Set();
        const deduped = mapped.filter(m => (seen.has(m.text) ? false : (seen.add(m.text), true)));
        setMessages([greeting, ...deduped]);
      }
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
        addSystemMessage("Microphone access denied. Check your browser settings, or type your message instead.");
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
        // Dev mode fallback — local keyword matching
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
      // Quick-action button — use first tool that has one
      const action = toolsUsed.reduce((found, t) => found || TOOL_TO_ACTION[t] || null, null);
      // Show tool count badge for multi-step commands
      const multiStep = toolsUsed.length > 1;
      const aiMsg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: data.reply || "Done.",
        agent,
        action,
        multiStep,
        toolCount: toolsUsed.length,
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => [...prev, aiMsg]);
    } catch (err) {
      logger.error('Voice command failed:', err);
      // Never show raw error details to users — use the backend's friendly message if available
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
    if (path) window.location.href = path;
  }
  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>Ask Florrie</h1>
        <p style={styles.subtitle}>
          {speechSupported ? 'Tap the mic or type, I handle everything.' : 'Type anything, I handle everything.'}
        </p>
      </div>
      {/* Messages */}
      <div style={styles.messagesContainer}>
        {messages.map(msg => (
          <div
            key={msg.id}
            style={{
              ...styles.msgRow,
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            {msg.role === 'assistant' && (
              <div style={styles.agentAvatar}>
                {msg.agent === 'general' || !AGENT_ROUTES[msg.agent]?.icon
                  ? <FloriePetal size={18} />
                  : <span style={{ fontSize: 14 }}>{AGENT_ROUTES[msg.agent].icon}</span>
                }
              </div>
            )}
            <div style={{
              ...styles.bubble,
              ...(msg.role === 'user' ? styles.userBubble : styles.aiBubble),
            }}>
              {msg.role === 'assistant' && msg.agent !== 'general' && (
                <span style={{
                  ...styles.agentTag,
                  color: AGENT_ROUTES[msg.agent]?.color,
                  background: AGENT_ROUTES[msg.agent]?.color + '15',
                }}>
                  {AGENT_ROUTES[msg.agent]?.label}
                </span>
              )}
              <p style={styles.msgText}>{msg.text}</p>
              {msg.isVoice && msg.role === 'user' && (
                <span style={styles.voiceBadge}>🎙️ Voice</span>
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
        {/* Central Florrie petal button */}
        {speechSupported && (
          <div style={styles.petalWrap}>
            {isRecording && (
              <div style={styles.recordingRipple} />
            )}
            <button
              type="button"
              onClick={handleRecord}
              disabled={isProcessing}
              aria-label={isRecording ? 'Stop recording' : 'Start voice command'}
              style={{
                ...styles.petalBtn,
                background: isRecording
                  ? 'linear-gradient(135deg, #D4605C 0%, #c0392b 100%)'
                  : 'linear-gradient(135deg, #C76B8A 0%, #a85070 100%)',
                boxShadow: isRecording
                  ? '0 0 0 8px rgba(212,96,92,0.15), 0 4px 20px rgba(212,96,92,0.4)'
                  : '0 4px 20px rgba(199,107,138,0.35)',
              }}
            >
              <FloriePetal size={38} spinning={isRecording} white />
            </button>
            <span style={styles.petalLabel}>
              {isProcessing ? 'Thinking…' : isRecording ? 'Tap to stop' : 'Tap to speak'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
const styles = {
  page: {
    display: 'flex', flexDirection: 'column',
    background: 'var(--bg)', fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)",
    maxWidth: 480, margin: '0 auto', color: 'var(--text-primary)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  header: { padding: '28px 16px 12px', flexShrink: 0 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px', fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  subtitle: { fontSize: 13, color: 'var(--accent)', margin: 0, fontWeight: 500 },
  messagesContainer: {
    padding: '8px 16px 16px',
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  msgRow: { display: 'flex', gap: 8, alignItems: 'flex-end' },
  agentAvatar: {
    width: 30, height: 30, borderRadius: 15, background: 'var(--accent-light)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  bubble: {
    maxWidth: '80%', borderRadius: 16, padding: '10px 14px',
    animation: 'fadeIn 0.2s ease',
  },
  userBubble: {
    background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%)',
    color: 'var(--bg-card, #fff)', borderBottomRightRadius: 4,
  },
  aiBubble: {
    background: 'var(--bg-card)', color: 'var(--text-primary)',
    borderBottomLeftRadius: 4,
    boxShadow: 'var(--shadow-xs, 0 1px 3px rgba(0,0,0,0.04))',
  },
  agentTag: {
    display: 'inline-block', padding: '2px 8px', borderRadius: 4,
    fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.04em', marginBottom: 6,
  },
  msgText: { fontSize: 14, lineHeight: 1.5, margin: 0, whiteSpace: 'pre-wrap' },
  voiceBadge: { display: 'inline-block', fontSize: 10, opacity: 0.7, marginTop: 4 },
  multiStepBadge: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    fontSize: 10, fontWeight: 600, opacity: 0.65, marginTop: 4,
    padding: '2px 6px', borderRadius: 4,
    background: 'var(--accent-light)', color: 'var(--accent)',
  },
  actionBtn: {
    display: 'block', marginTop: 8, padding: '6px 12px', borderRadius: 8,
    border: '1.5px solid var(--border)', background: 'transparent',
    color: 'var(--accent)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
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
    padding: '8px 12px', borderRadius: 10,
    border: '1.5px solid var(--border)', background: 'var(--bg-card)',
    color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.3,
    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
  },
  inputArea: { flexShrink: 0, padding: '8px 16px 24px', background: 'var(--bg)' },
  inputForm: { display: 'flex', gap: 8, alignItems: 'center' },
  textInput: {
    flex: 1, padding: '12px 16px', borderRadius: 24,
    border: '1.5px solid var(--border)', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', background: 'var(--bg-card)', boxSizing: 'border-box',
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22, border: 'none',
    background: 'var(--accent)', color: 'var(--bg-card, #fff)', fontSize: 18, fontWeight: 700,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  // Petal button
  petalWrap: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 8, paddingTop: 16, paddingBottom: 4, position: 'relative',
  },
  petalBtn: {
    width: 76, height: 76, borderRadius: 38, border: 'none',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'transform 0.15s ease, box-shadow 0.2s ease',
    WebkitTapHighlightColor: 'transparent',
    position: 'relative',
    zIndex: 1,
  },
  recordingRipple: {
    position: 'absolute',
    width: 92, height: 92, borderRadius: 46,
    border: '2px solid rgba(212,96,92,0.4)',
    animation: 'ripple 1.4s ease-out infinite',
    pointerEvents: 'none',
    zIndex: 0,
  },
  petalLabel: {
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted, #B5AFA8)',
    letterSpacing: '0.02em', textTransform: 'uppercase',
  },
  interimBar: {
    padding: '6px 12px', marginBottom: 8, borderRadius: 10,
    background: 'var(--accent-light)', fontSize: 13,
    color: 'var(--text-secondary)', fontStyle: 'italic',
  },
  interimText: { opacity: 0.8 },
  recordingBar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px', marginTop: 8, borderRadius: 10,
    background: 'var(--danger-bg)',
  },
  recordingDot: {
    width: 8, height: 8, borderRadius: 4, background: 'var(--danger)',
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
